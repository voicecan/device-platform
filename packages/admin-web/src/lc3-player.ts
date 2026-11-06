import { LC3Decoder } from '@caitun/lc3';
import wasmUrl from '@caitun/lc3/wasm/lc3-wasm.wasm?url';
import { parseLc3Header, type Lc3Header } from './lc3-format.js';

const BATCH_FRAMES = 10;
const MAX_LEAD_SECONDS = 0.75;

export type Lc3PlayerSnapshot = {
  playing: boolean;
  loading: boolean;
  position: number;
  duration: number;
  error: string;
};

type Listener = (snapshot: Lc3PlayerSnapshot) => void;

function contentPath(fileId: string): string {
  return `/api/v1/files/${encodeURIComponent(fileId)}/content`;
}

function parseContentRange(value: string | null): number | null {
  const match = value ? /^bytes\s+\d+-\d+\/(\d+)$/i.exec(value.trim()) : null;
  return match ? Number(match[1]) : null;
}

export async function fetchLc3Header(fileId: string, signal?: AbortSignal): Promise<Lc3Header> {
  const response = await fetch(contentPath(fileId), {
    headers: { accept: 'application/octet-stream', range: 'bytes=0-255' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Authentication required.' : `Audio request failed (HTTP ${response.status}).`);
  if (response.status !== 206) throw new Error('Audio range requests are not supported.');
  const fileSize = parseContentRange(response.headers.get('content-range'));
  if (!fileSize) throw new Error('Audio size is unavailable.');
  return parseLc3Header(new Uint8Array(await response.arrayBuffer()), fileSize);
}

class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #offset = 0;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async readExact(length: number): Promise<Uint8Array | null> {
    const output = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (this.#chunks.length === 0) {
        const { value, done } = await this.#reader.read();
        if (done) return null;
        if (value?.byteLength) this.#chunks.push(value);
        continue;
      }
      const chunk = this.#chunks[0]!;
      const available = Math.min(length - filled, chunk.byteLength - this.#offset);
      output.set(chunk.subarray(this.#offset, this.#offset + available), filled);
      filled += available;
      this.#offset += available;
      if (this.#offset >= chunk.byteLength) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    return output;
  }

  async cancel(): Promise<void> {
    try { await this.#reader.cancel(); } catch { /* the stream may already be closed */ }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = globalThis.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { globalThis.clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Audio playback failed.';
}

export class Lc3RecordingPlayer {
  readonly #fileId: string;
  readonly #listeners = new Set<Listener>();
  #snapshot: Lc3PlayerSnapshot = { playing: false, loading: false, position: 0, duration: 0, error: '' };
  #header: Lc3Header | null = null;
  #context: AudioContext | null = null;
  #decoders: LC3Decoder[] | null = null;
  #abort: AbortController | null = null;
  #sources = new Set<AudioBufferSourceNode>();
  #ticker: ReturnType<typeof globalThis.setInterval> | null = null;
  #generation = 0;
  #position = 0;
  #positionAtStart = 0;
  #playbackStartContextTime = 0;
  #nextStartTime = 0;
  #streamEnded = false;
  #closed = false;

  constructor(fileId: string) {
    this.#fileId = fileId;
  }

  get snapshot(): Lc3PlayerSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  #emit(patch: Partial<Lc3PlayerSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  #currentPosition(): number {
    if (!this.#context || !this.#snapshot.playing || this.#playbackStartContextTime <= 0) return this.#position;
    const elapsed = Math.max(0, this.#context.currentTime - this.#playbackStartContextTime);
    return Math.min(this.#snapshot.duration, this.#positionAtStart + elapsed);
  }

  async #ensureContext(): Promise<AudioContext> {
    if (!this.#context) {
      const Context = globalThis.AudioContext;
      if (!Context) throw new Error('Web Audio is unavailable in this browser.');
      this.#context = new Context();
    }
    if (this.#context.state === 'suspended') await this.#context.resume();
    if (this.#context.state !== 'running') throw new Error('Audio playback requires a user gesture.');
    return this.#context;
  }

  async #ensureDecoders(header: Lc3Header): Promise<LC3Decoder[]> {
    if (this.#decoders) return this.#decoders;
    this.#decoders = await Promise.all(Array.from({ length: header.channels }, () => LC3Decoder.create({
      sampleRate: header.sampleRate,
      frameDurationUs: header.frameDurationUs,
      bitrate: header.bitrate / header.channels,
      frameBytes: header.frameBytes,
      locateFile: () => wasmUrl,
    })));
    return this.#decoders;
  }
  async prepare(): Promise<void> {
    if (this.#closed || this.#header) return;
    try {
      const header = await fetchLc3Header(this.#fileId);
      if (!this.#closed && !this.#header) {
        this.#header = header;
        this.#emit({ duration: header.durationSeconds });
      }
    } catch { /* play will surface the actionable error */ }
  }

  async play(): Promise<void> {
    if (this.#closed || this.#snapshot.playing || this.#snapshot.loading) return;
    if (this.#snapshot.error) this.#emit({ error: '' });
    this.#emit({ loading: true });
    try {
      const context = await this.#ensureContext();
      if (!this.#header) this.#header = await fetchLc3Header(this.#fileId, this.#abort?.signal);
      const header = this.#header;
      const decoders = await this.#ensureDecoders(header);
      if (this.#closed) return;
      const duration = header.durationSeconds;
      if (this.#position >= duration - 1e-3) this.#position = 0;
      const frameDurationSeconds = header.frameDurationUs / 1_000_000;
      const startFrame = Math.min(header.frameCount, Math.floor(this.#position / frameDurationSeconds));
      this.#position = startFrame * frameDurationSeconds;
      this.#positionAtStart = this.#position;
      this.#playbackStartContextTime = 0;
      this.#nextStartTime = 0;
      this.#streamEnded = false;
      this.#abort = new AbortController();
      const generation = ++this.#generation;
      this.#emit({ playing: true, loading: false, duration, position: this.#position, error: '' });
      this.#startTicker();
      void this.#stream(generation, startFrame, decoders, context).catch((cause) => {
        if (this.#closed || generation !== this.#generation || this.#abort?.signal.aborted) return;
        this.#fail(errorMessage(cause));
      });
    } catch (cause) {
      if (!this.#closed) this.#fail(errorMessage(cause));
    }
  }

  pause(): void {
    if (!this.#snapshot.playing) return;
    this.#position = this.#currentPosition();
    this.#stopPlayback();
    this.#emit({ playing: false, loading: false, position: this.#position });
  }

  seek(seconds: number): void {
    const duration = this.#snapshot.duration;
    if (!Number.isFinite(seconds) || duration <= 0) return;
    const next = Math.max(0, Math.min(duration, seconds));
    if (this.#snapshot.playing) {
      this.#stopPlayback();
      this.#position = next;
      this.#emit({ playing: false, loading: false, position: next });
      void this.play();
      return;
    }
    this.#position = next;
    this.#emit({ position: next });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopPlayback();
    for (const decoder of this.#decoders ?? []) decoder.close();
    this.#decoders = null;
    if (this.#context) {
      try { await this.#context.close(); } catch { /* already closed */ }
      this.#context = null;
    }
    this.#listeners.clear();
  }

  #startTicker(): void {
    if (this.#ticker) globalThis.clearInterval(this.#ticker);
    this.#ticker = globalThis.setInterval(() => {
      if (!this.#snapshot.playing) return;
      const position = this.#currentPosition();
      if (Math.abs(position - this.#snapshot.position) >= 0.2) this.#emit({ position });
      if (this.#streamEnded && this.#playbackStartContextTime > 0 && this.#context && this.#context.currentTime >= this.#nextStartTime - 0.02) {
        this.#position = this.#snapshot.duration;
        this.#stopPlayback();
        this.#emit({ playing: false, loading: false, position: this.#position });
      }
    }, 250);
  }

  #stopPlayback(): void {
    ++this.#generation;
    this.#abort?.abort();
    this.#abort = null;
    if (this.#ticker) { globalThis.clearInterval(this.#ticker); this.#ticker = null; }
    for (const source of this.#sources) {
      try { source.stop(); } catch { /* source may have ended */ }
    }
    this.#sources.clear();
    this.#playbackStartContextTime = 0;
    this.#nextStartTime = 0;
    this.#streamEnded = false;
  }

  #fail(message: string): void {
    this.#position = this.#currentPosition();
    this.#stopPlayback();
    this.#emit({ playing: false, loading: false, position: this.#position, error: message });
  }

  async #stream(generation: number, startFrame: number, decoders: LC3Decoder[], context: AudioContext): Promise<void> {
    const header = this.#header;
    const signal = this.#abort?.signal;
    if (!header || !signal) return;
    const offset = header.dataOffset + startFrame * (header.blockBytes + 2);
    const response = await fetch(contentPath(this.#fileId), {
      headers: { accept: 'application/octet-stream', range: `bytes=${offset}-` },
      signal,
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Authentication required.' : `Audio request failed (HTTP ${response.status}).`);
    if (response.status !== 206 || !response.body) throw new Error('Audio range requests are not supported.');
    const reader = new ByteReader(response.body.getReader());
    let index = startFrame;
    let batch: Float32Array[][] = [];
    try {
      while (index < header.frameCount) {
        const lengthBytes = await reader.readExact(2);
        if (!lengthBytes) break;
        const blockLength = lengthBytes[0]! | (lengthBytes[1]! << 8);
        if (blockLength === 0) break;
        if (blockLength < header.frameBytes * header.channels) throw new Error('LC3 frame is truncated.');
        const block = await reader.readExact(blockLength);
        if (!block) break;
        const frame = Array.from({ length: header.channels }, (_, channel) => decoders[channel]!.decode(block.subarray(channel * header.frameBytes, (channel + 1) * header.frameBytes)));
        batch.push(frame);
        index += 1;
        if (batch.length >= BATCH_FRAMES || index >= header.frameCount) {
          await this.#scheduleBatch(generation, batch, header, context);
          batch = [];
          if (this.#nextStartTime - context.currentTime > MAX_LEAD_SECONDS) await abortableDelay(100, signal);
        }
        if (generation !== this.#generation) return;
      }
      if (batch.length > 0) await this.#scheduleBatch(generation, batch, header, context);
      this.#streamEnded = true;
      if (this.#nextStartTime === 0) this.#finishEmpty();
    } finally {
      await reader.cancel();
    }
  }

  #finishEmpty(): void {
    this.#position = 0;
    this.#stopPlayback();
    this.#emit({ playing: false, loading: false, position: 0 });
  }

  async #scheduleBatch(generation: number, batch: Float32Array[][], header: Lc3Header, context: AudioContext): Promise<void> {
    if (generation !== this.#generation || this.#closed || batch.length === 0) return;
    const length = batch.length * header.frameSamples;
    const buffer = context.createBuffer(header.channels, length, header.sampleRate);
    for (let channel = 0; channel < header.channels; channel += 1) {
      const samples = new Float32Array(length);
      let offset = 0;
      for (const frame of batch) {
        samples.set(frame[channel]!, offset);
        offset += frame[channel]!.length;
      }
      buffer.copyToChannel(samples, channel);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = this.#nextStartTime > context.currentTime
      ? this.#nextStartTime
      : context.currentTime + 0.05;
    if (this.#playbackStartContextTime === 0) {
      this.#playbackStartContextTime = startAt;
      this.#positionAtStart = this.#position;
    }
    source.onended = () => this.#sources.delete(source);
    this.#sources.add(source);
    source.start(startAt);
    this.#nextStartTime = startAt + buffer.duration;
  }
}
