export type OutputMode = 'text' | 'json';

export type NextAction = {
  type: 'command' | 'open_url' | 'user_input';
  label: string;
  command?: string;
  url?: string;
  requires_user: boolean;
};

export type CliSuccess = {
  schema_version: 1;
  ok: true;
  command: string;
  profile: string;
  data: unknown;
  warnings: string[];
  next_actions: NextAction[];
};

export type CliFailure = {
  schema_version: 1;
  ok: false;
  command: string;
  profile: string;
  error: { code: string; message: string; details?: unknown };
  next_actions: NextAction[];
};

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 10,
    readonly details?: unknown,
    readonly nextActions: NextAction[] = [],
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function outputMode(args: readonly string[]): OutputMode {
  const index = args.indexOf('--output');
  const requested = index >= 0 ? args[index + 1] : process.env.VOICECAN_OUTPUT;
  if (requested === undefined || requested === 'text') return 'text';
  if (requested === 'json') return 'json';
  throw new CliError('INVALID_OUTPUT_MODE', '--output must be text or json', 3);
}

export function writeSuccess(input: Omit<CliSuccess, 'schema_version' | 'ok'>, mode: OutputMode, textValue?: string): void {
  if (mode === 'json') {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, ok: true, ...input } satisfies CliSuccess)}\n`);
    return;
  }
  if (textValue !== undefined) process.stdout.write(textValue.endsWith('\n') ? textValue : `${textValue}\n`);
}

export function writeFailure(error: unknown, command: string, profile: string, mode: OutputMode): number {
  const cliError = error instanceof CliError
    ? error
    : new CliError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), 10);
  if (mode === 'json') {
    const payload: CliFailure = {
      schema_version: 1,
      ok: false,
      command,
      profile,
      error: { code: cliError.code, message: cliError.message, ...(cliError.details === undefined ? {} : { details: cliError.details }) },
      next_actions: cliError.nextActions,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`${cliError.code}: ${cliError.message}\n`);
  }
  return cliError.exitCode;
}

export function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new CliError('MISSING_FLAG_VALUE', `${name} requires a value`, 3);
  return value;
}

export function hasFlag(args: readonly string[], name: string): boolean { return args.includes(name); }

export const CLI_CAPABILITIES = [
  { name: 'onboard', risk: 'safe_write', supports_json: true, supports_dry_run: true, requires_service: false },
  { name: 'init', risk: 'safe_write', supports_json: true, supports_dry_run: true, requires_service: false },
  { name: 'serve', risk: 'safe_write', supports_json: false, supports_dry_run: false, requires_service: false },
  { name: 'service.install', risk: 'safe_write', supports_json: true, supports_dry_run: true, requires_service: false },
  { name: 'service.start', risk: 'safe_write', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'service.stop', risk: 'safe_write', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'service.restart', risk: 'safe_write', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'service.status', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'service.logs', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'service.uninstall', risk: 'dangerous', supports_json: true, supports_dry_run: true, requires_service: false },
  { name: 'config.get', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'config.set', risk: 'safe_write', supports_json: true, supports_dry_run: true, requires_service: false },
  { name: 'config.list', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'config.path', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'config.validate', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'config.unset', risk: 'safe_write', supports_json: true, supports_dry_run: true, requires_service: false },
  { name: 'doctor', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: true },
  { name: 'device.bind.prepare', risk: 'user_action', supports_json: true, supports_dry_run: true, requires_service: true },
  { name: 'device.bind.status', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: true },
  { name: 'device.bind.wait', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: true },
  { name: 'device.list', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: true },
  { name: 'device.get', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: true },
  { name: 'device.status', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: true },
  { name: 'device.sync', risk: 'safe_write', supports_json: true, supports_dry_run: false, requires_service: true },
  { name: 'app.create', risk: 'safe_write', supports_json: true, supports_dry_run: true, requires_service: true },
  { name: 'app.list', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: true },
  { name: 'app.credential.create', risk: 'secret_write', supports_json: true, supports_dry_run: true, requires_service: true },
  { name: 'mcp.print-config', risk: 'read', supports_json: true, supports_dry_run: false, requires_service: false },
  { name: 'mcp.connect', risk: 'secret_write', supports_json: true, supports_dry_run: true, requires_service: true },
  { name: 'mcp.run', risk: 'read', supports_json: false, supports_dry_run: false, requires_service: true },
  { name: 'admin-mcp.stdio', risk: 'safe_write', supports_json: false, supports_dry_run: false, requires_service: true },
] as const;
