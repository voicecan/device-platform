---
name: voicecan-install
description: Install, initialize, upgrade, or start Voicecan Device Platform as a persistent background service. Use for npm/npx installation, first-run onboarding, profile setup, systemd user services, launchd, Windows Scheduled Tasks, headless hosts, or diagnosing an installation that stops when the terminal closes.
---

# Install Voicecan

1. Require Node.js `>=24.15 <25` for the npm path. Use the repository installers only when the user explicitly chooses Docker or the private Node runtime.
2. Inspect before changing an existing installation. Never remove or move a data directory implicitly.
3. For npm, run `npm install --global @voicecan/device-platform@1.0.1`, then preview `voicecan-device onboard --dry-run --output json`.
4. Run `voicecan-device onboard --output json`. It writes a stable Profile, explicitly migrates, installs the current-user service, waits for readiness, opens Admin, and exits. Do not keep a terminal alive.
5. Treat `setup_pending` as a user action. Open Admin with `voicecan-device setup open`; never read or relay the setup token or password.
6. Verify with `voicecan-device service status --output json` and `voicecan-device doctor --output json`.

Use `voicecan-device init --foreground` only for temporary development compatibility. `serve` never runs migrations. Keep npm/native, Docker, and source lifecycles separate.
