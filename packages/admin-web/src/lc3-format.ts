export type Lc3Header = {
  sampleRate: number;
  channels: number;
  bitrate: number;
  frameDurationUs: number;
  frameSamples: number;
  frameBytes: number;
  blockBytes: number;
  frameCount: number;
  totalSamples: number;
  durationSeconds: number;
  dataOffset: number;
  fileSize: number;
};

const LC3_FILE_ID = 0xCC1C;
const HEADER_BASE_BYTES = 18;

export function parseLc3Header(bytes: Uint8Array, fileSize: number): Lc3Header {
  if (bytes.byteLength < HEADER_BASE_BYTES) throw new Error('LC3 header is incomplete.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== LC3_FILE_ID) throw new Error('Not a Voicecan LC3 recording.');
  const headerSize = view.getUint16(2, true);
  if (headerSize < HEADER_BASE_BYTES || headerSize > bytes.byteLength) throw new Error('LC3 header size is invalid.');
  if (view.getUint16(12, true) !== 0) throw new Error('LC3 epmode is not supported.');
  const sampleRate = view.getUint16(4, true) * 100;
  const bitrate = view.getUint16(6, true) * 100;
  const channels = view.getUint16(8, true);
  const frameDurationUs = view.getUint16(10, true) * 10;
  const hrmode = headerSize >= HEADER_BASE_BYTES + 2 && view.getUint16(HEADER_BASE_BYTES, true) !== 0;
  if (hrmode) throw new Error('LC3 high-resolution mode is not supported by this player.');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('LC3 sample rate is invalid.');
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) throw new Error('Only mono and stereo LC3 recordings are supported.');
  if (![7500, 10000].includes(frameDurationUs)) throw new Error('LC3 frame duration is not supported.');
  if (!Number.isInteger(bitrate) || bitrate <= 0) throw new Error('LC3 bitrate is invalid.');
  const frameSamples = Math.round(sampleRate * frameDurationUs / 1_000_000);
  const blockBytes = Math.floor(bitrate * frameDurationUs / 8_000_000);
  if (frameSamples <= 0 || blockBytes <= 0 || blockBytes % channels !== 0) throw new Error('LC3 frame parameters are invalid.');
  const frameBytes = blockBytes / channels;
  if (frameBytes > 400) throw new Error('LC3 frame is too large.');
  const declaredSamples = view.getUint16(14, true) | (view.getUint16(16, true) << 16);
  const totalSamples = declaredSamples > 0
    ? declaredSamples
    : Math.max(0, Math.floor((fileSize - headerSize) / (blockBytes + 2)) * frameSamples);
  const frameCount = Math.ceil(totalSamples / frameSamples);
  if (fileSize < headerSize) throw new Error('LC3 recording is truncated.');
  return {
    sampleRate, channels, bitrate, frameDurationUs, frameSamples, frameBytes, blockBytes, frameCount,
    totalSamples, durationSeconds: totalSamples / sampleRate, dataOffset: headerSize, fileSize,
  };
}
