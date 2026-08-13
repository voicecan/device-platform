export const SCHEMA_VERSION = 16;

export const schemaSql = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  setup_token_hash TEXT,
  setup_token_expires_at TEXT,
  setup_completed_at TEXT,
  master_key_version INTEGER NOT NULL DEFAULT 1,
  ble_name_prefix TEXT NOT NULL DEFAULT 'CAPSO-',
  storage_max_bytes INTEGER,
  storage_warning_ratio REAL,
  storage_stop_ratio REAL,
  storage_updated_at TEXT,
  storage_updated_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('system_admin','user')),
  password_hash TEXT NOT NULL,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  role TEXT NOT NULL CHECK (role IN ('group_admin','member')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_membership_per_user ON group_memberships(user_id) WHERE active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_group_admin ON group_memberships(group_id) WHERE active = 1 AND role = 'group_admin';

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_api_tokens (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  application_id TEXT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  rotated_from_id TEXT,
  replaced_by_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS open_platform_applications (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  name TEXT NOT NULL,
  description TEXT,
  environment TEXT NOT NULL DEFAULT 'development' CHECK (environment IN ('development','staging','production')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  channels_json TEXT NOT NULL DEFAULT '["rest"]',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_collaborators (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','developer','viewer')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(application_id,user_id)
);

CREATE TABLE IF NOT EXISTS application_permission_grants (
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  permission TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(application_id,permission)
);

CREATE TABLE IF NOT EXISTS application_policies (
  application_id TEXT PRIMARY KEY REFERENCES open_platform_applications(id),
  requests_per_minute INTEGER NOT NULL DEFAULT 300,
  mcp_calls_per_minute INTEGER NOT NULL DEFAULT 60,
  sync_commands_per_hour INTEGER NOT NULL DEFAULT 60,
  download_grants_per_minute INTEGER NOT NULL DEFAULT 30,
  download_grants_per_day INTEGER NOT NULL DEFAULT 1000,
  max_active_download_grants INTEGER NOT NULL DEFAULT 20,
  download_ttl_seconds INTEGER NOT NULL DEFAULT 300,
  s3_redirect_ttl_seconds INTEGER NOT NULL DEFAULT 45,
  download_delivery_mode TEXT NOT NULL DEFAULT 'gateway' CHECK (download_delivery_mode IN ('gateway','external_object_only')),
  max_result_items INTEGER NOT NULL DEFAULT 50,
  allowed_ip_cidrs_json TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_credentials (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  kind TEXT NOT NULL CHECK (kind IN ('api_token','mcp_stdio_token','oauth_client_secret')),
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  allowed_ip_cidrs_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','leaked','revoked')),
  not_before TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  last_source_hash TEXT,
  rotated_from_id TEXT,
  replaced_by_id TEXT,
  grace_ends_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  registration_type TEXT NOT NULL DEFAULT 'pre_registered' CHECK (registration_type IN ('pre_registered','dynamic')),
  client_metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_dynamic_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  client_metadata_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  refresh_family_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  scopes_json TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  rotated_to_id TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_usage_buckets (
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  channel TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  download_grant_count INTEGER NOT NULL DEFAULT 0,
  download_consume_count INTEGER NOT NULL DEFAULT 0,
  sync_command_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(application_id,channel,bucket_start)
);

CREATE TABLE IF NOT EXISTS open_platform_api_logs (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  credential_id TEXT,
  actor_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  source_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS open_platform_security_alerts (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES open_platform_applications(id),
  credential_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  details_json TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provisioning_sessions (
  id TEXT PRIMARY KEY,
  public_token_hash TEXT NOT NULL UNIQUE,
  allowed_origin TEXT NOT NULL,
  expected_sn TEXT,
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  failed_at TEXT,
  failure_code TEXT,
  continuation_token_hash TEXT UNIQUE,
  device_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','reserved','ble_authenticated','configured','online','completed','failed')),
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  manufacturer TEXT NOT NULL,
  sn TEXT NOT NULL,
  model TEXT,
  hardware_version TEXT,
  firmware_version TEXT,
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  ownership_epoch INTEGER NOT NULL DEFAULT 1,
  credential_epoch INTEGER NOT NULL DEFAULT 1,
  claim_status TEXT NOT NULL DEFAULT 'active' CHECK (claim_status IN ('reserved','active')),
  online INTEGER NOT NULL DEFAULT 0,
  connection_epoch INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  capability_version TEXT,
  capability_changed_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(manufacturer, sn)
);

CREATE TABLE IF NOT EXISTS firmware_packages (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  hardware_version TEXT NOT NULL,
  release_channel TEXT NOT NULL CHECK (release_channel IN ('production','developer')),
  source TEXT NOT NULL CHECK (source IN ('uploaded','official')),
  release_notes TEXT NOT NULL DEFAULT '',
  package_size INTEGER NOT NULL CHECK (package_size > 0),
  checksum TEXT NOT NULL,
  crc16 INTEGER NOT NULL CHECK (crc16 BETWEEN 0 AND 65535),
  max_ble_chunk INTEGER NOT NULL DEFAULT 0 CHECK (max_ble_chunk BETWEEN 0 AND 1480),
  object_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  published_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(hardware_version, release_channel, version)
);

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  credential_epoch INTEGER NOT NULL,
  token_verifier TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('temporary','active')),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(device_id, credential_epoch)
);

CREATE TABLE IF NOT EXISTS device_status (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('ws','ble')),
  record_state INTEGER,
  record_mode INTEGER,
  microphone_mode INTEGER,
  microphone_gain_db INTEGER,
  usb_state INTEGER,
  wifi_state INTEGER,
  wifi_mode INTEGER,
  relay_state INTEGER,
  privacy_mode INTEGER,
  earphone_recording INTEGER,
  storage_total_kb INTEGER,
  storage_free_kb INTEGER,
  recording_hours INTEGER,
  battery_state TEXT,
  battery_state_code INTEGER,
  battery_percent INTEGER,
  battery_temperature_c INTEGER,
  battery_voltage_mv INTEGER,
  work_time_seconds INTEGER,
  accumulated_work_time_seconds INTEGER,
  info_updated_at TEXT,
  status_updated_at TEXT,
  storage_updated_at TEXT,
  battery_updated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_out_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  grant_token_hash TEXT NOT NULL UNIQUE,
  continuation_token_hash TEXT UNIQUE,
  allowed_origin TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL,
  credential_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','completed','failed','expired')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  failure_code TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recording_files (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  credential_epoch INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  attribute INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  expected_size INTEGER NOT NULL,
  actual_size INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,
  transport TEXT,
  force_relay INTEGER NOT NULL DEFAULT 0 CHECK (force_relay IN (0,1)),
  storage_locator TEXT,
  error_code TEXT,
  media_schema_version TEXT NOT NULL DEFAULT 'recording.media.v1',
  media_container TEXT,
  media_codec TEXT,
  media_content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  media_filename_extension TEXT NOT NULL DEFAULT 'bin',
  media_sample_rate_hz INTEGER,
  media_channels INTEGER,
  media_bit_depth INTEGER,
  duration_ms INTEGER,
  encoding_profile TEXT,
  media_metadata_source TEXT NOT NULL DEFAULT 'unknown' CHECK (media_metadata_source IN ('device','firmware_mapping','server_verified','unknown')),
  device_started_at TEXT,
  device_ended_at TEXT,
  device_timezone_offset_minutes INTEGER,
  source_firmware_version TEXT,
  resource_version INTEGER NOT NULL DEFAULT 1,
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0,1)),
  legal_hold_reason TEXT,
  legal_hold_updated_at TEXT,
  deletion_status TEXT NOT NULL DEFAULT 'active' CHECK (deletion_status IN ('active','requested','failed','object_deleted')),
  deletion_requested_at TEXT,
  deletion_requested_by TEXT,
  deletion_reason TEXT,
  object_deleted_at TEXT,
  deletion_error TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(device_id, credential_epoch, session_id, attribute, revision)
);

CREATE TABLE IF NOT EXISTS recording_download_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL REFERENCES recording_files(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  ownership_epoch INTEGER NOT NULL,
  application_id TEXT NOT NULL REFERENCES open_platform_applications(id),
  credential_id TEXT,
  oauth_token_id TEXT,
  key_version INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('download')),
  expires_at TEXT NOT NULL,
  max_requests INTEGER NOT NULL DEFAULT 1,
  request_count INTEGER NOT NULL DEFAULT 0,
  first_used_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(application_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS upload_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL REFERENCES recording_files(id),
  expected_size INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS s3_upload_attempts (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES recording_files(id),
  staging_key TEXT NOT NULL UNIQUE,
  expected_size INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  failure_code TEXT,
  final_locator TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT,
  caller_scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  deadline_at TEXT NOT NULL,
  connection_epoch INTEGER,
  error_code TEXT,
  result_code TEXT,
  dispatched_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(caller_scope, kind, idempotency_key)
);

CREATE TABLE IF NOT EXISTS event_endpoints (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  application_id TEXT REFERENCES open_platform_applications(id),
  url TEXT NOT NULL,
  secret_id TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  next_secret_id TEXT,
  next_secret_ciphertext TEXT,
  next_activates_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  event_types_json TEXT NOT NULL DEFAULT '[]',
  device_ids_json TEXT NOT NULL DEFAULT '[]',
  attributes_json TEXT NOT NULL DEFAULT '[]',
  filter_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  owner_group_id TEXT NOT NULL REFERENCES user_groups(id),
  ownership_epoch INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  endpoint_id TEXT NOT NULL REFERENCES event_endpoints(id),
  replay_namespace TEXT NOT NULL DEFAULT 'live',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  delivered_at TEXT,
  last_status_code INTEGER,
  last_error TEXT,
  claimed_by TEXT,
  claim_expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(event_id, endpoint_id, replay_namespace)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  identity_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(identity_hash, ip_hash)
);

CREATE TABLE IF NOT EXISTS event_replays (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES user_groups(id),
  endpoint_id TEXT NOT NULL REFERENCES event_endpoints(id),
  from_created_at TEXT,
  to_created_at TEXT,
  event_type TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  group_id TEXT,
  application_id TEXT,
  credential_id TEXT,
  principal_id TEXT,
  request_id TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_logs_immutable_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_immutable_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE'); END;

CREATE INDEX IF NOT EXISTS devices_group_idx ON devices(group_id, id);
CREATE INDEX IF NOT EXISTS firmware_packages_latest_idx ON firmware_packages(hardware_version,release_channel,status,created_at);
CREATE INDEX IF NOT EXISTS transfer_out_active_idx ON transfer_out_sessions(device_id, expires_at) WHERE status IN ('pending','claimed');
CREATE INDEX IF NOT EXISTS files_device_idx ON recording_files(device_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_device_idx ON events(device_id, created_at, id);
CREATE INDEX IF NOT EXISTS deliveries_pending_idx ON event_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS open_platform_applications_group_idx ON open_platform_applications(group_id,status,created_at);
CREATE INDEX IF NOT EXISTS application_credentials_app_idx ON application_credentials(application_id,status,expires_at);
CREATE INDEX IF NOT EXISTS recording_download_grants_active_idx ON recording_download_grants(application_id,expires_at,revoked_at);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_app_idx ON oauth_access_tokens(application_id,expires_at,revoked_at);
CREATE INDEX IF NOT EXISTS oauth_dynamic_clients_source_idx ON oauth_dynamic_clients(source_hash,created_at);
CREATE INDEX IF NOT EXISTS oauth_dynamic_clients_expiry_idx ON oauth_dynamic_clients(expires_at);
CREATE INDEX IF NOT EXISTS open_platform_api_logs_app_idx ON open_platform_api_logs(application_id,created_at);
`;
