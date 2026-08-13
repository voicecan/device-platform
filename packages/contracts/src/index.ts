export const API_VERSION = '2026-08-07';
export const PROTOCOL_ABI = 'voicecan-v1.2';
export const CONFORMANCE_HASH = 'sha256:679c97e5a4b4b0161f6df519c69a165e1ba7d9c8ae7ad02ff60b4b323ed2e166';

export type ApiSuccess<T> = {
  success: true;
  code: '';
  message: 'success';
  data: T;
  request_id: string;
};

export type ApiFailure = {
  success: false;
  code: string;
  message: string;
  request_id: string;
};

export type UserRole = 'system_admin' | 'user';
export type MembershipRole = 'group_admin' | 'member';

export const OPEN_PLATFORM_PERMISSIONS = [
  { code: 'devices:read', resource: 'devices', action: 'read', risk: 'low', description: 'Read device metadata.' },
  { code: 'devices:sync', resource: 'devices', action: 'sync', risk: 'medium', description: 'Request a reviewed device synchronization.' },
  { code: 'commands:read', resource: 'commands', action: 'read', risk: 'low', description: 'Read command state.' },
  { code: 'recordings:read', resource: 'recordings', action: 'read', risk: 'low', description: 'Read recording metadata.' },
  { code: 'recordings:download_link:create', resource: 'recordings', action: 'create_download_link', risk: 'high', description: 'Create a short-lived external recording download URL.' },
  { code: 'recordings:download_link:revoke', resource: 'recordings', action: 'revoke_download_link', risk: 'medium', description: 'Revoke a download grant created by the application.' },
  { code: 'events:read', resource: 'events', action: 'read', risk: 'low', description: 'Read device event metadata.' },
] as const;

export type OpenPlatformPermission = typeof OPEN_PLATFORM_PERMISSIONS[number]['code'];

export const OPEN_PLATFORM_PERMISSION_TEMPLATES = {
  metadata_reader: ['devices:read', 'recordings:read', 'events:read'],
  sync_operator: ['devices:read', 'devices:sync', 'commands:read', 'recordings:read', 'events:read'],
  recording_consumer: ['devices:read', 'recordings:read', 'recordings:download_link:create', 'recordings:download_link:revoke', 'events:read'],
} as const satisfies Record<string, readonly OpenPlatformPermission[]>;

export const LEGACY_PERMISSION_ALIASES = {
  'files:read': 'recordings:read',
  'sync:trigger': 'devices:sync',
} as const satisfies Record<string, OpenPlatformPermission>;

export function normalizeOpenPlatformPermissions(scopes: readonly string[]): Set<string> {
  const normalized = new Set(scopes);
  for (const [legacy, current] of Object.entries(LEGACY_PERMISSION_ALIASES)) if (normalized.has(legacy)) normalized.add(current);
  return normalized;
}

export type OpenPlatformApplicationStatus = 'active' | 'suspended' | 'archived';
export type OpenPlatformChannel = 'rest' | 'mcp_stdio' | 'mcp_remote' | 'webhook';

