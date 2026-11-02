import type { DeviceControl, SemanticProtocolSession } from '@voicecan/device-core';

export async function applyMaintenanceControl(session: SemanticProtocolSession, control: DeviceControl): Promise<void> {
  switch (control.kind) {
    case 'recording': await session.controlRecording(control.action); return;
    case 'recording_mode': await session.setRecordingMode(control); return;
    case 'auto_shutdown': await session.setAutoShutdown(control.interval); return;
    case 'usb': case 'privacy': case 'earphone_recording': await session.setFeature(control.kind, control.enabled); return;
    case 'power': await session.power(control.action); return;
    case 'factory_reset': await session.factoryReset(control.scope); return;
    default: { const unsupported: never = control; throw new Error(`Unsupported device control: ${String(unsupported)}`); }
  }
}
