# Production Helm profile

This chart runs two or more stateless Device Server Pods against PostgreSQL 16+ and immutable S3 storage. It never mounts SQLite or a shared recording filesystem. The pre-install/pre-upgrade migration Job takes a PostgreSQL advisory lock; the Deployment starts only after the hook succeeds. Images must be pinned by `image.digest`.

Create `existingSecret` through the cluster's reviewed secret manager. It must expose these environment keys:

- `VOICECAN_DATABASE_URL`
- `VOICECAN_CONNECT_WEB_URL` through `deviceConnectUrl` (the independently deployed HTTPS connector)
- `VOICECAN_SETUP_TOKEN` while initial setup is pending
- `VOICECAN_MASTER_KEYRING_JSON`
- `VOICECAN_GROUP_TOKEN_PEPPER`
- `VOICECAN_S3_REGION`, `VOICECAN_S3_BUCKET`, `VOICECAN_S3_ACCESS_KEY_ID`, `VOICECAN_S3_SECRET_ACCESS_KEY`
- optional `VOICECAN_S3_ENDPOINT` and `VOICECAN_S3_FORCE_PATH_STYLE`

Do not commit secret values or pass them as shell arguments. TLS terminates at the selected Ingress; verify WSS Upgrade and disable request/response buffering. PostgreSQL PITR, S3 versioning/object-lock policy, NetworkPolicy, workload identity, monitoring rules, and a restore drill remain operator-owned release gates.

Render and review before applying:

```sh
helm lint deploy/helm/voicecan-device-platform --set image.digest=sha256:REVIEWED_DIGEST
helm template voicecan-device deploy/helm/voicecan-device-platform --set image.digest=sha256:REVIEWED_DIGEST
```
