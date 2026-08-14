---
name: voicecan-operate
description: Inspect and operate an installed Voicecan Device Platform safely. Use for service status, logs, readiness, Doctor, profiles, devices, Applications, backups, migration, key rotation, or troubleshooting a running local instance.
---

# Operate Voicecan

1. Start with `voicecan-device capabilities --output json` and `service status --output json`.
2. Run `doctor --output json` before changing state. Use `service logs` to obtain the platform-native log command.
3. Use JSON commands instead of scraping text. Respect `next_actions`, stable error codes, and command risk metadata.
4. Run migrations explicitly while coordinating lifecycle; `serve` never migrates.
5. Use dry-run for uninstall, configuration, binding, Application, and MCP preparation wherever supported.

Offline backup, restore, password recovery, and key rotation require the service to be stopped. Never delete data, unbind/transfer hardware, rotate credentials, or expose secrets without explicit authorization.
