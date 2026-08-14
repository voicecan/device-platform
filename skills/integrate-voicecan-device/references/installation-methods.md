# Installation methods

Ask the user to choose and wait for an explicit answer before preflight or installation:

1. **Docker + Compose v2** — isolated container runtime, persistent Compose volume, requires Git, Docker Engine, and Compose v2.
2. **Private Node.js runtime** — no Docker and no host Node.js/npm; supports macOS/Linux x64/arm64, downloads the exact runtime from `node-runtime.lock`, and enforces its SHA-256.

Do not choose based on detected tools. Tool detection may explain whether the selected method is currently available, but changing methods requires another explicit user decision.

## Docker entry point

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install.sh | bash
```

Use only `install.sh`. It builds the release image, runs the explicit Compose migration, starts the loopback service, and waits for readiness. Do not run the private-Node installer or install host Node.js.

## Private Node.js entry point

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install-node.sh | bash
```

Use only `install-node.sh`. It installs the repository-locked Node runtime under the installation directory, verifies the archive SHA-256, runs `npm ci --ignore-scripts`, verifies the bundled protocol runtime, builds, migrates explicitly, prunes development dependencies, and configures a user-level systemd/launchd service when available. Never use the user's `node`, `npm`, nvm, Homebrew Node, or global packages as a substitute.

Both entry points are initial-install only and refuse to overwrite an existing installation. Follow the versioned backup/migration/rollback guide for upgrades.
