# Local firmware repository and OTA

Device Platform treats firmware as an operator-controlled local artifact. A Device OTA never downloads a package from the Internet at transfer time.

## Sources

- **Custom upload** streams an `application/octet-stream` package into `VOICECAN_FIRMWARE_DIR` (default: `<VOICECAN_DATA_DIR>/firmware`). The Server computes SHA-256 while writing, fsyncs the temporary file, and atomically publishes it with its hardware version, release channel, firmware version, CRC16, and BLE chunk metadata.
- **Import official** is an explicit System Admin action. The Server reads metadata from `VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL`, downloads from that same origin without redirects, verifies the declared size and SHA-256, and stores the verified local copy. The default source is `https://api.voice-can.com/`.

The former `VOICECAN_OFFICIAL_FIRMWARE_BASE_URL` remains accepted as a compatibility fallback. New deployments should configure the source URL:

```env
VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL=https://api.voice-can.com/
# VOICECAN_FIRMWARE_DIR=/srv/voicecan/firmware
```

HTTPS is required except for loopback HTTP development sources. Credentials, query strings, and fragments are rejected. A source URL that does not already end in `/api/v1/public/device-firmware/` has that public API path appended.

## Release channels

`production` and `developer` are independent local lanes for each hardware version. Production is the default. Developer firmware is selected only when an administrator explicitly chooses that channel. Uploading or importing never changes the other lane.

The tuple `(hardware_version, release_channel, version)` is immutable. To replace a package, publish a new version. Archiving prevents a package from being selected while retaining its catalog and audit history.

## OTA paths

- **Server / WebSocket:** the Server re-reads and verifies the local file, serializes OTA against status/control/file-transfer work, serves device-requested offsets, and requests a reboot after validation.
- **Nearby BLE:** Admin obtains a memory-only maintenance credential, authenticates the selected bound device, downloads a re-verified same-origin local package, transfers device-requested chunks with progress, and requests a reboot after validation.

An interrupted in-memory OTA is failed explicitly; it is not silently resumed after a reconnect. Start a reviewed new OTA after confirming device power, proximity/network state, and the selected hardware/channel/version.

## Backup and reset

The Edge `backup create` command uses manifest schema 3 and includes the database, recording objects, keys, and `VOICECAN_FIRMWARE_DIR`; restore verifies and restores the firmware directory with the same snapshot. PostgreSQL/S3 and operator-managed backups must preserve the catalog and firmware directory together. Restoring only one side produces checksum or missing-object failures and OTA remains blocked. A full Edge reset removes the local firmware directory together with the rest of `VOICECAN_DATA_DIR` when the default path is used.

Physical-device OTA validation is still a release gate. Unit and simulator evidence does not prove bootloader, flash, power-loss, or radio behavior on every firmware/hardware combination.
