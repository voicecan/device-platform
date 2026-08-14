# Installation and persistent operation

[中文](README.zh-CN.md)

## Recommended npm installation

Requirements: Node.js `>=24.15 <25` and npm.

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npm install --global @voicecan/device-platform@1.0.1
voicecan-device onboard
```

Onboarding writes a stable `default` Profile, explicitly migrates its SQLite database, installs a current-user service, starts it, waits for `/health/ready`, opens Admin, and exits. Use `--profile <name>` for isolated installations and `--no-open` on a headless host.

Profile roots are under XDG data on Linux, Application Support on macOS, and `%LOCALAPPDATA%\Voicecan\DevicePlatform` on Windows. Set `VOICECAN_HOME` to override the root. Environment variables override Profile values for the current process.

## Lifecycle

```bash
voicecan-device service status --output json
voicecan-device service restart --output json
voicecan-device service logs
voicecan-device doctor --output json
```

Linux uses a systemd user unit, macOS uses a LaunchAgent, and Windows uses a current-user Scheduled Task. Service definitions call a stable Profile wrapper. When onboarding runs from an `npx` cache, it first materializes the runtime into the Profile so the service does not depend on that cache path.

`serve` is foreground-only and never migrates. `init` is a compatibility alias for `onboard`; `init --foreground` retains the earlier development behavior.

## First setup

`onboard` opens the local Admin page. Complete setup there. Automation must not read or print the setup token or administrator password. On headless systems, use `voicecan-device setup open` from a machine with controlled access to the Admin route.

## Other deployment methods

Docker/Compose and the repository's private-Node installer remain supported, separate lifecycle choices. Do not layer them over an npm/native Profile or share a writable data directory between managers. Production PostgreSQL/S3 deployments continue to require the reviewed deployment and migration runbooks.

## AI installation

Use `voicecan-device capabilities --output json` before automation. Preview onboarding with `voicecan-device onboard --dry-run --output json`. See [AI automation](ai-automation.md).
