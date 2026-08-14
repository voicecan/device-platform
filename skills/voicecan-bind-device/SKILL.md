---
name: voicecan-bind-device
description: Prepare, open, resume, observe, and verify Voicecan device binding with all safe parameters supplied by AI before the user selects Bluetooth. Use when binding a nearby device, choosing a device WebSocket address, recovering after refresh or a closed page, or confirming delayed server connection.
---

# Bind a Voicecan Device

1. Ensure setup is complete and the service is ready. Resolve the target Group; never guess when multiple Groups exist.
2. Run a dry run:
   `voicecan-device device bind prepare --group <id> --display-name <name> --expected-sn <sn> --server-url auto --network existing --dry-run --output json`
3. Run the same command without `--dry-run`. It opens a single-use browser flow and does not return the launch secret in JSON.
4. Tell the user only: “Select the nearby Bluetooth device.” WebBluetooth requires this user gesture. Do not ask them to re-enter Group, URL, prefix, or other prepared values.
5. Poll `voicecan-device device bind status <binding-id> --output json` or wait with `device bind wait <binding-id> --timeout 600 --output json`.

The server is authoritative. A refresh, closed page, missing callback, or configured-but-offline device does not discard the Intent. When the device later authenticates to WSS, the latest provisioning session completes and the device appears in Admin. Do not put Wi-Fi passwords in arguments, JSON, URLs, logs, or chat.
