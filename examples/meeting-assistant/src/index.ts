import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DeviceEvent } from '@voicecan/contracts';
import { ConnectorRuntime, FileDeliveryLedger, startConnectorWebhookServer, type ConnectorTarget } from '@voicecan/connector-runtime';
import { VoicecanDeviceServer } from '@voicecan/server-client';

type Downloader = (fileId: string, destination: string) => Promise<void>;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export function createMeetingAssistantTarget(input: { directory: string; download: Downloader }): ConnectorTarget {
  const directory = resolve(input.directory);
  return {
    id: 'meeting-assistant',
    deliver: async (event: DeviceEvent) => {
      if (event.type !== 'file.synced' || typeof event.data.file_id !== 'string') return;
      const audioDir = resolve(directory, 'audio');
      const queueDir = resolve(directory, 'queue');
      await Promise.all([mkdir(audioDir, { recursive: true }), mkdir(queueDir, { recursive: true })]);
      const media = typeof event.data.media === 'object' && event.data.media ? event.data.media as Record<string, unknown> : {};
      const extension = typeof media.filename_extension === 'string' && /^[a-z0-9]+$/i.test(media.filename_extension) ? media.filename_extension : 'bin';
      const audio = resolve(audioDir, `${event.id}.${extension}`);
      if (!(await exists(audio))) {
        const temporary = `${audio}.tmp-${process.pid}-${crypto.randomUUID()}`;
        try { await input.download(event.data.file_id, temporary); await rename(temporary, audio); }
        catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
      }
      const job = resolve(queueDir, `${event.id}.json`);
      await writeFile(job, `${JSON.stringify({ event_id: event.id, file_id: event.data.file_id, audio, state: 'queued', created_at: event.created_at }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      return { reference: job };
    },
  };
}

export async function main(): Promise<void> {
  const serverUrl = process.env.VOICECAN_DEVICE_SERVER_URL;
  const applicationToken = process.env.VOICECAN_APPLICATION_TOKEN;
  const secret = process.env.VOICECAN_DEVICE_EVENT_SECRET;
  if (!serverUrl || !applicationToken || !secret) throw new Error('VOICECAN_DEVICE_SERVER_URL, VOICECAN_APPLICATION_TOKEN and VOICECAN_DEVICE_EVENT_SECRET are required');
  const directory = resolve(process.env.MEETING_ASSISTANT_DATA_DIR ?? './meeting-assistant-data');
  const client = new VoicecanDeviceServer({ baseUrl: serverUrl, applicationToken });
  const runtime = new ConnectorRuntime({ ledger: new FileDeliveryLedger(resolve(directory, 'ledger')), targets: [createMeetingAssistantTarget({ directory, download: (id, destination) => client.recordings.downloadToFile(id, destination) })] });
  startConnectorWebhookServer({ runtime, secret, port: Number(process.env.PORT ?? 8791) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
