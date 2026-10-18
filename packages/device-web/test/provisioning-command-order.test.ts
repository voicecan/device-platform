import assert from 'node:assert/strict';
import test from 'node:test';
import { VoicecanDeviceClient } from '../src/index.js';

test('Wi-Fi and server writes wait for an in-flight device status read', async () => {
  for (const configureWifi of [true, false]) {
    let statusReads = 0;
    let statusPending = false;
    let releaseStatus!: () => void;
    let statusStarted!: () => void;
    const started = new Promise<void>((resolve) => { statusStarted = resolve; });
    const events: string[] = [];
    const transport = { exchange: async () => new Uint8Array(), close: async () => undefined };
    const client = new VoicecanDeviceClient({
      provisioningToken: 'fixture-grant',
      transport: { supported: () => true, requestDevice: async () => transport },
      broker: {
        claim: async () => ({ provisioningSessionId: 'fixture-session', continuationToken: 'fixture-continuation', deviceId: 'fixture-device', rawToken: new Uint8Array(32), wssUrl: 'wss://fixture.invalid/device/v1/ws' }),
        reportProgress: async () => undefined,
        waitForOnline: async () => true,
      },
      protocol: {
        compatibilityReport: () => ({ status: 'supported', reasons: [] }),
        createSession: async () => ({
          getInfo: async () => ({ manufacturer: 'fixture', serialNumber: 'fixture-serial', model: 'fixture', hardwareVersion: 'fixture', firmwareVersion: 'fixture' }),
          authenticate: async () => undefined,
          syncTime: async () => undefined,
          getStatus: async () => {
            if (++statusReads === 2) {
              statusPending = true; events.push('status-start'); statusStarted();
              await new Promise<void>((resolve) => { releaseStatus = resolve; });
              statusPending = false; events.push('status-end');
            }
            return { batteryPercent: 80, recording: false, wifiConfigured: true };
          },
          configureWifi: async () => { if (statusPending) throw new Error('RESPONSE_MISMATCH'); events.push('wifi'); },
          configureServer: async () => { if (statusPending) throw new Error('RESPONSE_MISMATCH'); events.push('server'); },
          close: async () => undefined,
        }),
      },
    });
    const device = await client.requestDevice();
    await device.connectForProvisioning();
    const status = device.getStatus();
    await started;
    // Observe rejection immediately so the old implementation fails cleanly.
    const completion = device.completeProvisioning(configureWifi ? { wifi: { ssid: 'fixture-network', password: 'fixture-password', encryption: 'wpa2' } } : {}).then(
      (result) => ({ result }), (error: unknown) => ({ error }),
    );
    releaseStatus();
    await status;
    const outcome = await completion;
    assert.ok('result' in outcome, `binding must not overlap the status response: ${'error' in outcome ? String(outcome.error) : ''}`);
    assert.equal(outcome.result.serverStatus, 'online');
    assert.deepEqual(events, configureWifi ? ['status-start', 'status-end', 'wifi', 'server'] : ['status-start', 'status-end', 'server']);
  }
});

test('a status refresh waits until the server configuration response completes', async () => {
  let serverPending = false;
  let releaseServer!: () => void;
  let serverStarted!: () => void;
  const started = new Promise<void>((resolve) => { serverStarted = resolve; });
  const events: string[] = [];
  const transport = { exchange: async () => new Uint8Array(), close: async () => undefined };
  const client = new VoicecanDeviceClient({
    provisioningToken: 'fixture-grant',
    transport: { supported: () => true, requestDevice: async () => transport },
    broker: {
      claim: async () => ({ provisioningSessionId: 'fixture-session', continuationToken: 'fixture-continuation', deviceId: 'fixture-device', rawToken: new Uint8Array(32), wssUrl: 'wss://fixture.invalid/device/v1/ws' }),
      reportProgress: async () => undefined,
      waitForOnline: async () => true,
    },
    protocol: {
      compatibilityReport: () => ({ status: 'supported', reasons: [] }),
      createSession: async () => ({
        getInfo: async () => ({ manufacturer: 'fixture', serialNumber: 'fixture-serial', model: 'fixture', hardwareVersion: 'fixture', firmwareVersion: 'fixture' }),
        authenticate: async () => undefined,
        syncTime: async () => undefined,
        getStatus: async () => {
          if (serverPending) throw new Error('RESPONSE_MISMATCH');
          events.push('status');
          return { batteryPercent: 80, recording: false, wifiConfigured: true };
        },
        configureServer: async () => {
          serverPending = true; events.push('server-start'); serverStarted();
          await new Promise<void>((resolve) => { releaseServer = resolve; });
          serverPending = false; events.push('server-end');
        },
        close: async () => undefined,
      }),
    },
  });
  const device = await client.requestDevice();
  await device.connectForProvisioning();
  const completion = device.completeProvisioning();
  await started;
  const refresh = device.getStatus().then((result) => ({ result }), (error: unknown) => ({ error }));
  releaseServer();
  await completion;
  assert.ok('result' in await refresh);
  assert.deepEqual(events.slice(-3), ['server-start', 'server-end', 'status']);
});
