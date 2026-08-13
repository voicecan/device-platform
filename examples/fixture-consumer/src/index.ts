import { createServer } from 'node:http';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VoicecanDeviceServer, verifyEventSignature } from '@voicecan/server-client';

const port = Number(process.env.PORT ?? 8790);
const dataDir = resolve(process.env.DATA_DIR ?? './consumer-data');
const eventSecret = process.env.VOICECAN_DEVICE_EVENT_SECRET;
const applicationToken = process.env.VOICECAN_APPLICATION_TOKEN;
const serverUrl = process.env.VOICECAN_DEVICE_SERVER_URL;
if (!eventSecret || !applicationToken || !serverUrl) throw new Error('VOICECAN_DEVICE_EVENT_SECRET, VOICECAN_APPLICATION_TOKEN and VOICECAN_DEVICE_SERVER_URL are required');

const client = new VoicecanDeviceServer({ baseUrl: serverUrl, applicationToken });
await mkdir(dataDir, { recursive: true });

createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/events') { response.writeHead(404).end(); return; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 256 * 1024) { response.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
  const rawBody = Buffer.concat(chunks);
  const valid = verifyEventSignature({
    rawBody,
    timestamp: String(request.headers['voicecan-timestamp'] ?? ''),
    deliveryId: String(request.headers['voicecan-delivery-id'] ?? ''),
    signature: String(request.headers['voicecan-signature'] ?? ''),
    secret: eventSecret,
  });
  if (!valid) { response.writeHead(401).end(); return; }
  const event = JSON.parse(rawBody.toString()) as { id: string; type: string; data: { file_id?: string; media?: { filename_extension?: string } } };
  if (event.type === 'file.synced' && event.data.file_id) {
    const ledger = await open(resolve(dataDir, `${event.id}.processed`), 'wx').catch((error: NodeJS.ErrnoException) => error.code === 'EEXIST' ? null : Promise.reject(error));
    if (ledger) {
      const extension = event.data.media?.filename_extension && /^[a-z0-9]+$/i.test(event.data.media.filename_extension) ? event.data.media.filename_extension : 'bin';
      try { await client.recordings.downloadToFile(event.data.file_id, resolve(dataDir, `${event.data.file_id}.${extension}`)); await ledger.writeFile('ok\n'); }
      catch (error) { await ledger.close(); throw error; }
      await ledger.close();
    }
  }
  response.writeHead(204).end();
}).listen(port, '127.0.0.1', () => process.stdout.write(`Fixture consumer listening on http://127.0.0.1:${port}/events\n`));