export type OpenPlatformApplication = {
  id: string;
  group_id: string;
  name: string;
  description: string | null;
  environment: 'development' | 'staging' | 'production';
  status: OpenPlatformApplicationStatus;
  channels: OpenPlatformChannel[];
  owner_user_id: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type RecordingDownloadLink = {
  grant_id: string;
  download_url: string;
  expires_at: string;
  purpose: 'download';
  content_length: number;
  content_type: string;
  filename: string;
  sha256: string | null;
  range_supported: boolean;
  delivery: 'external_temporary_url';
};

export type RecordingMediaDescriptor = {
  schema_version: 'recording.media.v1';
  container: string | null;
  codec: string | null;
  content_type: string;
  filename_extension: string;
  sample_rate_hz: number | null;
  channels: number | null;
  bit_depth: number | null;
  duration_ms: number | null;
  encoding_profile: string | null;
  source: 'device' | 'firmware_mapping' | 'server_verified' | 'unknown';
};

export type RecordingTiming = {
  device_started_at: string | null;
  device_ended_at: string | null;
  duration_ms: number | null;
  device_timezone_offset_minutes: number | null;
  discovered_at: string;
  synced_at: string | null;
};
export type FileStatus =
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'blocked'
  | 'failed'
  | 'identity_conflict'
  | 'canceled';

export type SetupStatus = { status: 'setup_pending' | 'ready' };

export type AuthUser = {
  id: string;
  username: string;
  display_name: string | null;
  role: UserRole;
  group_id: string | null;
  membership_role: MembershipRole | null;
};

export type Device = {
  id: string;
  display_name: string | null;
  manufacturer: string;
  sn: string;
  model: string | null;
  hardware_version: string | null;
  firmware_version: string | null;
  group_id: string;
  ownership_epoch: number;
  online: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeviceStatusSnapshot = {
  device_id: string;
  source: 'ws' | 'ble';
  record_state: number | null;
  record_mode: number | null;
  microphone_mode: number | null;
  microphone_gain_db: number | null;
  usb_state: number | null;
  wifi_state: number | null;
  wifi_mode: number | null;
  relay_state: number | null;
  privacy_mode: boolean | null;
  earphone_recording: boolean | null;
  storage_total_kb: number | null;
  storage_free_kb: number | null;
  recording_hours: number | null;
  battery_state: string | null;
  battery_percent: number | null;
  battery_temperature_c: number | null;
  battery_voltage_mv: number | null;
  work_time_seconds: number | null;
  accumulated_work_time_seconds: number | null;
  status_updated_at: string | null;
  storage_updated_at: string | null;
  battery_updated_at: string | null;
  updated_at: string;
};

export type DeviceControl =
  | { kind: 'auto_shutdown'; interval: 'never' | '15min' | '30min' | '1h' | '5h' }
  | { kind: 'usb'; enabled: boolean }
  | { kind: 'privacy'; enabled: boolean }
  | { kind: 'earphone_recording'; enabled: boolean }
  | { kind: 'power'; action: 'reboot' | 'shutdown' | 'shipmode' }
  | { kind: 'factory_reset'; scope: 'configuration' | 'recordings' | 'all' };

export type DeviceCapabilityManifest = {
  schema_version: 'device.capabilities.v1';
  device_id: string;
  model: string | null;
  firmware_version: string | null;
  capability_version: `sha256:${string}`;
  source: 'platform_reviewed' | 'unknown';
  changed_at: string | null;
  recording: {
    supported: boolean;
    media_profiles: string[];
    max_duration_seconds: number | null;
  };
  sync: {
    manual_trigger: boolean;
    inventory: boolean;
  };
  commands: Array<'recording.sync'>;
  unknown_capabilities: string[];
};

export type PublicCommandStatus = 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'expired';
export type PublicCommand = {
  id: string;
  type: 'recording.sync' | 'device.ota' | `device.${DeviceControl['kind']}`;
  control: DeviceControl | null;
  device_id: string;
  status: PublicCommandStatus;
  idempotency_key: string;
  requested_at: string;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  result_code: string | null;
  error_code: string | null;
  resource_version: number;
};

export type RecordingFile = {
  id: string;
  device_id: string;
  session_id: number;
  attribute: number;
  revision: number;
  expected_size: number;
  actual_size: number | null;
  sha256: string | null;
  status: FileStatus;
  transport: string | null;
  error_code: string | null;
  media: RecordingMediaDescriptor;
  timing: RecordingTiming;
  source_firmware_version: string | null;
  resource_version: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  legal_hold: boolean;
  legal_hold_reason: string | null;
  deletion_status: 'active' | 'requested' | 'failed' | 'object_deleted';
  deletion_requested_at: string | null;
  object_deleted_at: string | null;
};

export type EventSubscriptionFilter = {
  event_types: string[];
  device_ids?: string[];
  attributes?: number[];
};

export type OpenPlatformLifecycleEventType =
  | 'recording.discovered' | 'recording.sync_started' | 'file.synced' | 'recording.sync_failed'
  | 'recording.deleted' | 'recording.legal_hold_changed'
  | 'device.online' | 'device.offline' | 'device.capabilities_changed'
  | 'command.succeeded' | 'command.failed' | 'command.expired' | 'webhook.test';

export type DeviceEvent<T extends Record<string, unknown> = Record<string, unknown>, TType extends string = string> = {
  id: string;
  type: TType;
  api_version: typeof API_VERSION;
  created_at: string;
  data: T;
};

export type FileSyncedEvent = DeviceEvent<{
  file_id: string;
  device_id: string;
  session_id: number;
  attribute: number;
  file_size: number;
  sha256?: string;
  media: RecordingMediaDescriptor;
  timing: RecordingTiming;
  source_firmware_version: string | null;
  resource_version: number;
}, 'file.synced'>;

export type CommandTerminalEvent = DeviceEvent<{ command: PublicCommand }, 'command.succeeded' | 'command.failed' | 'command.expired'>;

export type CursorPage<T> = {
  items: T[];
  next_cursor: string | null;
};

export class VoicecanApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'VoicecanApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}
