import { createHash } from 'node:crypto';
import type {
  DeviceCapabilityManifest,
  PublicCommand,
  RecordingFile,
  RecordingMediaDescriptor,
  RecordingTiming,
} from '@voicecan/contracts';

type Row = Record<string, unknown>;

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function reviewedRecordingMedia(device: Row): RecordingMediaDescriptor {
  const model = nullableString(device.model)?.toUpperCase();
  const firmware = nullableString(device.firmware_version);
  if (model === 'CAPSO' && firmware && /^v?0\.5\./.test(firmware)) {
    return {
      schema_version: 'recording.media.v1',
      container: 'lc3',
      codec: 'lc3',
      content_type: 'audio/lc3',
      filename_extension: 'lc3',
      sample_rate_hz: null,
      channels: null,
      bit_depth: null,
      duration_ms: null,
      encoding_profile: 'voicecan-lc3-v1',
      source: 'firmware_mapping',
    };
  }
  return { schema_version: 'recording.media.v1', container: null, codec: null, content_type: 'application/octet-stream', filename_extension: 'bin', sample_rate_hz: null, channels: null, bit_depth: null, duration_ms: null, encoding_profile: null, source: 'unknown' };
}

export function recordingMedia(row: Row): RecordingMediaDescriptor {
  return {
    schema_version: 'recording.media.v1',
    container: nullableString(row.media_container),
    codec: nullableString(row.media_codec),
    content_type: nullableString(row.media_content_type) ?? 'application/octet-stream',
    filename_extension: nullableString(row.media_filename_extension) ?? 'bin',
    sample_rate_hz: positiveInteger(row.media_sample_rate_hz),
    channels: positiveInteger(row.media_channels),
    bit_depth: positiveInteger(row.media_bit_depth),
    duration_ms: positiveInteger(row.duration_ms),
    encoding_profile: nullableString(row.encoding_profile),
    source: ['device', 'firmware_mapping', 'server_verified'].includes(String(row.media_metadata_source))
      ? row.media_metadata_source as RecordingMediaDescriptor['source']
      : 'unknown',
  };
}

export function recordingTiming(row: Row): RecordingTiming {
  const timezoneOffset = Number(row.device_timezone_offset_minutes);
  return {
    device_started_at: nullableString(row.device_started_at),
    device_ended_at: nullableString(row.device_ended_at),
    duration_ms: positiveInteger(row.duration_ms),
    device_timezone_offset_minutes: Number.isSafeInteger(timezoneOffset) && timezoneOffset >= -840 && timezoneOffset <= 840
      ? timezoneOffset
      : null,
    discovered_at: String(row.created_at),
    synced_at: nullableString(row.synced_at),
  };
}

export function mapPublicRecording(row: Row): RecordingFile {
  return {
    id: String(row.id),
    device_id: String(row.device_id),
    session_id: Number(row.session_id),
    attribute: Number(row.attribute),
    revision: Number(row.revision),
    expected_size: Number(row.expected_size),
    actual_size: row.actual_size === null ? null : Number(row.actual_size),
    sha256: nullableString(row.sha256),
    status: row.status as RecordingFile['status'],
    transport: nullableString(row.transport),
    error_code: nullableString(row.error_code),
    media: recordingMedia(row),
    timing: recordingTiming(row),
    source_firmware_version: nullableString(row.source_firmware_version),
    resource_version: Number(row.resource_version ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    synced_at: nullableString(row.synced_at),
    legal_hold: Boolean(row.legal_hold),
    legal_hold_reason: nullableString(row.legal_hold_reason),
    deletion_status: row.deletion_status as RecordingFile['deletion_status'],
    deletion_requested_at: nullableString(row.deletion_requested_at),
    object_deleted_at: nullableString(row.object_deleted_at),
  };
}

export function recordingEventFacts(row: Row): Record<string, unknown> {
  return {
    media: recordingMedia(row),
    timing: recordingTiming(row),
    source_firmware_version: nullableString(row.source_firmware_version),
    resource_version: Number(row.resource_version ?? 1),
  };
}

export function recordingFilename(row: Row): string {
  return `${String(row.id)}.${recordingMedia(row).filename_extension}`;
}

function capabilityBody(device: Row): Omit<DeviceCapabilityManifest, 'capability_version' | 'changed_at'> {
  const active = device.claim_status === undefined || device.claim_status === 'active';
  const media = reviewedRecordingMedia(device);
  const mediaProfiles = media.encoding_profile ? [media.encoding_profile] : [];
  const recordingSupported = active && mediaProfiles.length > 0;
  return {
    schema_version: 'device.capabilities.v1',
    device_id: String(device.id),
    model: nullableString(device.model),
    firmware_version: nullableString(device.firmware_version),
    source: recordingSupported ? 'platform_reviewed' : 'unknown',
    recording: { supported: recordingSupported, media_profiles: mediaProfiles, max_duration_seconds: null },
    sync: { manual_trigger: active, inventory: active },
    commands: active ? ['recording.sync'] : [],
    unknown_capabilities: [...(mediaProfiles.length ? [] : ['recording.media_profiles']), 'recording.max_duration_seconds'],
  };
}

export function capabilityVersion(device: Row): `sha256:${string}` {
  const { device_id: _deviceId, ...stableBody } = capabilityBody(device);
  return `sha256:${createHash('sha256').update(JSON.stringify(stableBody)).digest('hex')}`;
}

export function deviceCapabilities(device: Row): DeviceCapabilityManifest {
  const body = capabilityBody(device);
  return {
    ...body,
    capability_version: capabilityVersion(device),
    changed_at: nullableString(device.capability_changed_at),
  };
}

export function mapPublicCommand(row: Row): PublicCommand {
  const status = row.status === 'canceled' ? 'failed' : row.status as PublicCommand['status'];
  let control: PublicCommand['control'] = null;
  if (row.kind !== 'sync' && row.kind !== 'device.ota') {
    try { control = JSON.parse(String(row.payload_json ?? '{}')) as PublicCommand['control']; } catch { control = null; }
  }
  return {
    id: String(row.id),
    type: row.kind === 'sync' ? 'recording.sync' : `device.${String(row.kind).replace(/^device\./, '')}` as PublicCommand['type'],
    control,
    device_id: String(row.device_id),
    status,
    idempotency_key: String(row.idempotency_key ?? ''),
    requested_at: String(row.created_at),
    dispatched_at: nullableString(row.dispatched_at),
    started_at: nullableString(row.started_at),
    completed_at: nullableString(row.completed_at),
    expires_at: String(row.deadline_at),
    result_code: nullableString(row.result_code),
    error_code: nullableString(row.error_code),
    resource_version: Number(row.resource_version ?? 1),
  };
}
