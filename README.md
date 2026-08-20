# Voicecan Device Platform

[中文](README.zh-CN.md)

Voicecan Device Platform is a self-hosted platform for connecting Voicecan-compatible devices, managing recordings, and giving applications secure access to device data. It can run at the edge, on a private server, or as a containerized service without depending on Voicecan accounts, family services, model services, or the existing business API.

## What you can do

- **Connect devices** — provision, claim, monitor, and control devices through a browser, WebSocket, or nearby Bluetooth connection.
- **Manage recordings** — discover recordings, synchronize files reliably, resume interrupted transfers, and keep immutable file history.
- **Control access** — organize users and devices into Groups, issue scoped application credentials, and review an audit trail of administrative activity.
- **Build applications** — use REST, TypeScript, Python, MCP, Webhooks, or the reusable Device Connect Web to connect your own products.
- **Run device operations** — manage local firmware packages, perform OTA updates, inspect device status, and operate through Admin or the CLI.
- **Choose storage** — use local files for an edge installation or connect an object-storage-backed deployment for shared workloads.
- **Operate with confidence** — use backups, restore tools, quotas, delivery retries, dead-letter inspection, health checks, and metrics as part of daily operations.

## Main surfaces

| Surface | Use it for |
| --- | --- |
| Admin | Setup, users, Groups, applications, devices, recordings, firmware, Webhooks, and operational tools |
| Device Connect Web | Public browser-based device provisioning and connection flows |
| REST API | Integrate devices, recordings, applications, permissions, and Webhooks into your product |
| TypeScript / Python clients | Build server-side and automation workflows with typed client libraries |
| MCP | Connect an AI assistant or automation tool to service status, applications, and device workflows |
| CLI | Install, configure, diagnose, back up, restore, and operate a self-hosted instance |

## Installation options

| Option | Best for |
| --- | --- |
| npm + `onboard` | A quick local Edge installation with a user-level service |
| Docker + Compose | A repeatable server or private-network deployment |
| Native Node runtime | A host installation without Docker |
| Source checkout | Development and customization |

Choose one installation method for each data directory. See [installation and background services](docs/installation/README.md) for the detailed setup guides.

## Quick start

### Local Edge installation

Requirements: Node.js `>=24.15.0 <25`, npm, and a private persistent data directory.

```sh
npm install --global @voicecan/device-platform@1.0.1
voicecan-device onboard
```

The onboarding flow creates the local Profile, prepares the database, starts the service, waits for readiness, and opens Admin. Use these commands to inspect the service afterwards:

```sh
voicecan-device service status --output json
voicecan-device doctor --output json
```

### Docker installation

Install curl, Git, Docker Engine, and Docker Compose v2, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install.sh | bash
```

The installer prepares the service and opens the local Admin setup flow. For an existing installation, follow the [version and migration guide](docs/versioning-and-migrations.md).

## One-prompt AI integration

Copy the prompt below into your AI coding or automation assistant to install the platform and connect an application through its public interfaces:

```text
You are integrating Voicecan Device Platform from https://github.com/voicecan/device-platform into the current environment.

Use the current user request as the integration goal. Before acting, read and follow the repository Skills that match the task:

https://github.com/voicecan/device-platform/blob/main/skills/voicecan-install/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-configure/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-bind-device/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-create-application/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-connect-mcp/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-operate/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/integrate-voicecan-device/SKILL.md

Inspect the environment and any existing installation first. Use only the public installation flow and public REST, SDK, Webhook, and MCP interfaces. Preserve existing data and configuration. Follow the selected Skills for dry runs, approvals, credentials, device actions, verification, and reporting.

Never expose or read secrets, passwords, setup tokens, Wi-Fi credentials, temporary URLs, production recordings, or private protocol sources. Ask before any destructive operation, credential creation, DNS or TLS change, cloud-storage change, or real device action. At the end, report the service URL, commands, checks, manual steps, and rollback plan without secrets.
```

## Application packages

Install the packages you need from the `@voicecan` scope:

```sh
npm install @voicecan/contracts @voicecan/server-client @voicecan/connector-runtime
```

- `@voicecan/contracts` — public data types, event names, and constants.
- `@voicecan/server-client` — REST access, event cursors, secure Recording downloads, Webhook verification, and media helpers.
- `@voicecan/connector-runtime` — durable Webhook delivery, event handling, and Recording reconciliation.

Install `@voicecan/device-platform` when you are deploying the self-hosted Server, Admin, and CLI.

## Documentation

- [Open Platform](docs/open-platform.md) — applications, permissions, credentials, REST, and administration.
- [Quickstart](docs/quickstart.md) — installation, setup, device connection, and recording synchronization.
- [Device Connect Web](docs/device-connect-web.md) — browser-based provisioning and connection.
- [Local firmware repository and OTA](docs/firmware-repository.md) — firmware packages and device updates.
- [Recording Download Grants](docs/recording-download-links.md) — secure application downloads.
- [MCP server](docs/mcp-server.md) — connect MCP clients and AI tools.
- [Operations runbook](docs/operations-runbook.md) — deployment, backup, restore, and monitoring.
- [Security model](docs/security.md) — authentication, authorization, storage, and Webhook security.

## Community and project information

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [License](LICENSE)
- [Third-party notices](NOTICE)
