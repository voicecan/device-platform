import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DeviceEvent } from '@voicecan/contracts';
import { ConnectorRuntime, FileDeliveryLedger, startConnectorWebhookServer, type ConnectorTarget } from '@voicecan/connector-runtime';
import { VoicecanDeviceServer } from '@voicecan/server-client';

export function createVoiceWorklogTarget(input: { directory: string; download: (fileId: string, destination: string) => Promise<void> }): ConnectorTarget {
  const directory = resolve(input.directory);
  return {
    id: 'voice-worklog',
    deliver: async (event: DeviceEvent) => {
      if (event.type !== 'file.synced' || typeof event.data.file_id !== 'string') return;
      const attachmentDir = resolve(directory, 'attachments');
      const entryDir = resolve(directory, 'entries');
      await Promise.all([mkdir(attachmentDir, { recursive: true }), mkdir(entryDir, { recursive: true })]);
      const media = typeof event.data.media === 'object' && event.data.media ? event.data.media as Record<string, unknown> : {};
      const extension = typeof media.filename_extension === 'string' && /^[a-z0-9]+$/i.test(media.filename_extension) ? media.filename_extension : 'bin';
      const attachment = resolve(attachmentDir, `${event.id}.${extension}`);
      const temporary = `${attachment}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try { await input.download(event.data.file_id, temporary); await rename(temporary, attachment); }
      catch (error) {
        await unlink(temporary).catch(() => undefined);
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      const entry = resolve(entryDir, `${event.id}.md`);
      const markdown = `# Voice worklog\n\n- Event: ${event.id}\n- Recorded: ${event.created_at}\n- File: ${event.data.file_id}\n- Attachment: ${attachment}\n`;
      await writeFile(entry, markdown, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      return { reference: entry };
    },
  };
}

export async function main(): Promise<void> {
  const serverUrl = process.env.VOICECAN_DEVICE_SERVER_URL;
  const applicationToken = process.env.VOICECAN_APPLICATION_TOKEN;
  const secret = process.env.VOICECAN_DEVICE_EVENT_SECRET;
  if (!serverUrl || !applicationToken || !secret) throw new Error('VOICECAN_DEVICE_SERVER_URL, VOICECAN_APPLICATION_TOKEN and VOICECAN_DEVICE_EVENT_SECRET are required');
  const directory = resolve(process.env.VOICE_WORKLOG_DATA_DIR ?? './voice-worklog-data');
  const client = new VoicecanDeviceServer({ baseUrl: serverUrl, applicationToken });
  const runtime = new ConnectorRuntime({ ledger: new FileDeliveryLedger(resolve(directory, 'ledger')), targets: [createVoiceWorklogTarget({ directory, download: (id, destination) => client.recordings.downloadToFile(id, destination) })] });
  startConnectorWebhookServer({ runtime, secret, port: Number(process.env.PORT ?? 8792) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
