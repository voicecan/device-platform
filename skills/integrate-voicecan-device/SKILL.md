---
name: integrate-voicecan-device
description: Compatibility workflow for deploying, integrating, verifying, and diagnosing Voicecan Device Platform and fixture consumers. Use for existing Docker/private-Node deployments, signed file events, Node/Python SDK integration, or legacy end-to-end integration requests; use the focused voicecan-install, voicecan-configure, voicecan-bind-device, voicecan-create-application, voicecan-connect-mcp, and voicecan-operate skills for new AI-first workflows.
---

# Integrate Voicecan Device

Deploy only the independent `device-platform`; never connect it to Voicecan `main-service`, its database, or its accounts.

## Workflow

1. For a normal local installation, use the `voicecan-install` Skill and the npm `onboard` flow. If the user asks for a repository-managed deployment, present exactly two choices and wait for the user to explicitly select one before preflight: **Docker + Compose v2** or **private Node.js runtime**. Do not infer or default from host capabilities. Read [references/installation-methods.md](references/installation-methods.md).
2. Inspect the target repository, `.gitignore`, occupied ports, and existing service layout. Run `node scripts/preflight.mjs --method docker` or `--method node` only after the user selects the method.
3. For Docker, use the public `main` release's `install.sh`; for private Node.js, use its separate `install-node.sh`. Never substitute one entry point for the other. Read [references/edge-profile.md](references/edge-profile.md). Read [references/storage-drivers.md](references/storage-drivers.md) when choosing storage.
4. Require the operator to provide the stable domain/TLS route and data directory. Do not change DNS, firewalls, cloud storage, or reverse proxies without explicit permission.
5. For a generated Docker consumer deployment, run `node scripts/init-deployment.mjs --target <directory> --dry-run`, inspect its proposed files, then rerun without `--dry-run`. Never run this Docker-only initializer for a private-Node selection.
6. Verify the selected release/runtime or image digest, run the explicit migration, and start the service. Do not rely on startup migrations.
7. If setup is pending, run `voicecan-device setup open`. Never ask for, generate, read, print, transmit, or store the setup token or administrator password. Continue only after the user says setup is complete.
8. Create a distinct least-privilege Application for each consumer through `voicecan-device app create`; create credentials as owner-only Secret References. Keep real values out of commands, chat, and committed files.
9. Integrate Node with `@voicecan/server-client` or Python with `voicecan-device`. Read [references/events.md](references/events.md) before implementing webhook verification and idempotency; read [references/api.md](references/api.md) for client boundaries.
10. Run `node scripts/doctor.mjs --url <server-url> --wss-url <device-wss-url> --core-lock <path-to-core-artifacts.lock.json>` and `node scripts/smoke-test.mjs --url <server-url>`. The doctor validates the minimum Node release, HTTPS/WSS policy, the WSS certificate, health endpoints, and the pinned protocol-runtime digest/ABI. Use fixture events before any real device or external message.
11. Report the selected installation method, created files, exact image/runtime version and digest, service URLs, rollback steps, tests run, and manual work. Report physical V1.2 BLE/WSS and storage matrices as unverified until their hardware/infrastructure reports exist.

## Safety constraints

- Binding automation may prepare parameters, open the browser, and observe server state, but the user must perform the WebBluetooth selection. Do not auto-unbind, transfer, erase, update firmware, install certificates, or send real messages.
- Do not expose setup/Admin UI on an untrusted public interface. Use loopback, private network, VPN, or a controlled reverse proxy.
- Do not put raw Device Tokens, Group API Tokens, webhook secrets, Wi-Fi passwords, or setup tokens in commands, diffs, logs, committed files, or chat.
- Do not claim `private_ca_ip`, real-device V1.2, S3 direct, or relay verification without the corresponding compatibility/integration report.
- Treat `file.synced` delivery as at-least-once. Verify the raw body signature, enforce timestamp tolerance, deduplicate event IDs, and download content with group authentication.
- Preserve user files. Generate into a new directory or fail on collisions; do not mutate an existing application until its framework and routes have been inspected.

## Diagnosis

Read [references/troubleshooting.md](references/troubleshooting.md). Check in this order: readiness and setup state, TLS/DNS and WSS upgrade, group/token scope, device ownership and credential epoch, file state, storage capacity, upload ticket expiry, event delivery, then consumer idempotency. Keep wire frames and credentials out of diagnostics.
