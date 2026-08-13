import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceSdkError, VoicecanDeviceClient, WebBluetoothTransportFactory } from '../src/index.js';

test('unsupported transport fails before selection', async () => {
  const client = new VoicecanDeviceClient({
    provisioningToken: 'public',
    broker: { claim: async () => { throw new Error('unused'); }, reportProgress: async () => undefined, waitForOnline: async () => false },
    protocol: { createSession: async () => { throw new Error('unused'); } },
    transport: { supported: () => false, requestDevice: async () => { throw new Error('unused'); } },
  });
  assert.equal(client.state, 'unsupported');
  await assert.rejects(client.requestDevice(), { code: 'WEB_BLUETOOTH_UNSUPPORTED' });
});

test('device selection preserves transport failure codes', async () => {
  const client = new VoicecanDeviceClient({
    provisioningToken: 'public',
    broker: { claim: async () => { throw new Error('unused'); }, reportProgress: async () => undefined, waitForOnline: async () => false },
    protocol: { createSession: async () => { throw new Error('unused'); } },
    transport: { supported: () => true, requestDevice: async () => { throw new DeviceSdkError('GATT_SERVICE_UNAVAILABLE', 'The selected device does not expose the required Voicecan BLE service.'); } },
  });
  await assert.rejects(client.requestDevice(), { code: 'GATT_SERVICE_UNAVAILABLE' });
  assert.equal(client.state, 'idle');
});

test('device selection reports GATT progress after the browser chooser closes', async () => {
  const states: string[] = [];
  const transport = { exchange: async () => new Uint8Array(), close: async () => undefined };
  const client = new VoicecanDeviceClient({
    provisioningToken: 'public',
    broker: { claim: async () => { throw new Error('unused'); }, reportProgress: async () => undefined, waitForOnline: async () => false },
    protocol: { createSession: async () => { throw new Error('unused'); } },
    transport: { supported: () => true, requestDevice: async (onStateChange) => { onStateChange?.('connecting'); onStateChange?.('inspecting'); return transport; } },
  });
  client.addEventListener('statechange', (event) => states.push(String((event as CustomEvent).detail)));
  await client.requestDevice();
  assert.deepEqual(states, ['selecting', 'connecting', 'inspecting']);
});

