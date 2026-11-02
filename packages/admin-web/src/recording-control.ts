import type { DeviceControl } from '@voicecan/device-connect-web';

export type RecordingControlCommand = { id: string; status: string; error_code: string | null };

export function recordingModeControl(mode: 'smart_capture' | 'lookback', status: { microphone_mode: number | null; microphone_gain_db: number | null }): DeviceControl {
  const microphoneMode = status.microphone_mode;
  const microphoneGainDb = status.microphone_gain_db;
  if (microphoneMode === null || ![0, 1, 2].includes(microphoneMode) ||
      microphoneGainDb === null || !Number.isInteger(microphoneGainDb) || microphoneGainDb < 0 || microphoneGainDb > 31) throw new Error('RECORDING_SETTINGS_UNAVAILABLE');
  return { kind: 'recording_mode', mode, microphoneMode: microphoneMode as 0 | 1 | 2, microphoneGainDb };
}

export function recordingResultMessage(code: string, modeChange = false): string {
  if (modeChange && code === 'DEVICE_RESULT_02') return 'Recording mode failed: noise reduction is unsupported.';
  if (modeChange && code === 'DEVICE_RESULT_01') return 'The device rejected the recording mode change.';
  const messages: Record<string, string> = {
    DEVICE_RESULT_01: 'Recording failed: device storage is full.',
    DEVICE_RESULT_02: 'Recording failed: the device is in USB disk mode.',
    DEVICE_RESULT_03: 'Recording failed: device hardware error.',
    DEVICE_RESULT_04: 'The device is already recording.',
    DEVICE_RESULT_05: 'Recording controls were used too frequently. Try again shortly.',
    RECORDING_SETTINGS_UNAVAILABLE: 'Refresh the device status before changing recording mode.',
    DEVICE_COMMAND_TIMEOUT: 'The device did not confirm the recording command in time.',
    RECORDING_COMMAND_PENDING: 'The recording command is still pending. Check command history before retrying.',
  };
  return messages[code] ?? code;
}

export async function waitForRecordingCommand(
  initial: RecordingControlCommand,
  read: (id: string) => Promise<RecordingControlCommand>,
  signal: AbortSignal,
  options: { timeoutMs?: number; pause?: () => Promise<void>; now?: () => number } = {},
): Promise<RecordingControlCommand> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 130_000);
  const pause = options.pause ?? (() => new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 400);
    signal.addEventListener('abort', abort, { once: true });
  }));
  let command = initial;
  while (true) {
    signal.throwIfAborted();
    if (command.status === 'succeeded') return command;
    if (['failed', 'expired'].includes(command.status)) throw new Error(command.error_code ?? 'DEVICE_COMMAND_TIMEOUT');
    if (now() >= deadline) throw new Error('RECORDING_COMMAND_PENDING');
    await pause();
    signal.throwIfAborted();
    command = await read(command.id);
  }
}
