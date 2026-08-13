import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const secret = Buffer.alloc(32, 7).toString('base64url');

test('PostgreSQL production config uses externally managed setup and encryption secrets', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-pg-config-'));
  try {
    const config = await loadConfig({
      VOICECAN_DATA_DIR: dataDir,
      VOICECAN_DATABASE_URL: 'postgresql://voicecan:secret@postgres.example.test:5432/voicecan',
      VOICECAN_SETUP_TOKEN: 'setup-token-that-is-longer-than-thirty-two-characters',
      VOICECAN_MASTER_KEYRING_JSON: JSON.stringify({ current_version: 2, keys: { '1': secret, '2': secret } }),
      VOICECAN_GROUP_TOKEN_PEPPER: secret,
      VOICECAN_STORAGE_DRIVER: 's3_direct',
      VOICECAN_S3_REGION: 'us-east-1',
      VOICECAN_S3_BUCKET: 'voicecan-test',
      VOICECAN_S3_ACCESS_KEY_ID: 'test',
      VOICECAN_S3_SECRET_ACCESS_KEY: 'test',
      VOICECAN_DOWNLOAD_DELIVERY_MODE: 'external_object_only',
      VOICECAN_DEPLOYMENT_PROFILE: 'production',
      VOICECAN_PUBLIC_BASE_URL: 'https://device.example.test',
      VOICECAN_DEVICE_WSS_URL: 'wss://device.example.test/device/v1/ws',
    });
    assert.equal(config.databaseDriver, 'postgres');
    assert.equal(config.externallyManagedKeys, true);
    assert.equal(config.masterKeyVersion, 2);
    assert.deepEqual(config.masterKey, Buffer.alloc(32, 7));
    assert.deepEqual(config.groupTokenPepper, Buffer.alloc(32, 7));
    assert.equal(config.downloadDeliveryMode, 'external_object_only');
    assert.equal(config.deploymentProfile, 'production');
    const generatedSecretFiles = (await readdir(dataDir)).filter((name) => name.endsWith('.key') || name.includes('keyring'));
    assert.deepEqual(generatedSecretFiles, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('PostgreSQL and external secret configuration fails closed', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-pg-config-invalid-'));
  try {
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DATABASE_URL: 'mysql://example.test/db' }), /postgres/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_SETUP_TOKEN: 'short' }), /32 characters/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_MASTER_KEYRING_JSON: '{}' }), /current_version/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_CONNECT_WEB_URL: 'http://nas.example.test/connect' }), /HTTPS, loopback HTTP/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_CONNECT_WEB_URL: 'https://user:secret@connect.example.test/' }), /must not contain credentials/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL: 'http://firmware.example.test/' }), /HTTPS, loopback HTTP/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DEVICE_WSS_URL: 'https://device.example.test/device/v1/ws' }), /ws:\/\/ or wss:\/\//);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DOWNLOAD_DELIVERY_MODE: 'external_object_only' }), /requires VOICECAN_STORAGE_DRIVER=s3_direct/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DEPLOYMENT_PROFILE: 'production' }), /Production profile requires/);
    await assert.rejects(loadConfig({
      VOICECAN_DATA_DIR: dataDir,
      VOICECAN_DEPLOYMENT_PROFILE: 'production',
      VOICECAN_STORAGE_DRIVER: 's3_direct',
      VOICECAN_S3_BUCKET: 'voicecan-test',
      VOICECAN_S3_ACCESS_KEY_ID: 'test',
      VOICECAN_S3_SECRET_ACCESS_KEY: 'test',
      VOICECAN_DOWNLOAD_DELIVERY_MODE: 'external_object_only',
    }), /explicit wss:\/\//);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DOWNLOAD_GRANT_MIN_TTL_SECONDS: '600', VOICECAN_DOWNLOAD_GRANT_DEFAULT_TTL_SECONDS: '300' }), /minimum <= default <= maximum/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DOWNLOAD_GRANT_MAX_TTL_SECONDS: '901' }), /between 60 and 900/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_S3_DOWNLOAD_REDIRECT_TTL_SECONDS: '46' }), /cannot exceed 45/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_OAUTH_ACCESS_TOKEN_TTL_SECONDS: '3601' }), /between 60 and 3600/);
    await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_TRUST_PROXY: 'private-network' }), /invalid trusted proxy rule/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Intranet profile explicitly permits private HTTP service and callback URLs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-intranet-config-'));
  try {
    const config = await loadConfig({
      VOICECAN_DATA_DIR: dataDir,
      VOICECAN_DEPLOYMENT_PROFILE: 'intranet',
      VOICECAN_PUBLIC_BASE_URL: 'http://192.168.50.20:8787',
      VOICECAN_CONNECT_WEB_URL: 'http://192.168.50.21/connect/',
      VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL: 'http://192.168.50.22/firmware/',
    });
    assert.equal(config.deploymentProfile, 'intranet');
    assert.equal(config.allowPrivateWebhooks, true);
    assert.equal(config.allowHttpWebhooks, true);
    assert.equal(config.publicBaseUrl, 'http://192.168.50.20:8787');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Edge config defaults to LAN WebSocket advertisement and accepts explicit WS override', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-edge-config-'));
  try {
    const automatic = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DEVICE_ADVERTISE_HOST: '192.168.50.20' });
    assert.equal(automatic.host, '0.0.0.0');
    assert.equal(automatic.deviceWssUrl, undefined);
    assert.equal(automatic.deviceAdvertiseHost, '192.168.50.20');
    assert.equal(automatic.deviceAdvertiseHosts[0], '192.168.50.20');
    assert.equal(automatic.logDirectory, join(dataDir, 'logs'));
    assert.equal(automatic.logMaxBytes, 10 * 1024 * 1024);
    assert.equal(automatic.logMaxFiles, 10);
    assert.equal(automatic.logFileEnabled, true);
    assert.equal(automatic.deviceConnectUrl, 'https://connect.voice-can.com/');
    assert.equal(automatic.officialFirmwareSourceUrl, 'https://api.voice-can.com/');
    assert.equal(automatic.officialFirmwareBaseUrl, 'https://api.voice-can.com/api/v1/public/device-firmware/');
    const configured = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DEVICE_WSS_URL: 'ws://192.168.50.21:8787/device/v1/ws', VOICECAN_CONNECT_WEB_URL: 'https://connector.example.test/pair/' });
    assert.equal(configured.deviceWssUrl, 'ws://192.168.50.21:8787/device/v1/ws');
    assert.equal(configured.deviceConnectUrl, 'https://connector.example.test/pair/');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