test('unexpected browser selection failures preserve the concrete error', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { bluetooth: { requestDevice: async () => { throw new TypeError('Invalid Service name: test-uuid'); } } },
  });
  try {
    const transport = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
    });
    await assert.rejects(transport.requestDevice(), (error: unknown) => {
      assert.ok(error instanceof DeviceSdkError);
      assert.equal(error.code, 'BLUETOOTH_SELECTION_FAILED');
      assert.equal(error.message, 'The browser could not open the Bluetooth device chooser.\nTypeError: Invalid Service name: test-uuid');
      assert.ok(error.cause instanceof TypeError);
      return true;
    });
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('notification failures preserve the browser GATT error', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let disconnects = 0;
  const writer = Object.assign(new EventTarget(), { writeValueWithoutResponse: async () => undefined });
  const reader = Object.assign(new EventTarget(), { startNotifications: async () => { throw new DOMException('GATT operation not permitted', 'NotSupportedError'); } });
  const device = Object.assign(new EventTarget(), {
    gatt: {
      disconnect: () => { disconnects += 1; },
      connect: async () => ({
        getPrimaryService: async () => ({
          getCharacteristic: async (uuid: string | number) => uuid === '00002dd1-0000-1000-8000-00805f9b34fb' ? writer : reader,
        }),
      }),
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { bluetooth: { requestDevice: async () => device } },
  });
  try {
    const transport = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
    });
    await assert.rejects(transport.requestDevice(), (error: unknown) => {
      assert.ok(error instanceof DeviceSdkError);
      assert.equal(error.code, 'GATT_NOTIFICATIONS_FAILED');
      assert.equal(error.message, 'Bluetooth notifications could not be enabled on the selected device.\nNotSupportedError: GATT operation not permitted');
      assert.ok(error.cause instanceof DOMException);
      return true;
    });
    assert.equal(disconnects, 1);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('notification setup timeout retries once instead of leaving selection pending forever', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let connects = 0; let disconnects = 0; let notificationAttempts = 0;
  const writer = Object.assign(new EventTarget(), { writeValueWithoutResponse: async () => undefined });
  const reader = Object.assign(new EventTarget(), { startNotifications: () => { notificationAttempts += 1; return new Promise<never>(() => undefined); } });
  const server = {
    connected: false,
    disconnect: () => { disconnects += 1; server.connected = false; },
    connect: async () => { connects += 1; server.connected = true; return server; },
    getPrimaryService: async () => ({ getCharacteristic: async (uuid: string | number) => uuid === '00002dd1-0000-1000-8000-00805f9b34fb' ? writer : reader }),
  };
  const device = Object.assign(new EventTarget(), { gatt: server });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  try {
    const factory = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
      connectionRetryDelayMs: 0,
      notificationSetupTimeoutMs: 5,
    });
    await assert.rejects(factory.requestDevice(), { code: 'GATT_NOTIFICATION_SETUP_TIMEOUT' });
    assert.equal(connects, 2);
    assert.equal(notificationAttempts, 2);
    assert.equal(disconnects, 2);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('Bluetooth transport logs frame metadata without exposing protocol payloads', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDebug = console.debug;
  const logs: Array<{ event: string; details?: Readonly<Record<string, unknown>> }> = [];
  const writes: Uint8Array[] = [];
  const writer = Object.assign(new EventTarget(), {
    writeValueWithoutResponse: async (value: BufferSource) => {
      const view = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        : new Uint8Array(value.slice(0));
      writes.push(view);
    },
  });
  const reader = Object.assign(new EventTarget(), {
    value: undefined as DataView | undefined,
    startNotifications: async () => reader,
    stopNotifications: async () => reader,
  });
  const server = {
    connected: false,
    disconnect: () => { server.connected = false; },
    connect: async () => { server.connected = true; return server; },
    getPrimaryService: async () => ({
      getCharacteristic: async (uuid: string | number) => uuid === '00002dd1-0000-1000-8000-00805f9b34fb' ? writer : reader,
    }),
  };
  const device = Object.assign(new EventTarget(), { id: 'browser-device-frames', name: 'CAPSO-FRAMES', gatt: server });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  console.debug = (event: unknown, details?: unknown) => { logs.push({ event: String(event), ...(details && typeof details === 'object' ? { details: details as Readonly<Record<string, unknown>> } : {}) }); };
  try {
    const factory = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
    });
    const transport = await factory.requestDevice();
    const responsePromise = transport.exchange(Uint8Array.from([0x01, 0x0a, 0xff]));
    assert.deepEqual(writes, [Uint8Array.from([0x01, 0x0a, 0xff])]);
    reader.value = new DataView(Uint8Array.from([0x02, 0x10, 0xab, 0xcd]).buffer);
    reader.dispatchEvent(new Event('characteristicvaluechanged'));
    assert.deepEqual(await responsePromise, Uint8Array.from([0x02, 0x10, 0xab, 0xcd]));
    assert.ok(logs.some((entry) => entry.event.includes('BLE TX frame') && entry.details?.exchange_id === 1 && entry.details.bytes === 3));
    assert.ok(logs.some((entry) => entry.event.includes('BLE RX frame') && entry.details?.exchange_id === 1 && entry.details.bytes === 4));
    assert.ok(logs.every((entry) => !entry.details || !('hex' in entry.details)));
    assert.ok(logs.some((entry) => entry.event.includes('BLE RX protocol frame accepted') && entry.details?.response_complete === true));
    const scanSettleIndex = logs.findIndex((entry) => entry.event.includes('Bluetooth scan settle completed'));
    const connectIndex = logs.findIndex((entry) => entry.event.includes('Connecting to GATT server'));
    const stabilizationIndex = logs.findIndex((entry) => entry.event.includes('GATT connection stabilization completed'));
    const serviceDiscoveryIndex = logs.findIndex((entry) => entry.event.includes('Discovering Voicecan GATT service'));
    assert.ok(scanSettleIndex >= 0 && scanSettleIndex < connectIndex);
    assert.ok(stabilizationIndex >= 0 && stabilizationIndex < serviceDiscoveryIndex);
    await transport.close();
  } finally {
    console.debug = originalDebug;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('Bluetooth transport keeps an interactive exchange open for device-driven chunks', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const writes: Uint8Array[] = [];
  const writer = Object.assign(new EventTarget(), {
    writeValueWithoutResponse: async (value: BufferSource) => {
      const view = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) : new Uint8Array(value.slice(0));
      writes.push(view);
    },
  });
  const reader = Object.assign(new EventTarget(), { value: undefined as DataView | undefined, startNotifications: async () => reader, stopNotifications: async () => reader });
  const server = { connected: false, disconnect: () => { server.connected = false; }, connect: async () => { server.connected = true; return server; }, getPrimaryService: async () => ({ getCharacteristic: async (uuid: string | number) => uuid === '00002dd1-0000-1000-8000-00805f9b34fb' ? writer : reader }) };
  const device = Object.assign(new EventTarget(), { id: 'browser-device-interactive', name: 'CAPSO-INTERACTIVE', gatt: server });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  try {
    const transport = await new WebBluetoothTransportFactory({ serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb', writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb', notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb', scanToConnectDelayMs: 0, postConnectDelayMs: 0 }).requestDevice();
    assert.ok(transport.interact);
    const interaction = transport.interact(Uint8Array.from([0x01]), (frame) => frame[0] === 0x10 ? { complete: false, response: Uint8Array.from([0x20]) } : { complete: true });
    reader.value = new DataView(Uint8Array.from([0x10]).buffer); reader.dispatchEvent(new Event('characteristicvaluechanged'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, [Uint8Array.from([0x01]), Uint8Array.from([0x20])]);
    reader.value = new DataView(Uint8Array.from([0x30]).buffer); reader.dispatchEvent(new Event('characteristicvaluechanged'));
    assert.deepEqual(await interaction, [Uint8Array.from([0x10]), Uint8Array.from([0x30])]);
    await transport.close();
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('service discovery disconnect logs its phase and retries once', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDebug = console.debug;
  const logs: Array<{ event: string; details?: Readonly<Record<string, unknown>> }> = [];
  let connects = 0; let disconnects = 0; let serviceAttempts = 0;
  const writer = Object.assign(new EventTarget(), { writeValueWithoutResponse: async () => undefined });
  const reader = Object.assign(new EventTarget(), { startNotifications: async () => reader, stopNotifications: async () => reader });
  const device = Object.assign(new EventTarget(), { id: 'browser-device-1', name: 'CAPSO-TEST' });
  const server = {
    connected: false,
    disconnect: () => { disconnects += 1; server.connected = false; },
    connect: async () => { connects += 1; server.connected = true; return server; },
    getPrimaryService: async () => {
      serviceAttempts += 1;
      if (serviceAttempts === 1) {
        server.connected = false;
        device.dispatchEvent(new Event('gattserverdisconnected'));
        throw new DOMException('GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.', 'NetworkError');
      }
      return { getCharacteristic: async (uuid: string | number) => uuid === '00002dd1-0000-1000-8000-00805f9b34fb' ? writer : reader };
    },
  };
  Object.assign(device, { gatt: server });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  console.debug = (event: unknown, details?: unknown) => { logs.push({ event: String(event), ...(details && typeof details === 'object' ? { details: details as Readonly<Record<string, unknown>> } : {}) }); };
  try {
    const factory = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
      connectionRetryDelayMs: 0,
    });
    const transport = await factory.requestDevice();
    assert.equal(connects, 2);
    assert.equal(serviceAttempts, 2);
    assert.equal(disconnects, 1);
    assert.ok(logs.some((entry) => entry.event.includes('GATT disconnected during initialization') && entry.details?.phase === 'discovering_service'));
    assert.ok(logs.some((entry) => entry.event.includes('Retrying GATT initialization') && entry.details?.reason === 'gatt_disconnected'));
    assert.ok(logs.some((entry) => entry.event.includes('GATT initialization completed')));
    await transport.close();
    assert.equal(disconnects, 2);
  } finally {
    console.debug = originalDebug;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('persistent service discovery disconnect reports an actionable error', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let connects = 0;
  const device = Object.assign(new EventTarget(), { name: 'CAPSO-TEST' });
  const server = {
    connected: false,
    disconnect: () => { server.connected = false; },
    connect: async () => { connects += 1; server.connected = true; return server; },
    getPrimaryService: async () => {
      server.connected = false;
      throw new DOMException('GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.', 'NetworkError');
    },
  };
  Object.assign(device, { gatt: server });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  try {
    const factory = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
      connectionRetryDelayMs: 0,
    });
    await assert.rejects(factory.requestDevice(), (error: unknown) => {
      assert.ok(error instanceof DeviceSdkError);
      assert.equal(error.code, 'GATT_DISCONNECTED_DURING_SERVICE_DISCOVERY');
      assert.match(error.message, /^The Bluetooth connection ended while discovering the Voicecan service\./);
      assert.match(error.message, /NetworkError: GATT Server is disconnected/);
      return true;
    });
    assert.equal(connects, 2);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('a real missing Voicecan service remains distinct from a disconnect', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let connects = 0;
  const server = {
    connected: true,
    disconnect: () => { server.connected = false; },
    connect: async () => { connects += 1; server.connected = true; return server; },
    getPrimaryService: async () => { throw new DOMException('No Services matching UUID found in Device.', 'NotFoundError'); },
  };
  const device = Object.assign(new EventTarget(), { gatt: server });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  try {
    const factory = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
      connectionRetryDelayMs: 0,
    });
    await assert.rejects(factory.requestDevice(), (error: unknown) => {
      assert.ok(error instanceof DeviceSdkError);
      assert.equal(error.code, 'GATT_SERVICE_UNAVAILABLE');
      assert.match(error.message, /^The selected device does not expose the required Voicecan BLE service\./);
      return true;
    });
    assert.equal(connects, 1);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('connection-in-progress notification failure disconnects and retries once', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let connects = 0; let disconnects = 0; let notificationAttempts = 0;
  const writer = Object.assign(new EventTarget(), { writeValueWithoutResponse: async () => undefined });
  const reader = Object.assign(new EventTarget(), {
    startNotifications: async () => {
      notificationAttempts += 1;
      if (notificationAttempts === 1) throw new DOMException('Connection already in progress.', 'NetworkError');
      return reader;
    },
    stopNotifications: async () => reader,
  });
  const server = {
    disconnect: () => { disconnects += 1; },
    connect: async () => { connects += 1; return server; },
    getPrimaryService: async () => ({
      getCharacteristic: async (uuid: string | number) => uuid === '00002dd1-0000-1000-8000-00805f9b34fb' ? writer : reader,
    }),
  };
  const device = Object.assign(new EventTarget(), { gatt: server });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  try {
    const factory = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
      connectionRetryDelayMs: 0,
    });
    const transport = await factory.requestDevice();
    assert.equal(connects, 2);
    assert.equal(notificationAttempts, 2);
    assert.equal(disconnects, 1);
    await transport.close();
    assert.equal(disconnects, 2);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('factory rejects concurrent Bluetooth connection attempts', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let rejectChooser: (error: Error) => void = () => undefined;
  const chooser = new Promise<never>((_resolve, reject) => { rejectChooser = reject; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: () => chooser } } });
  try {
    const factory = new WebBluetoothTransportFactory({
      serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
      scanToConnectDelayMs: 0,
      postConnectDelayMs: 0,
    });
    const firstAttempt = factory.requestDevice();
    await assert.rejects(factory.requestDevice(), { code: 'BLUETOOTH_CONNECTION_PENDING' });
    rejectChooser(new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'));
    await assert.rejects(firstAttempt, { code: 'DEVICE_SELECTION_CANCELED' });
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('provisioning connects before optional network setup, waits for network availability, then configures the server and waits for online state', async () => {
  const stages: string[] = []; const states: string[] = []; const protocolEvents: string[] = []; const bindingEvents: string[] = []; const provisioningEvents: string[] = []; const claimedDeviceIds: string[] = []; const claimedBluetoothNames: Array<string | undefined> = []; const claimedProvisioningTokens: string[] = []; let onlineTimeoutMs = 0; let wifiConfigureCalls = 0; let statusReads = 0; let liveCommands = false; let infoRefreshStarted = false; let releaseStatus = () => undefined;
  const transport = { deviceName: 'CAPSO-SCANNED', exchange: async () => new Uint8Array(), close: async () => undefined };
  const client = new VoicecanDeviceClient({
    provisioningToken: 'grant',
    broker: {
      claim: async ({ provisioningToken, bluetoothName }) => { bindingEvents.push('claimToken'); claimedProvisioningTokens.push(provisioningToken); claimedBluetoothNames.push(bluetoothName); return { provisioningSessionId: 'provision_1', continuationToken: 'continue_1', deviceId: 'dev_1', rawToken: new Uint8Array(32), wssUrl: 'wss://device.test/device/v1/ws' }; },
      reportProgress: async ({ stage }) => { stages.push(stage); },
      waitForOnline: async (_deviceId, timeoutMs) => { onlineTimeoutMs = timeoutMs; return true; },
    },
    protocol: {
      compatibilityReport: () => ({ status: 'blocked', reasons: ['FIRMWARE_RANGE_NOT_VERIFIED'] }),
      createSession: async () => ({
        authenticate: async () => { bindingEvents.push('authenticateToken'); },
        syncTime: async () => { bindingEvents.push('syncTime'); },
        getInfo: async () => { if (liveCommands) infoRefreshStarted = true; else bindingEvents.push('getInfo'); return { manufacturer: 'Voicecan', serialNumber: 'CAPSO-1', model: 'CAPSO', firmwareVersion: 'v0.5.3' }; },
        getStatus: async () => { if (liveCommands) await new Promise<void>((resolve) => { releaseStatus = resolve; }); else bindingEvents.push('getStatus'); statusReads += 1; provisioningEvents.push('getStatus'); return { batteryPercent: 80, recording: false, wifiConfigured: statusReads > 1 }; },
        configureWifi: async () => { wifiConfigureCalls += 1; provisioningEvents.push('configureWifi'); },
        configureServer: async () => { provisioningEvents.push('configureServer'); },
        startRecording: async () => ({ sessionId: 1 }),
        stopRecording: async () => undefined,
        listFiles: async () => ({ files: [], cursor: null }),
        close: async () => undefined,
      }),
    },
    transport: { supported: () => true, requestDevice: async (onStateChange) => { onStateChange?.('connecting'); onStateChange?.('inspecting'); return transport; } },
  });
  client.addEventListener('statechange', (event) => states.push((event as CustomEvent<string>).detail));
  client.addEventListener('provisioningclaim', (event) => claimedDeviceIds.push((event as CustomEvent<{ deviceId: string }>).detail.deviceId));
  client.addEventListener('deviceinfo', () => protocolEvents.push('deviceinfo'));
  client.addEventListener('devicestatus', () => protocolEvents.push('devicestatus'));
  const selected = await client.requestDevice();
  client.setProvisioningToken('grant-created-while-selecting');
  const connection = await selected.connectForProvisioning();
  assert.equal(connection.deviceStatus.wifiConfigured, false);
  assert.deepEqual(connection.compatibility, { status: 'blocked', reasons: ['FIRMWARE_RANGE_NOT_VERIFIED'] });
  assert.deepEqual(bindingEvents, ['getInfo', 'claimToken', 'authenticateToken', 'syncTime', 'getStatus'], 'identity, token binding and time synchronization must complete before network setup');
  assert.deepEqual(claimedBluetoothNames, ['CAPSO-SCANNED'], 'the Bluetooth advertised name should become the initial server-side display name');
  assert.deepEqual(claimedProvisioningTokens, ['grant-created-while-selecting'], 'a grant created alongside device selection must be accepted before the claim starts');
  assert.deepEqual(provisioningEvents, ['getStatus'], 'connecting must only inspect the current network');
  const result = await selected.completeProvisioning({ wifi: { ssid: 'test', password: 'secret', encryption: 'wpa2' } });
  assert.equal(result.serverStatus, 'online');
  assert.equal(onlineTimeoutMs, 180_000);
  assert.deepEqual(stages, ['ble_authenticated', 'configured']);
  assert.deepEqual(states.slice(-6), ['waiting_network', 'configuring_network', 'waiting_network', 'configuring_server', 'waiting_server', 'ready']);
  assert.deepEqual(claimedDeviceIds, ['dev_1']);
  assert.deepEqual(protocolEvents, ['deviceinfo', 'devicestatus', 'devicestatus']);
  assert.deepEqual(provisioningEvents.slice(0, 4), ['getStatus', 'configureWifi', 'getStatus', 'configureServer']);
  assert.equal(wifiConfigureCalls, 1);

  const skipNetworkStages: string[] = [];
  const skipNetworkClient = new VoicecanDeviceClient({
    provisioningToken: 'grant',
    broker: {
      claim: async () => ({ provisioningSessionId: 'provision_skip', continuationToken: 'continue_skip', deviceId: 'dev_skip', rawToken: new Uint8Array(32), wssUrl: 'ws://device.test/device/v1/ws' }),
      reportProgress: async ({ stage }) => { skipNetworkStages.push(stage); },
      waitForOnline: async () => true,
    },
    protocol: client.protocol,
    transport: client.transport,
  });
  const skipNetworkDevice = await skipNetworkClient.requestDevice();
  await skipNetworkDevice.provision({});
  assert.equal(wifiConfigureCalls, 1, 'skipping network configuration must not write Wi-Fi credentials');
  assert.deepEqual(skipNetworkStages, ['ble_authenticated', 'configured']);

  liveCommands = true;
  const statusRequest = selected.getStatus();
  await Promise.resolve();
  const infoRequest = selected.getInfo();
  await Promise.resolve();
  assert.equal(infoRefreshStarted, false, 'live protocol reads should be serialized');
  releaseStatus();
  const [liveStatus, refreshedInfo] = await Promise.all([statusRequest, infoRequest]);
  assert.equal(liveStatus.batteryPercent, 80);
  assert.equal(refreshedInfo.serialNumber, 'CAPSO-1');
  assert.equal(infoRefreshStarted, true);
  assert.deepEqual(protocolEvents, ['deviceinfo', 'devicestatus', 'devicestatus', 'devicestatus', 'deviceinfo']);
  liveCommands = false;

  const timeoutStages: string[] = [];
  const timeoutClient = new VoicecanDeviceClient({
    provisioningToken: 'grant',
    broker: {
      claim: async () => ({ provisioningSessionId: 'provision_2', continuationToken: 'continue_2', deviceId: 'dev_2', rawToken: new Uint8Array(32), wssUrl: 'wss://device.test/device/v1/ws' }),
      reportProgress: async ({ stage }) => { timeoutStages.push(stage); },
      waitForOnline: async () => false,
    },
    protocol: client.protocol,
    transport: client.transport,
  });
  const timeoutDevice = await timeoutClient.requestDevice();
  await assert.rejects(timeoutDevice.provision({ wifi: { ssid: 'test', password: 'secret', encryption: 'wpa2' } }), { code: 'SERVER_ONLINE_TIMEOUT' });
  assert.deepEqual(timeoutStages, ['ble_authenticated', 'configured', 'failed']);

  const brokerFailureStages: Array<{ stage: string; failureCode?: string }> = [];
  const brokerFailureClient = new VoicecanDeviceClient({
    provisioningToken: 'grant',
    broker: {
      claim: async () => ({ provisioningSessionId: 'provision_3', continuationToken: 'continue_3', deviceId: 'dev_3', rawToken: new Uint8Array(32), wssUrl: 'ws://device.test/device/v1/ws' }),
      reportProgress: async ({ stage, failureCode }) => { brokerFailureStages.push({ stage, ...(failureCode ? { failureCode } : {}) }); },
      waitForOnline: async () => { throw new Error('DEVICE_AUTH_FAILED: authentication failed'); },
    },
    protocol: client.protocol,
    transport: client.transport,
  });
  const brokerFailureDevice = await brokerFailureClient.requestDevice();
  await assert.rejects(brokerFailureDevice.provision({ wifi: { ssid: 'test', password: 'secret', encryption: 'wpa2' } }), (error: unknown) => {
    assert.ok(error instanceof DeviceSdkError);
    assert.equal(error.code, 'DEVICE_AUTH_FAILED');
    assert.match(error.message, /^Device binding failed\nStage: waiting_server\nError: DEVICE_AUTH_FAILED: authentication failed$/);
    return true;
  });
  assert.deepEqual(brokerFailureStages, [{ stage: 'ble_authenticated' }, { stage: 'configured' }, { stage: 'failed', failureCode: 'DEVICE_AUTH_FAILED' }]);
});

test('transfer-out seals the old credential to the browser and requires non-erasing ACK', async () => {
  const rawToken = Uint8Array.from({ length: 32 }, (_, index) => index + 1); let authenticated: Uint8Array | undefined; let eraseUserData: boolean | undefined; let completed: Record<string, unknown> | undefined;
  const client = new VoicecanDeviceClient({
    provisioningToken: 'unused',
    broker: { claim: async () => { throw new Error('unused'); }, reportProgress: async () => undefined, waitForOnline: async () => false },
    protocol: {
      compatibilityReport: () => ({ status: 'blocked', reasons: ['FIRMWARE_RANGE_NOT_VERIFIED'] }),
      createSession: async () => ({
        authenticate: async (token) => { authenticated = Uint8Array.from(token); },
        syncTime: async () => undefined,
        getInfo: async () => ({ manufacturer: 'Voicecan', serialNumber: 'CAPSO-XFER', model: 'CAPSO', firmwareVersion: 'v0.5.3' }),
        getStatus: async () => ({ batteryPercent: 80, recording: false, wifiConfigured: true }),
        unbind: async (erase = false) => { eraseUserData = erase; },
        configureWifi: async () => undefined,
        configureServer: async () => undefined,
        startRecording: async () => ({ sessionId: 1 }),
        stopRecording: async () => undefined,
        listFiles: async () => ({ files: [], cursor: null }),
        close: async () => undefined,
      }),
    },
    transport: { supported: () => true, requestDevice: async () => ({ exchange: async () => new Uint8Array(), close: async () => undefined }) },
  });
  const selected = await client.requestDevice();
  const result = await selected.transferOut({
    transferToken: 'transfer.grant',
    broker: {
      claim: async ({ publicKeyJwk }) => {
        const publicKey = await crypto.subtle.importKey('jwk', publicKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
        const sealed = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawToken);
        return { transferSessionId: 'transfer-1', continuationToken: 'continue-1', deviceId: 'device-1', manufacturer: 'Voicecan', serialNumber: 'CAPSO-XFER', sealedDeviceToken: Buffer.from(sealed).toString('base64'), algorithm: 'RSA-OAEP-256' };
      },
      complete: async (input) => { completed = input; },
    },
  });
  assert.deepEqual(authenticated, rawToken);
  assert.equal(eraseUserData, false);
  assert.equal(completed?.result, 'ack');
  assert.deepEqual(result, { deviceId: 'device-1', recordingsErased: false });
  assert.equal(client.state, 'released');
});
