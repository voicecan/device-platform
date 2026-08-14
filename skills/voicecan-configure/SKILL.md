---
name: voicecan-configure
description: Inspect, validate, and change a Voicecan Device Platform Profile or runtime configuration. Use for ports, public URLs, device WebSocket URLs, connector URLs, profile paths, dry-run changes, service restarts, or configuration diagnostics.
---

# Configure Voicecan

1. Run `voicecan-device capabilities --output json`, then `voicecan-device config path --output json` and `config list`.
2. Preview each mutation with `voicecan-device config set <key> <value> --dry-run --output json`.
3. Apply only supported keys through `config set`; do not edit generated secrets or databases.
4. Restart the managed service after a runtime setting changes: `voicecan-device service restart --output json`.
5. Verify with `voicecan-device doctor --output json`.

Use `--profile <name>` consistently. Environment variables override Profile values for the current process. Never print `local-operator.key`, token files, passwords, or Wi-Fi credentials.
