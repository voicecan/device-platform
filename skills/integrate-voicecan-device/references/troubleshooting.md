# Troubleshooting

1. Check `/health/live`, `/health/ready`, and `/api/v1/setup/status`.
2. Verify stable DNS, trusted TLS chain/SAN/time validity, WSS upgrade, URL length, and device-network reachability.
3. Verify the caller's group, membership/token revocation, scopes, Device `group_id`, and ownership epoch.
4. Inspect file status: `pending`, `syncing`, `synced`, `failed`, or `identity_conflict`. Check expected size, ticket expiry, free space, `.part` cleanup, and immutable locator.
5. Check event endpoint enablement, ownership epoch, signature secret ID, delivery attempts, consumer timestamp tolerance, and event-id ledger.
6. If protocol-runtime loading fails, run `npm run verify:core` and compare the installed manifest with `core-artifacts.lock.json`. Source installations must use the reviewed artifact committed under `vendor/`; do not fetch a separate source repository, rebuild protocol sources, or work around the dependency with a raw-command implementation.

Do not include raw frames, Wi-Fi credentials, tokens, secrets, or audio in a support bundle.
