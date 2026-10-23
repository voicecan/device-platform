import { loadBrowserPrivateCore } from '@voicecan/device-core/browser';
import { VoicecanProvisionerElement, registerVoicecanElements } from '@voicecan/device-ui';
import { VoicecanDeviceClient, WebBluetoothTransportFactory, type BluetoothDeviceHandle, type DeviceTransport } from '@voicecan/device-web';
export type { BluetoothDeviceHandle } from '@voicecan/device-web';
import type { ProvisioningBroker, ProvisioningResult } from '@voicecan/device-web';
import type { DeviceControl, DeviceInfo, DeviceStatus, FirmwareInstallResult, FirmwarePackage, SemanticProtocolSession, WifiConfiguration } from '@voicecan/device-core';
import type { DeviceConnectLocale } from './protocol.js';

export * from './protocol.js';
export type { DeviceControl } from '@voicecan/device-core';

export type BoundDeviceMaintenance = {
  info: DeviceInfo;
  device: BluetoothDeviceHandle;
  deviceName?: string;
  status: DeviceStatus;
  refresh(): Promise<DeviceStatus>;
  control(input: DeviceControl): Promise<DeviceStatus>;
  configureWifi(input: WifiConfiguration): Promise<DeviceStatus>;
  configureServer(wssUrl: string): Promise<void>;
  installFirmware(input: FirmwarePackage, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<FirmwareInstallResult>;
  close(): Promise<void>;
};

export async function connectBoundDevice(input: { rawToken: Uint8Array; expectedSerialNumber: string; coreModuleUrl: string; bleServiceUuid?: string; signal?: AbortSignal; onDisconnected?: () => void; device?: BluetoothDeviceHandle; deviceId?: string; deviceName?: string; skipTimeSync?: boolean; allowPrompt?: boolean; onStage?: (stage: 'load_sdk' | 'select_device' | 'authenticate' | 'read_status' | 'reconnect') => void }): Promise<BoundDeviceMaintenance> {
  input.onStage?.('load_sdk');
  const protocol = await loadBrowserPrivateCore(() => import(/* @vite-ignore */ input.coreModuleUrl));
  const factory = new WebBluetoothTransportFactory({
    ...(input.onDisconnected ? { onDisconnected: input.onDisconnected } : {}),
    advertisedServiceUuid: input.bleServiceUuid ?? '00001a10-0000-1000-8000-00805f9b34fb',
    serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb', writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb', notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
  });
  let transport: DeviceTransport;
  if (input.device) {
    input.onStage?.('reconnect');
    transport = await factory.connectDevice(input.device);
  } else if (input.deviceId || input.deviceName) {
    input.onStage?.('reconnect');
    const known = await factory.findDevice({ id: input.deviceId, name: input.deviceName });
    if (known) transport = await factory.connectDevice(known);
    else if (input.allowPrompt === false) throw new Error('BLE_DEVICE_NOT_FOUND');
    else { input.onStage?.('select_device'); transport = await factory.requestDevice(); }
  } else {
    input.onStage?.('select_device');
    transport = await factory.requestDevice();
  }
  const serverToken = input.rawToken.slice();
  let session: SemanticProtocolSession | undefined;
  try {
    input.onStage?.('authenticate');
    session = await protocol.createSession(transport); await session.authenticate(input.rawToken, input.signal);
    const info = await session.getInfo(input.signal);
    if (info.serialNumber !== input.expectedSerialNumber) throw new Error(`BLE_DEVICE_MISMATCH: Expected ${input.expectedSerialNumber}, selected ${info.serialNumber}`);
    if (!input.skipTimeSync) await session.syncTime({ unixTimeSeconds: Math.floor(Date.now() / 1_000), timezoneOffsetHours: Math.max(-12, Math.min(14, Math.trunc(-new Date().getTimezoneOffset() / 60))) }, input.signal);
    input.onStage?.('read_status');
    let status = await session.getStatus(input.signal); const activeSession = session;
    const refresh = async (): Promise<DeviceStatus> => { status = await activeSession.getStatus(); return status; };
    return {
      info, status, device: transport.device!, ...(transport.deviceName ? { deviceName: transport.deviceName } : {}), refresh,
      control: async (control): Promise<DeviceStatus> => {
        if (control.kind === 'auto_shutdown') await activeSession.setAutoShutdown(control.interval);
        else if (control.kind === 'usb' || control.kind === 'privacy' || control.kind === 'earphone_recording') await activeSession.setFeature(control.kind, control.enabled);
        else if (control.kind === 'power') await activeSession.power(control.action);
        else await activeSession.factoryReset(control.scope);
        if (control.kind === 'power' || control.kind === 'factory_reset') return status;
        return refresh();
      },
      configureWifi: async (configuration): Promise<DeviceStatus> => { await activeSession.configureWifi(configuration); return refresh(); },
      configureServer: async (wssUrl): Promise<void> => { await activeSession.configureServer({ wssUrl, token: serverToken }); },
      installFirmware: async (firmware, onProgress, signal): Promise<FirmwareInstallResult> => {
        const result = await activeSession.installFirmware(firmware, onProgress, signal);
        if (result === 'validated') await activeSession.power('reboot', signal);
        return result;
      },
      close: async () => { try { await activeSession.close(); } finally { serverToken.fill(0); } },
    };
  } catch (error) { serverToken.fill(0); if (session) await session.close().catch(() => undefined); else await transport.close().catch(() => undefined); throw error; }
}

export async function mountDeviceConnector(input: {
  mount: HTMLElement;
  broker: ProvisioningBroker;
  locale: DeviceConnectLocale;
  coreModuleUrl: string;
  bleServiceUuid?: string;
  provisioningGrant?: string;
  compact?: boolean;
  onProvisioned?: (result: ProvisioningResult) => void;
  onError?: (error: unknown) => void;
}): Promise<{ element: VoicecanProvisionerElement; destroy(): void }> {
  registerVoicecanElements();
  const protocol = await loadBrowserPrivateCore(() => import(/* @vite-ignore */ input.coreModuleUrl));
  const transport = new WebBluetoothTransportFactory({
    advertisedServiceUuid: input.bleServiceUuid ?? '00001a10-0000-1000-8000-00805f9b34fb',
    serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb',
    writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb',
    notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb',
  });
  const client = new VoicecanDeviceClient({ provisioningToken: input.provisioningGrant ?? 'message-channel-handoff', broker: input.broker, protocol, transport });
  const element = new VoicecanProvisionerElement();
  element.client = client;
  element.locale = input.locale;
  element.compact = input.compact ?? false;
  const provisioned = (event: Event) => input.onProvisioned?.((event as CustomEvent<ProvisioningResult>).detail);
  const failed = (event: Event) => input.onError?.((event as CustomEvent).detail);
  element.addEventListener('provisioned', provisioned);
  element.addEventListener('provisionerror', failed);
  input.mount.replaceChildren(element);
  element.provisioningGrant = input.provisioningGrant ?? 'message-channel-handoff';
  return {
    element,
    destroy: () => {
      element.removeEventListener('provisioned', provisioned);
      element.removeEventListener('provisionerror', failed);
      element.remove();
    },
  };
}
