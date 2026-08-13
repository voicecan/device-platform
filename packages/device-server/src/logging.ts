import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import type { ServerConfig } from './config.js';

export const LOG_REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie',
  'body.password', 'body.current_password', 'body.new_password', 'body.setup_token',
  'body.provisioning_token', 'body.transfer_token', 'body.continuation_token',
  'body.device_token', 'body.secret', 'body.token', 'body.client_secret',
  'res.headers.set-cookie', 'res.headers.location',
] as const;

export class RollingFileStream extends Writable {
  readonly path: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  #size = 0;
  #ready: Promise<void>;

  constructor(path: string, maxBytes: number, maxFiles: number) {
    super({ decodeStrings: true });
    this.path = path;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.#ready = this.#initialize();
  }

  async #initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try { this.#size = (await stat(this.path)).size; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }

  async #moveIfPresent(source: string, destination: string): Promise<void> {
    try { await rename(source, destination); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }

  async #rotate(): Promise<void> {
    const rotatedFiles = Math.max(0, this.maxFiles - 1);
    if (rotatedFiles === 0) await rm(this.path, { force: true });
    else {
      await rm(`${this.path}.${rotatedFiles}`, { force: true });
      for (let index = rotatedFiles - 1; index >= 1; index -= 1) await this.#moveIfPresent(`${this.path}.${index}`, `${this.path}.${index + 1}`);
      await this.#moveIfPresent(this.path, `${this.path}.1`);
    }
    this.#size = 0;
  }

  async #append(chunk: Buffer): Promise<void> {
    await this.#ready;
    if (this.#size > 0 && this.#size + chunk.byteLength > this.maxBytes) await this.#rotate();
    await appendFile(this.path, chunk, { mode: 0o600, flag: 'a' });
    this.#size += chunk.byteLength;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    void this.#append(bytes).then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }
}

export function consoleLogLevel(configuredLevel: string): string {
  if (configuredLevel === 'silent' || configuredLevel === 'fatal' || configuredLevel === 'error' || configuredLevel === 'warn') return configuredLevel;
  return 'warn';
}

export function createServerLogger(config: ServerConfig): Logger {
  const options = { level: config.logLevel, redact: [...LOG_REDACT_PATHS] };
  const stdoutLevel = consoleLogLevel(config.logLevel);
  if (!config.logFileEnabled || config.logLevel === 'silent') return pino({ ...options, level: stdoutLevel });
  const rolling = new RollingFileStream(`${config.logDirectory}/device-server.log`, config.logMaxBytes, config.logMaxFiles);
  rolling.on('error', (error) => process.stderr.write(`Device Server log file error: ${error.message}\n`));
  return pino(options, pino.multistream([{ level: stdoutLevel, stream: process.stdout }, { level: config.logLevel, stream: rolling }]));
}
