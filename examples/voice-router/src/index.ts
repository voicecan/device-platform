import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DeviceEvent } from '@voicecan/contracts';
import { ConnectorRuntime, FileDeliveryLedger, startConnectorWebhookServer, type ConnectorTarget } from '@voicecan/connector-runtime';
import { VoicecanDeviceServer } from '@voicecan/server-client';

export function createVoiceRouterTarget(input: { directory: string; routes: Readonly<Record<number, string>>; download: (fileId: string, destination: string) => Promise<void> }): ConnectorTarget {
  const directory = resolve(input.directory);
  return {
    id: 'voice-router',
    deliver: async (event: DeviceEvent) => {
      if (event.type !== 'file.synced' || typeof event.data.file_id !== 'string') return;
      const attribute = typeof event.data.attribute === 'number' ? event.data.attribute : -1;
      const route = input.routes[attribute] ?? 'unclassified';
      const routeDir = resolve(directory, route);
      await mkdir(routeDir, { recursive: true });
      const media = typeof event.data.media === 'object' && event.data.media ? event.data.media as Record<string, unknown> : {};
      const extension = typeof media.filename_extension === 'string' && /^[a-z0-9]+$/i.test(media.filename_extension) ? media.filename_extension : 'bin';
      const destination = resolve(routeDir, `${event.id}.${extension}`);
      const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try { await input.download(event.data.file_id, temporary); await rename(temporary, destination); }
      catch (error) {
        await unlink(temporary).catch(() => undefined);
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      const receipt = resolve(routeDir, `${event.id}.json`);
      await writeFile(receipt, `${JSON.stringify({ event_id: event.id, file_id: event.data.file_id, attribute, route, destination }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      return { reference: receipt };
    },
  };
}

export async function main(): Promise<void> {
  const serverUrl = process.env.VOICECAN_DEVICE_SERVER_URL;
  const applicationToken = process.env.VOICECAN_APPLICATION_TOKEN;
  const secret = process.env.VOICECAN_DEVICE_EVENT_SECRET;
  if (!serverUrl || !applicationToken || !secret) throw new Error('VOICECAN_DEVICE_SERVER_URL, VOICECAN_APPLICATION_TOKEN and VOICECAN_DEVICE_EVENT_SECRET are required');
  const directory = resolve(process.env.VOICE_ROUTER_DATA_DIR ?? './voice-router-data');
  const client = new VoicecanDeviceServer({ baseUrl: serverUrl, applicationToken });
  const target = createVoiceRouterTarget({ directory, routes: { 0: 'voice', 1: 'meeting', 2: 'memo' }, download: (id, destination) => client.recordings.downloadToFile(id, destination) });
  const runtime = new ConnectorRuntime({ ledger: new FileDeliveryLedger(resolve(directory, 'ledger')), targets: [target] });
  startConnectorWebhookServer({ runtime, secret, port: Number(process.env.PORT ?? 8793) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
