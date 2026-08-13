import type {
  CompatibilityReport,
  DeviceInfo,
  DeviceStatus,
  FileDescriptor,
  ProtocolTransport,
  ProtocolInteraction,
  SemanticProtocolFactory,
  SemanticProtocolSession,
  WifiConfiguration,
} from '@voicecan/device-core';

export type ProvisioningState =
  | 'unsupported' | 'idle' | 'selecting' | 'connecting' | 'inspecting'
  | 'claiming' | 'handshaking' | 'configuring' | 'configuring_network'
  | 'waiting_network' | 'configuring_server' | 'waiting_server'
  | 'releasing' | 'released' | 'ready' | 'degraded' | 'disconnected' | 'failed';

export type ProvisioningConnection = {
  deviceId: string;
  deviceInfo: DeviceInfo;
  deviceStatus: DeviceStatus;
  compatibility: CompatibilityReport;
};

export type ProvisioningResult = {
  deviceId: string;
  serverStatus: 'online' | 'timeout';
  deviceInfo: DeviceInfo;
  compatibility: CompatibilityReport;
};

export type ProvisioningBroker = {
  claim(input: { provisioningToken: string; serialNumber: string; manufacturer: string; bluetoothName?: string }): Promise<{
    provisioningSessionId: string;
    continuationToken: string;
    deviceId: string;
    rawToken: Uint8Array;
    wssUrl: string;
    recovered?: boolean;
  }>;
  reportProgress(input: { provisioningSessionId: string; continuationToken: string; stage: 'ble_authenticated' | 'configured' | 'failed'; failureCode?: string }): Promise<void>;
  waitForOnline(deviceId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  observeOnline?(deviceId: string, signal?: AbortSignal): Promise<boolean>;
};

export type TransferOutBroker = {
  claim(input: { transferToken: string; publicKeyJwk: JsonWebKey }): Promise<{
    transferSessionId: string;
    continuationToken: string;
    deviceId: string;
    manufacturer: string;
    serialNumber: string;
    sealedDeviceToken: string;
    algorithm: 'RSA-OAEP-256';
  }>;
  complete(input: { transferSessionId: string; continuationToken: string; serialNumber: string; result: 'ack' | 'failed'; failureCode?: string }): Promise<void>;
};

const provisioningOnlineTimeoutMs = 180_000;
const provisioningNetworkTimeoutMs = 180_000;
const provisioningNetworkPollMs = 2_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => { globalThis.clearTimeout(timer); reject(signal?.reason ?? new DOMException('Operation aborted', 'AbortError')); };
    const timer = globalThis.setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new DeviceSdkError('TRANSFER_TOKEN_ENVELOPE_INVALID', 'The sealed device token is not canonical Base64');
  const binary = atob(value); const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

type DeviceTransport = ProtocolTransport & { readonly deviceName?: string | undefined };

type DeviceSelectionState = Extract<ProvisioningState, 'connecting' | 'inspecting'>;
export type DeviceTransportFactory = { supported(): boolean; requestDevice(onStateChange?: (state: DeviceSelectionState) => void): Promise<DeviceTransport> };

type BluetoothValueEvent = Event & { target: { value?: DataView } | null };
type BluetoothUuid = string | number;
type BluetoothCharacteristic = EventTarget & {
  startNotifications(): Promise<BluetoothCharacteristic>;
  stopNotifications?(): Promise<BluetoothCharacteristic>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
};
type BluetoothService = { getCharacteristic(uuid: BluetoothUuid): Promise<BluetoothCharacteristic> };
type BluetoothGattServer = { connected?: boolean; connect(): Promise<BluetoothGattServer>; disconnect(): void; getPrimaryService(uuid: BluetoothUuid): Promise<BluetoothService> };
type BluetoothDeviceLike = EventTarget & { gatt?: BluetoothGattServer; id?: string; name?: string };
type BluetoothApi = { requestDevice(options: { filters: Array<{ namePrefix: string }>; optionalServices: BluetoothUuid[] }): Promise<BluetoothDeviceLike> };
type GattInitializationPhase = 'connecting' | 'stabilizing_connection' | 'discovering_service' | 'discovering_characteristics' | 'starting_notifications' | 'ready';

function bluetoothErrorMessage(message: string, cause: unknown): string {
  let detail: string;
  if (cause instanceof Error) {
    const causeMessage = cause.message.trim();
    detail = causeMessage ? `${cause.name}: ${causeMessage}` : cause.name;
  } else {
    detail = String(cause);
  }
  return detail && detail !== message ? `${message}\n${detail}` : message;
}

function sdkFailureCode(cause: unknown, fallback: string): string {
  if (cause instanceof DeviceSdkError) return cause.code;
  if (!(cause instanceof Error)) return fallback;
  return /^([A-Z][A-Z0-9_]{2,})(?::|\b)/.exec(cause.message.trim())?.[1] ?? fallback;
}

function provisioningFailureMessage(stage: ProvisioningState, cause: unknown): string {
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message.trim() || 'Unknown error'}` : String(cause);
  return `Device binding failed\nStage: ${stage}\n${detail}`;
}

function deviceDebug(event: string, details?: Readonly<Record<string, unknown>>): void {
  if (details) console.debug(`[Voicecan Device] ${event}`, details);
  else console.debug(`[Voicecan Device] ${event}`);
}

function disconnectBluetoothDevice(device: BluetoothDeviceLike): void {
  const connectedBefore = device.gatt?.connected ?? 'unknown';
  try {
    device.gatt?.disconnect?.();
    deviceDebug('GATT disconnect cleanup completed', { device_name: device.name ?? 'unknown', device_id: device.id ?? 'unavailable', connected_before: connectedBefore, connected_after: device.gatt?.connected ?? 'unknown' });
  } catch (error) {
    deviceDebug('GATT disconnect cleanup failed', { device_name: device.name ?? 'unknown', device_id: device.id ?? 'unavailable', connected_before: connectedBefore, ...bluetoothErrorDetails(error) });
  }
}

function connectionAlreadyInProgress(error: unknown): boolean {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return cause instanceof Error && cause.name === 'NetworkError' && /connection already in progress/i.test(cause.message);
}

function underlyingBluetoothError(error: unknown): Error | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (!(current.cause instanceof Error)) return current;
    current = current.cause;
  }
  return current instanceof Error ? current : undefined;
}

function connectionDropped(error: unknown): boolean {
  const cause = underlyingBluetoothError(error);
  return Boolean(cause && cause.name === 'NetworkError' && /(?:gatt server is disconnected|disconnected|not connected|reconnect first)/i.test(cause.message));
}

function gattServerDisconnected(server: BluetoothGattServer): boolean {
  return server.connected === false;
}

function bluetoothErrorDetails(error: unknown): Readonly<Record<string, unknown>> {
  const cause = underlyingBluetoothError(error);
  return cause ? { error_name: cause.name, error_message: cause.message } : { error: String(error) };
}

class WebBluetoothTransport implements ProtocolTransport {
  #pending: { exchangeId: number; notificationCount: number; frames: Uint8Array[]; current: Uint8Array; consume(frame: Uint8Array): Promise<ProtocolInteraction>; resolve(frames: Uint8Array[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  #nextExchangeId = 0;
  #closed = false;
  #receiveTail: Promise<void> = Promise.resolve();
  readonly #notificationListener = (event: Event) => {
    const view = (event as BluetoothValueEvent).target?.value;
    if (!view) { deviceDebug('BLE RX notification has no value', { exchange_id: this.#pending?.exchangeId ?? null, command_pending: Boolean(this.#pending) }); return; }
    const chunk = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    this.#receiveTail = this.#receiveTail.then(() => this.#onValue(chunk)).catch((error) => this.#fail(error instanceof Error ? error : new Error(String(error))));
  };
  readonly #disconnectListener = () => {
    deviceDebug('GATT disconnected after initialization', { device_name: this.device.name ?? 'unknown', device_id: this.device.id ?? 'unavailable', command_pending: Boolean(this.#pending) });
    this.#fail(new DeviceSdkError('DEVICE_DISCONNECTED', 'Bluetooth device disconnected'));
  };
  readonly deviceName: string | undefined;
  constructor(private readonly device: BluetoothDeviceLike, private readonly writer: BluetoothCharacteristic, private readonly reader: BluetoothCharacteristic, private readonly timeoutMs: number) {
    this.deviceName = device.name?.trim() || undefined;
    reader.addEventListener('characteristicvaluechanged', this.#notificationListener);
    device.addEventListener('gattserverdisconnected', this.#disconnectListener);
  }
  async #onValue(chunk: Uint8Array): Promise<void> {
    const pending = this.#pending;
    if (pending) pending.notificationCount += 1;
    deviceDebug('BLE RX frame', {
      exchange_id: pending?.exchangeId ?? null,
      frame_index: pending?.notificationCount ?? null,
      bytes: chunk.byteLength,
      command_pending: Boolean(pending),
    });
    if (!pending) return;
    try {
      const frame = new Uint8Array(pending.current.byteLength + chunk.byteLength); frame.set(pending.current); frame.set(chunk, pending.current.byteLength); pending.current = frame;
      const interaction = await pending.consume(frame);
      if (this.#pending !== pending) return;
      pending.frames.push(frame); pending.current = new Uint8Array();
      clearTimeout(pending.timer); pending.timer = setTimeout(() => this.#fail(new DeviceSdkError('COMMAND_TIMEOUT', 'Bluetooth command timed out')), this.timeoutMs);
      if (interaction.response) { deviceDebug('BLE TX interactive frame', { exchange_id: pending.exchangeId, bytes: interaction.response.byteLength }); await this.writer.writeValueWithoutResponse(Uint8Array.from(interaction.response).buffer); }
      deviceDebug('BLE RX protocol frame accepted', { exchange_id: pending.exchangeId, response_frame_index: pending.frames.length, bytes: frame.byteLength, response_complete: interaction.complete });
      if (interaction.complete) { this.#pending = null; clearTimeout(pending.timer); deviceDebug('BLE response completed', { exchange_id: pending.exchangeId, frames: pending.frames.length, notifications: pending.notificationCount, bytes: pending.frames.reduce((total, item) => total + item.byteLength, 0) }); pending.resolve(pending.frames); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/InvalidLength|TRUNCATED|TOO_SHORT|unexpected end/i.test(message)) {
        deviceDebug('BLE RX frame fragment buffered', { exchange_id: pending.exchangeId, notifications: pending.notificationCount, buffered_bytes: pending.current.byteLength });
        return;
      }
      this.#fail(error instanceof Error ? error : new Error(message));
    }
  }
  #fail(error: Error): void { if (!this.#pending) return; const pending = this.#pending; this.#pending = null; clearTimeout(pending.timer); deviceDebug('BLE exchange failed', { exchange_id: pending.exchangeId, received_frames: pending.frames.length, received_notifications: pending.notificationCount, buffered_bytes: pending.current.byteLength, ...bluetoothErrorDetails(error) }); pending.reject(error); }
  async collect(request: Uint8Array, complete: (response: Uint8Array) => boolean, signal?: AbortSignal): Promise<Uint8Array[]> {
    return this.interact(request, async (response) => ({ complete: complete(response) }), signal);
  }
  async interact(request: Uint8Array, consume: (response: Uint8Array) => ProtocolInteraction | Promise<ProtocolInteraction>, signal?: AbortSignal): Promise<Uint8Array[]> {
    if (this.#pending) throw new DeviceSdkError('COMMAND_PENDING', 'A Bluetooth command is already in flight');
    signal?.throwIfAborted();
    const exchangeId = ++this.#nextExchangeId;
    const result = new Promise<Uint8Array[]>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new DeviceSdkError('COMMAND_TIMEOUT', 'Bluetooth command timed out')), this.timeoutMs);
      this.#pending = { exchangeId, notificationCount: 0, frames: [], current: new Uint8Array(), consume: async (response) => consume(response), resolve, reject, timer };
      signal?.addEventListener('abort', () => this.#fail(new DeviceSdkError('COMMAND_ABORTED', 'Bluetooth command was aborted')), { once: true });
    });
    try {
      deviceDebug('BLE TX frame', { exchange_id: exchangeId, bytes: request.byteLength });
      await this.writer.writeValueWithoutResponse(Uint8Array.from(request).buffer);
      deviceDebug('BLE TX frame written', { exchange_id: exchangeId, bytes: request.byteLength });
    } catch (error) {
      deviceDebug('BLE TX frame write failed', { exchange_id: exchangeId, bytes: request.byteLength, ...bluetoothErrorDetails(error) });
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
    return result;
  }
  async exchange(request: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const frames = await this.collect(request, () => true, signal);
    return frames[0]!;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new DeviceSdkError('SESSION_CLOSED', 'Bluetooth session closed'));
    this.reader.removeEventListener('characteristicvaluechanged', this.#notificationListener);
    this.device.removeEventListener('gattserverdisconnected', this.#disconnectListener);
    try { await this.reader.stopNotifications?.(); } catch { /* the disconnect below is authoritative */ }
    disconnectBluetoothDevice(this.device);
    deviceDebug('BLE transport closed');
  }
}

export class WebBluetoothTransportFactory implements DeviceTransportFactory {
  #requestInProgress = false;
  constructor(private readonly options: { serviceUuid: BluetoothUuid; writeCharacteristicUuid: BluetoothUuid; notifyCharacteristicUuid: BluetoothUuid; namePrefix?: string; timeoutMs?: number; scanToConnectDelayMs?: number; postConnectDelayMs?: number; connectionRetryDelayMs?: number; notificationSetupTimeoutMs?: number }) {}
  supported(): boolean { return typeof navigator !== 'undefined' && Boolean((navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth); }
  async requestDevice(onStateChange?: (state: DeviceSelectionState) => void): Promise<DeviceTransport> {
    if (this.#requestInProgress) throw new DeviceSdkError('BLUETOOTH_CONNECTION_PENDING', 'A Bluetooth device connection is already in progress. Wait for it to finish before trying again.');
    this.#requestInProgress = true;
    try { return await this.#requestDevice(onStateChange); } finally { this.#requestInProgress = false; }
  }
  async #requestDevice(onStateChange?: (state: DeviceSelectionState) => void): Promise<DeviceTransport> {
    const bluetooth = (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
    if (!bluetooth) throw new DeviceSdkError('WEB_BLUETOOTH_UNSUPPORTED', 'Web Bluetooth is unavailable');
    let device: BluetoothDeviceLike;
    try {
      deviceDebug('Opening Bluetooth device chooser', { name_prefix: this.options.namePrefix ?? 'CAPSO-' });
      device = await bluetooth.requestDevice({ filters: [{ namePrefix: this.options.namePrefix ?? 'CAPSO-' }], optionalServices: [this.options.serviceUuid] });
      deviceDebug('Bluetooth device selected', { device_name: device.name ?? 'unknown', device_id: device.id ?? 'unavailable', gatt_available: Boolean(device.gatt), gatt_connected: device.gatt?.connected ?? 'unknown', service_uuid: String(this.options.serviceUuid) });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'NotFoundError') throw new DeviceSdkError('DEVICE_SELECTION_CANCELED', bluetoothErrorMessage('No Bluetooth device was selected. Choose a nearby device matching the configured prefix and try again.', cause), { cause });
      if (cause instanceof Error && cause.name === 'NotAllowedError') throw new DeviceSdkError('BLUETOOTH_PERMISSION_DENIED', bluetoothErrorMessage('Bluetooth permission was denied by the browser or operating system.', cause), { cause });
      if (cause instanceof Error && cause.name === 'SecurityError') throw new DeviceSdkError('BLUETOOTH_SECURITY_BLOCKED', bluetoothErrorMessage('The browser security policy blocked Bluetooth access.', cause), { cause });
      if (cause instanceof Error && cause.name === 'InvalidStateError') throw new DeviceSdkError('BLUETOOTH_USER_GESTURE_REQUIRED', bluetoothErrorMessage('The Bluetooth chooser must be opened directly from a user action.', cause), { cause });
      throw new DeviceSdkError('BLUETOOTH_SELECTION_FAILED', bluetoothErrorMessage('The browser could not open the Bluetooth device chooser.', cause), { cause });
    }
    const scanToConnectDelayMs = this.options.scanToConnectDelayMs ?? 800;
    onStateChange?.('connecting');
    deviceDebug('Waiting for Bluetooth scan to settle before connecting', { delay_ms: scanToConnectDelayMs, device_name: device.name ?? 'unknown', device_id: device.id ?? 'unavailable' });
    if (scanToConnectDelayMs > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, scanToConnectDelayMs));
    deviceDebug('Bluetooth scan settle completed', { delay_ms: scanToConnectDelayMs, gatt_connected: device.gatt?.connected ?? 'unknown' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { onStateChange?.('connecting'); deviceDebug('Starting GATT initialization', { attempt: attempt + 1, device_name: device.name ?? 'unknown', device_id: device.id ?? 'unavailable', gatt_connected: device.gatt?.connected ?? 'unknown' }); return await this.#initializeGatt(device, onStateChange); } catch (error) {
        const retryReason = connectionAlreadyInProgress(error) ? 'connection_contention' : error instanceof DeviceSdkError && error.code === 'GATT_NOTIFICATION_SETUP_TIMEOUT' ? 'notification_timeout' : connectionDropped(error) || (error instanceof DeviceSdkError && error.code.startsWith('GATT_DISCONNECTED_')) ? 'gatt_disconnected' : undefined;
        deviceDebug('GATT initialization failed', { attempt: attempt + 1, code: error instanceof DeviceSdkError ? error.code : 'UNKNOWN', retry_reason: retryReason ?? 'not_retryable', gatt_connected: device.gatt?.connected ?? 'unknown', ...bluetoothErrorDetails(error) });
        disconnectBluetoothDevice(device);
        if (attempt === 0 && retryReason) {
          const connectionRetryDelayMs = this.options.connectionRetryDelayMs ?? 1_000;
          deviceDebug('Waiting for Bluetooth stack to settle before retrying GATT initialization', { reason: retryReason, delay_ms: connectionRetryDelayMs, next_attempt: attempt + 2 });
          if (connectionRetryDelayMs > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, connectionRetryDelayMs));
          deviceDebug('Retrying GATT initialization', { reason: retryReason, delay_ms: connectionRetryDelayMs, next_attempt: attempt + 2 });
          continue;
        }
        throw error;
      }
    }
    throw new DeviceSdkError('GATT_CONNECTION_FAILED', 'Bluetooth connection failed after retrying.');
  }
  async #initializeGatt(device: BluetoothDeviceLike, onStateChange?: (state: DeviceSelectionState) => void): Promise<DeviceTransport> {
    const startedAt = Date.now();
    let phase: GattInitializationPhase = 'connecting';
    let disconnectedDuringInitialization = false;
    let server: BluetoothGattServer | undefined;
    const initializationDisconnectListener = () => {
      disconnectedDuringInitialization = true;
      deviceDebug('GATT disconnected during initialization', { phase, elapsed_ms: Date.now() - startedAt, device_name: device.name ?? 'unknown', device_id: device.id ?? 'unavailable', gatt_connected: device.gatt?.connected ?? false });
    };
    device.addEventListener('gattserverdisconnected', initializationDisconnectListener);
    try {
      deviceDebug('Connecting to GATT server', { device_name: device.name ?? 'unknown', device_id: device.id ?? 'unavailable', connected_before: device.gatt?.connected ?? 'unknown' });
      try { server = await device.gatt?.connect(); } catch (cause) {
        deviceDebug('GATT connect call failed', { elapsed_ms: Date.now() - startedAt, ...bluetoothErrorDetails(cause) });
        throw new DeviceSdkError('GATT_CONNECTION_FAILED', bluetoothErrorMessage('Bluetooth connection failed. Keep the device nearby and in binding mode, then try again.', cause), { cause });
      }
      if (!server) throw new DeviceSdkError('GATT_UNAVAILABLE', 'Selected device has no GATT server');
      deviceDebug('GATT connected', { elapsed_ms: Date.now() - startedAt, server_connected: server.connected ?? 'unknown', device_connected: device.gatt?.connected ?? 'unknown' });

      phase = 'stabilizing_connection';
      const postConnectDelayMs = this.options.postConnectDelayMs ?? 400;
      deviceDebug('Waiting for GATT connection to stabilize before service discovery', { delay_ms: postConnectDelayMs, server_connected: server.connected ?? 'unknown' });
      if (postConnectDelayMs > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, postConnectDelayMs));
      deviceDebug('GATT connection stabilization completed', { delay_ms: postConnectDelayMs, elapsed_ms: Date.now() - startedAt, server_connected: server.connected ?? 'unknown' });
      if (disconnectedDuringInitialization || gattServerDisconnected(server)) {
        throw new DeviceSdkError('GATT_DISCONNECTED_DURING_SERVICE_DISCOVERY', 'The Bluetooth connection ended while discovering the Voicecan service. Keep the device awake, in binding mode, and close other apps using it before retrying.');
      }

      phase = 'discovering_service';
      onStateChange?.('inspecting');
      deviceDebug('Discovering Voicecan GATT service', { service_uuid: String(this.options.serviceUuid), server_connected: server.connected ?? 'unknown' });
      let service: BluetoothService;
      try { service = await server.getPrimaryService(this.options.serviceUuid); } catch (cause) {
        const disconnected = disconnectedDuringInitialization || gattServerDisconnected(server) || connectionDropped(cause);
        deviceDebug('Voicecan GATT service discovery failed', { disconnected, elapsed_ms: Date.now() - startedAt, server_connected: server.connected ?? 'unknown', ...bluetoothErrorDetails(cause) });
        if (disconnected) throw new DeviceSdkError('GATT_DISCONNECTED_DURING_SERVICE_DISCOVERY', bluetoothErrorMessage('The Bluetooth connection ended while discovering the Voicecan service. Keep the device awake, in binding mode, and close other apps using it before retrying.', cause), { cause });
        const browserError = underlyingBluetoothError(cause);
        if (browserError?.name === 'NotFoundError') throw new DeviceSdkError('GATT_SERVICE_UNAVAILABLE', bluetoothErrorMessage('The selected device does not expose the required Voicecan BLE service. Confirm the device model and firmware, then try again.', cause), { cause });
        throw new DeviceSdkError('GATT_SERVICE_DISCOVERY_FAILED', bluetoothErrorMessage('The browser could not inspect the Voicecan BLE service. Reconnect the device and try again.', cause), { cause });
      }
      deviceDebug('Voicecan GATT service discovered', { service_uuid: String(this.options.serviceUuid), elapsed_ms: Date.now() - startedAt, server_connected: server.connected ?? 'unknown' });

      phase = 'discovering_characteristics';
      deviceDebug('Discovering Voicecan GATT characteristics', { write_uuid: String(this.options.writeCharacteristicUuid), notify_uuid: String(this.options.notifyCharacteristicUuid), server_connected: server.connected ?? 'unknown' });
      let writer: BluetoothCharacteristic; let reader: BluetoothCharacteristic;
      try {
        writer = await service.getCharacteristic(this.options.writeCharacteristicUuid);
        reader = await service.getCharacteristic(this.options.notifyCharacteristicUuid);
      } catch (cause) {
        const disconnected = disconnectedDuringInitialization || gattServerDisconnected(server) || connectionDropped(cause);
        deviceDebug('Voicecan GATT characteristic discovery failed', { disconnected, elapsed_ms: Date.now() - startedAt, server_connected: server.connected ?? 'unknown', ...bluetoothErrorDetails(cause) });
        if (disconnected) throw new DeviceSdkError('GATT_DISCONNECTED_DURING_CHARACTERISTIC_DISCOVERY', bluetoothErrorMessage('The Bluetooth connection ended while reading Voicecan service details. Keep the device awake and retry the binding flow.', cause), { cause });
        throw new DeviceSdkError('GATT_CHARACTERISTIC_UNAVAILABLE', bluetoothErrorMessage('The selected device does not expose the required Voicecan BLE characteristics. Confirm the firmware version and try again.', cause), { cause });
      }
      deviceDebug('Voicecan GATT characteristics discovered', { write_uuid: String(this.options.writeCharacteristicUuid), notify_uuid: String(this.options.notifyCharacteristicUuid), elapsed_ms: Date.now() - startedAt });

      phase = 'starting_notifications';
      const notificationSetupTimeoutMs = this.options.notificationSetupTimeoutMs ?? 15_000;
      deviceDebug('Enabling BLE notifications', { notify_uuid: String(this.options.notifyCharacteristicUuid), timeout_ms: notificationSetupTimeoutMs, server_connected: server.connected ?? 'unknown' });
      let notificationTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
      try {
        await Promise.race([
          reader.startNotifications(),
          new Promise<never>((_resolve, reject) => { notificationTimer = globalThis.setTimeout(() => reject(new DeviceSdkError('GATT_NOTIFICATION_SETUP_TIMEOUT', 'The device did not confirm BLE notifications in time. Keep it awake and in binding mode, then retry.')), notificationSetupTimeoutMs); }),
        ]);
      } catch (cause) {
        const disconnected = disconnectedDuringInitialization || gattServerDisconnected(server) || connectionDropped(cause);
        deviceDebug('BLE notification setup failed', { disconnected, timed_out: cause instanceof DeviceSdkError && cause.code === 'GATT_NOTIFICATION_SETUP_TIMEOUT', elapsed_ms: Date.now() - startedAt, server_connected: server.connected ?? 'unknown', ...bluetoothErrorDetails(cause) });
        if (cause instanceof DeviceSdkError && cause.code === 'GATT_NOTIFICATION_SETUP_TIMEOUT') throw cause;
        if (disconnected) throw new DeviceSdkError('GATT_DISCONNECTED_DURING_NOTIFICATION_SETUP', bluetoothErrorMessage('The Bluetooth connection ended while enabling device notifications. Keep the device nearby and retry the binding flow.', cause), { cause });
        throw new DeviceSdkError('GATT_NOTIFICATIONS_FAILED', bluetoothErrorMessage('Bluetooth notifications could not be enabled on the selected device.', cause), { cause });
      } finally {
        if (notificationTimer !== undefined) globalThis.clearTimeout(notificationTimer);
      }
      phase = 'ready';
      deviceDebug('BLE notifications enabled', { elapsed_ms: Date.now() - startedAt, server_connected: server.connected ?? 'unknown' });
      deviceDebug('GATT initialization completed', { elapsed_ms: Date.now() - startedAt, device_name: device.name ?? 'unknown', device_id: device.id ?? 'unavailable' });
      return new WebBluetoothTransport(device, writer, reader, this.options.timeoutMs ?? 15_000);
    } finally {
      device.removeEventListener('gattserverdisconnected', initializationDisconnectListener);
    }
  }
}

export class DeviceSdkError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeviceSdkError';
  }
}

class SelectedDevice {
  #session?: SemanticProtocolSession;
  #info?: DeviceInfo;
  #compatibility?: CompatibilityReport;
  #claim?: Awaited<ReturnType<ProvisioningBroker['claim']>>;
  #commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly owner: VoicecanDeviceClient,
    private readonly transport: DeviceTransport,
  ) {}

  #runCommand<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#commandQueue.then(operation, operation);
    this.#commandQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async connectForProvisioning(input: { signal?: AbortSignal } = {}): Promise<ProvisioningConnection> {
    try {
      this.owner.setState('connecting');
      this.#session = await this.owner.protocol.createSession(this.transport);
      this.owner.setState('inspecting');
      this.#info = await this.#session.getInfo(input.signal);
      this.owner.publishDeviceInfo(this.#info);
      this.#compatibility = this.owner.protocol.compatibilityReport(this.#info);
      this.owner.setState('claiming');
      this.#claim = await this.owner.broker.claim({
        provisioningToken: this.owner.provisioningToken,
        serialNumber: this.#info.serialNumber,
        manufacturer: this.#info.manufacturer,
        ...(this.transport.deviceName ? { bluetoothName: this.transport.deviceName } : {}),
      });
      deviceDebug('Provisioning claim accepted', { device_id: this.#claim.deviceId, device_ws_url: this.#claim.wssUrl, temporary_credential_recovered: Boolean(this.#claim.recovered) });
      this.owner.publishProvisioningClaim({ deviceId: this.#claim.deviceId, recovered: Boolean(this.#claim.recovered) });
      this.owner.setState('handshaking');
      await this.#session.authenticate(this.#claim.rawToken, input.signal);
      await this.owner.broker.reportProgress({ provisioningSessionId: this.#claim.provisioningSessionId, continuationToken: this.#claim.continuationToken, stage: 'ble_authenticated' });
      const timezoneOffsetHours = Math.max(-12, Math.min(14, Math.trunc(-new Date().getTimezoneOffset() / 60)));
      try {
        await this.#session.syncTime({ unixTimeSeconds: Math.floor(Date.now() / 1_000), timezoneOffsetHours }, input.signal);
        deviceDebug('Device time synchronization acknowledged', { timezone_offset_hours: timezoneOffsetHours });
      } catch (cause) {
        deviceDebug('Device time synchronization failed and provisioning will continue', { timezone_offset_hours: timezoneOffsetHours, error_name: cause instanceof Error ? cause.name : 'Error', error_message: cause instanceof Error ? cause.message : String(cause) });
      }
      const deviceStatus = await this.getStatus(input.signal);
      this.owner.setState('waiting_network');
      return { deviceId: this.#claim.deviceId, deviceInfo: this.#info, deviceStatus, compatibility: this.#compatibility };
    } catch (cause) {
      return this.#failProvisioning(cause);
    }
  }

  async completeProvisioning(input: { wifi?: WifiConfiguration; signal?: AbortSignal; networkTimeoutMs?: number } = {}): Promise<ProvisioningResult> {
    try {
      if (!this.#session || !this.#info || !this.#compatibility || !this.#claim) throw new DeviceSdkError('PROVISIONING_CONNECTION_REQUIRED', 'Connect to the nearby device before configuring its network');
      if (input.wifi) {
        this.owner.setState('configuring_network');
        await this.#session.configureWifi(input.wifi, input.signal);
        deviceDebug('Device Wi-Fi configuration acknowledged');
      } else {
        deviceDebug('Device Wi-Fi configuration skipped; retaining the existing network');
      }
      this.owner.setState('waiting_network');
      await this.#waitForNetwork(input.networkTimeoutMs ?? provisioningNetworkTimeoutMs, input.signal);
      this.owner.setState('configuring_server');
      await this.#session.configureServer({ wssUrl: this.#claim.wssUrl, token: this.#claim.rawToken }, input.signal);
      deviceDebug('Device server configuration acknowledged', { device_ws_url: this.#claim.wssUrl });
      await this.owner.broker.reportProgress({ provisioningSessionId: this.#claim.provisioningSessionId, continuationToken: this.#claim.continuationToken, stage: 'configured' });
      this.owner.setState('waiting_server');
      deviceDebug('Waiting for server online confirmation', { device_id: this.#claim.deviceId, timeout_ms: provisioningOnlineTimeoutMs });
      const online = await this.owner.broker.waitForOnline(this.#claim.deviceId, provisioningOnlineTimeoutMs, input.signal);
      if (!online) throw new DeviceSdkError('SERVER_ONLINE_TIMEOUT', 'The device did not confirm its server connection before the timeout');
      this.owner.setState('ready');
      deviceDebug('Server confirmed device online', { device_id: this.#claim.deviceId });
      return { deviceId: this.#claim.deviceId, serverStatus: 'online', deviceInfo: this.#info, compatibility: this.#compatibility };
    } catch (cause) {
      return this.#failProvisioning(cause);
    }
  }

  async provision(input: { wifi?: WifiConfiguration; signal?: AbortSignal }): Promise<ProvisioningResult> {
    await this.connectForProvisioning(input.signal ? { signal: input.signal } : {});
    return this.completeProvisioning(input);
  }

  async #waitForNetwork(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getStatus(signal);
      if (status.wifiConfigured) {
        deviceDebug('Device network is available');
        return;
      }
      await delay(Math.min(provisioningNetworkPollMs, Math.max(0, deadline - Date.now())), signal);
    }
    throw new DeviceSdkError('NETWORK_AVAILABLE_TIMEOUT', 'The device network did not become available before the timeout');
  }

  async #failProvisioning(cause: unknown): Promise<never> {
    const failedAt = this.owner.state;
    const failureCode = sdkFailureCode(cause, 'PROVISIONING_FAILED');
    deviceDebug('Device binding failed', { stage: failedAt, code: failureCode, error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) });
    this.owner.setState('failed');
    if (this.#claim) await this.owner.broker.reportProgress({ provisioningSessionId: this.#claim.provisioningSessionId, continuationToken: this.#claim.continuationToken, stage: 'failed', failureCode }).catch(() => undefined);
    await this.#session?.close().catch(() => undefined);
    await this.transport.close().catch(() => undefined);
    if (cause instanceof DeviceSdkError) throw cause;
    throw new DeviceSdkError(failureCode, provisioningFailureMessage(failedAt, cause), { cause });
  }

  async transferOut(input: { transferToken: string; broker: TransferOutBroker; signal?: AbortSignal }): Promise<{ deviceId: string; recordingsErased: false }> {
    let claim: Awaited<ReturnType<TransferOutBroker['claim']>> | undefined; let rawToken: Uint8Array | undefined;
    try {
      this.owner.setState('inspecting'); this.#session = await this.owner.protocol.createSession(this.transport); this.#info = await this.#session.getInfo(input.signal); this.owner.publishDeviceInfo(this.#info);
      const keys = await globalThis.crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
      const publicKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', keys.publicKey);
      claim = await input.broker.claim({ transferToken: input.transferToken, publicKeyJwk });
      if (claim.algorithm !== 'RSA-OAEP-256' || claim.serialNumber !== this.#info.serialNumber || claim.manufacturer !== this.#info.manufacturer) throw new DeviceSdkError('TRANSFER_OUT_DEVICE_MISMATCH', 'The selected device does not match the transfer-out session');
      const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keys.privateKey, decodeBase64(claim.sealedDeviceToken)); rawToken = new Uint8Array(plaintext);
      if (rawToken.byteLength !== 32) throw new DeviceSdkError('TRANSFER_TOKEN_ENVELOPE_INVALID', 'The transfer credential has an invalid length');
      this.owner.setState('handshaking'); await this.#session.authenticate(rawToken, input.signal);
      this.owner.setState('releasing'); await this.#session.unbind(false, input.signal);
      await input.broker.complete({ transferSessionId: claim.transferSessionId, continuationToken: claim.continuationToken, serialNumber: this.#info.serialNumber, result: 'ack' });
      this.owner.setState('released'); return { deviceId: claim.deviceId, recordingsErased: false };
    } catch (cause) {
      this.owner.setState('failed');
      if (claim && this.#info) await input.broker.complete({ transferSessionId: claim.transferSessionId, continuationToken: claim.continuationToken, serialNumber: this.#info.serialNumber, result: 'failed', failureCode: cause instanceof DeviceSdkError ? cause.code : 'TRANSFER_OUT_CLIENT_FAILED' }).catch(() => undefined);
      await this.#session?.close().catch(() => undefined);
      await this.transport.close().catch(() => undefined);
      if (cause instanceof DeviceSdkError) throw cause;
      throw new DeviceSdkError('TRANSFER_OUT_FAILED', 'Device transfer-out failed without changing server ownership', { cause });
    } finally { rawToken?.fill(0); }
  }

  async getStatus(signal?: AbortSignal): Promise<DeviceStatus> {
    if (!this.#session) throw new DeviceSdkError('NOT_CONNECTED', 'Provision the device first');
    return this.#runCommand(async () => {
      const status = await this.#session!.getStatus(signal);
      this.owner.publishDeviceStatus(status);
      deviceDebug('Device status refreshed', {
        battery_percent: status.batteryPercent, battery_state: status.battery?.state ?? 'unavailable',
        storage_total_kb: status.storage?.totalKilobytes ?? null, storage_free_kb: status.storage?.freeKilobytes ?? null,
        storage_recording_hours: status.storage?.recordingHours ?? null, recording: status.recording, wifi_configured: status.wifiConfigured,
      });
      return status;
    });
  }

  async getInfo(signal?: AbortSignal): Promise<DeviceInfo> {
    if (!this.#session) throw new DeviceSdkError('NOT_CONNECTED', 'Provision the device first');
    return this.#runCommand(async () => {
      const info = await this.#session!.getInfo(signal);
      this.#info = info;
      this.owner.publishDeviceInfo(info);
      deviceDebug('Device information refreshed', { manufacturer: info.manufacturer, model: info.model, serial_number: info.serialNumber, firmware_version: info.firmwareVersion });
      return info;
    });
  }

  async disconnect(): Promise<void> {
    await this.#session?.close().catch(() => undefined);
    await this.transport.close().catch(() => undefined);
    this.owner.setState('disconnected');
  }

  async startRecording(signal?: AbortSignal): Promise<{ sessionId: number }> {
    if (!this.#session) throw new DeviceSdkError('NOT_CONNECTED', 'Provision the device first');
    return this.#runCommand(() => this.#session!.startRecording(signal));
  }

  async stopRecording(signal?: AbortSignal): Promise<void> {
    if (!this.#session) throw new DeviceSdkError('NOT_CONNECTED', 'Provision the device first');
    await this.#runCommand(() => this.#session!.stopRecording(signal));
  }

  async listFiles(cursor?: string, signal?: AbortSignal): Promise<{ files: FileDescriptor[]; cursor: string | null }> {
    if (!this.#session) throw new DeviceSdkError('NOT_CONNECTED', 'Provision the device first');
    return this.#runCommand(() => this.#session!.listFiles(cursor, signal));
  }

  async close(): Promise<void> {
    await this.#runCommand(async () => { await this.#session?.close(); await this.transport.close(); });
    this.owner.setState('disconnected');
  }
}

export class VoicecanDeviceClient extends EventTarget {
  state: ProvisioningState;
  #provisioningToken: string;
  readonly broker: ProvisioningBroker;
  readonly protocol: SemanticProtocolFactory;
  readonly transport: DeviceTransportFactory;

  constructor(options: {
    provisioningToken: string;
    broker: ProvisioningBroker;
    protocol: SemanticProtocolFactory;
    transport: DeviceTransportFactory;
  }) {
    super();
    this.#provisioningToken = options.provisioningToken;
    this.broker = options.broker;
    this.protocol = options.protocol;
    this.transport = options.transport;
    this.state = options.transport.supported() ? 'idle' : 'unsupported';
  }

  get provisioningToken(): string { return this.#provisioningToken; }

  setProvisioningToken(value: string): void {
    if (!value.trim()) throw new DeviceSdkError('PROVISIONING_TOKEN_REQUIRED', 'Provisioning token is required');
    if (!['idle', 'unsupported', 'selecting', 'connecting', 'inspecting', 'failed', 'disconnected'].includes(this.state)) throw new DeviceSdkError('PROVISIONING_IN_PROGRESS', 'Cannot replace the provisioning token after device binding has started');
    this.#provisioningToken = value.trim();
  }

  publishDeviceInfo(info: DeviceInfo): void {
    this.dispatchEvent(new CustomEvent('deviceinfo', { detail: info }));
  }

  publishDeviceStatus(status: DeviceStatus): void {
    this.dispatchEvent(new CustomEvent('devicestatus', { detail: status }));
  }

  publishProvisioningClaim(claim: { deviceId: string; recovered: boolean }): void {
    this.dispatchEvent(new CustomEvent('provisioningclaim', { detail: claim }));
  }

  setState(state: ProvisioningState): void {
    this.state = state;
    deviceDebug('Provisioning state changed', { state });
    this.dispatchEvent(new CustomEvent('statechange', { detail: state }));
  }

  async requestDevice(): Promise<SelectedDevice> {
    if (!this.transport.supported()) throw new DeviceSdkError('WEB_BLUETOOTH_UNSUPPORTED', 'Use a native provisioner');
    this.setState('selecting');
    try {
      return new SelectedDevice(this, await this.transport.requestDevice((state) => this.setState(state)));
    } catch (cause) {
      this.setState('idle');
      if (cause instanceof DeviceSdkError) throw cause;
      throw new DeviceSdkError('DEVICE_SELECTION_FAILED', 'Device selection failed unexpectedly.', { cause });
    }
  }
}
