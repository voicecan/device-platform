#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_REPOSITORY="https://github.com/voicecan/device-platform.git"
readonly DEFAULT_REF="main"
readonly DEFAULT_PORT="8787"
readonly DEFAULT_HEALTH_TIMEOUT="120"
readonly SYSTEMD_UNIT="voicecan-device-platform.service"
readonly LAUNCHD_LABEL="com.voicecan.device-platform"

repository="${VOICECAN_REPOSITORY:-$DEFAULT_REPOSITORY}"
ref="${VOICECAN_REF:-$DEFAULT_REF}"
port="${VOICECAN_PORT:-$DEFAULT_PORT}"
health_timeout="${VOICECAN_INSTALL_HEALTH_TIMEOUT:-$DEFAULT_HEALTH_TIMEOUT}"
public_base_url="${VOICECAN_PUBLIC_BASE_URL:-}"
install_dir="${VOICECAN_INSTALL_DIR:-}"
local_runtime_archive="${VOICECAN_NODE_ARCHIVE:-}"
runtime_mirror="${VOICECAN_NODE_MIRROR:-}"
install_service=true
staging_dir=""

usage() {
  cat <<'EOF'
Install Voicecan Device Platform with a private, checksummed Node.js runtime.

Usage:
  install-node.sh [options]

Options:
  --repository URL    Public Git repository URL
  --ref REF           Release branch or tag (default: main)
  --install-dir DIR   Source/runtime/config/data directory
  --port PORT         Loopback HTTP port (default: 8787)
  --public-url URL    Public base URL written to .env
  --no-service        Build and migrate without installing a background service
  -h, --help          Show this help

The same settings can be supplied with VOICECAN_REPOSITORY, VOICECAN_REF,
VOICECAN_INSTALL_DIR, VOICECAN_PORT, and VOICECAN_PUBLIC_BASE_URL.

The user does not need Node.js or npm. The installer downloads the exact runtime
from node-runtime.lock, verifies its SHA-256, and runs only that private runtime.
VOICECAN_NODE_MIRROR may select an HTTPS mirror; VOICECAN_NODE_ARCHIVE may point
to a pre-downloaded archive. The locked SHA-256 is always enforced.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$staging_dir" && -d "$staging_dir" ]]; then
    rm -rf -- "$staging_dir"
  fi
}
trap cleanup EXIT

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$path" | awk '{print $NF}'
  else
    fail "sha256sum, shasum, or openssl is required"
  fi
}

while (($# > 0)); do
  case "$1" in
    --repository)
      (($# >= 2)) || fail "--repository requires a value"
      repository="$2"
      shift 2
      ;;
    --ref)
      (($# >= 2)) || fail "--ref requires a value"
      ref="$2"
      shift 2
      ;;
    --install-dir)
      (($# >= 2)) || fail "--install-dir requires a value"
      install_dir="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || fail "--port requires a value"
      port="$2"
      shift 2
      ;;
    --public-url)
      (($# >= 2)) || fail "--public-url requires a value"
      public_base_url="$2"
      shift 2
      ;;
    --no-service)
      install_service=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

if [[ -z "$install_dir" ]]; then
  [[ -n "${HOME:-}" ]] || fail "HOME is unset; pass --install-dir"
  install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/voicecan-device-platform"
fi

case "$install_dir" in
  /*) ;;
  *) install_dir="$PWD/$install_dir" ;;
esac

[[ "$install_dir" != "/" && "$install_dir" != *$'\n'* ]] || fail "invalid install directory"
[[ "$repository" != -* && "$repository" != *$'\n'* ]] || fail "invalid repository URL"
[[ "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || fail "invalid Git ref"
[[ "$ref" != *..* && "$ref" != *@\{* ]] || fail "unsafe Git ref"
[[ "$port" =~ ^[0-9]+$ ]] || fail "port must be an integer"
((10#$port >= 1 && 10#$port <= 65535)) || fail "port must be between 1 and 65535"
[[ "$health_timeout" =~ ^[0-9]+$ ]] || fail "VOICECAN_INSTALL_HEALTH_TIMEOUT must be an integer"
((10#$health_timeout >= 10 && 10#$health_timeout <= 600)) || fail "health timeout must be between 10 and 600 seconds"
[[ "$public_base_url" != *$'\n'* ]] || fail "public URL must not contain a newline"
if [[ -n "$public_base_url" ]]; then
  [[ "$public_base_url" =~ ^https?://[^[:space:]#]+$ ]] || fail "public URL must be an HTTP(S) URL without spaces or fragments"
fi

for command_name in git tar awk; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
if [[ -z "$local_runtime_archive" ]]; then
  command -v curl >/dev/null 2>&1 || fail "curl is required to download the locked Node.js runtime"
else
  [[ -f "$local_runtime_archive" ]] || fail "VOICECAN_NODE_ARCHIVE does not exist: $local_runtime_archive"
fi

if [[ -e "$install_dir" ]]; then
  if [[ -d "$install_dir/.git" && -f "$install_dir/.env" && -f "$install_dir/.git/voicecan-node-install-complete" ]]; then
    installed_commit="$(git -C "$install_dir" rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown')"
    installed_runtime="$(cat "$install_dir/.git/voicecan-node-runtime-version" 2>/dev/null || printf 'unknown')"
    printf 'Voicecan Device Platform is already installed with its private Node.js runtime.\n'
    printf 'Directory: %s\nCommit:    %s\nNode:      %s\n' "$install_dir" "$installed_commit" "$installed_runtime"
    printf 'This installer never overwrites an existing installation. Follow the release migration guide to upgrade.\n'
    exit 0
  fi
  fail "install directory exists but is not a completed private-Node installation; inspect it before following the recovery/upgrade guide: $install_dir"
fi

case "$(uname -s)" in
  Darwin) runtime_os="darwin" ;;
  Linux) runtime_os="linux" ;;
  *) fail "native Node.js installation supports only macOS and Linux; use the Docker installer" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) runtime_arch="arm64" ;;
  x86_64|amd64) runtime_arch="x64" ;;
  *) fail "unsupported CPU architecture: $(uname -m); use the Docker installer" ;;
esac

install_parent="$(dirname "$install_dir")"
mkdir -p -- "$install_parent"
staging_dir="$(mktemp -d "$install_parent/.voicecan-device-platform-node.XXXXXX")"

printf 'Cloning %s (%s)...\n' "$repository" "$ref"
git clone --quiet --depth 1 --single-branch --branch "$ref" -- "$repository" "$staging_dir/repository"

for required_path in package.json package-lock.json .env.example core-artifacts.lock.json node-runtime.lock; do
  [[ -f "$staging_dir/repository/$required_path" ]] || fail "release is missing $required_path"
done

runtime_lock="$staging_dir/repository/node-runtime.lock"
lock_format="$(awk -F= '$1 == "format" { print $2 }' "$runtime_lock")"
runtime_version="$(awk -F= '$1 == "node_version" { print $2 }' "$runtime_lock")"
locked_base_url="$(awk -F= '$1 == "base_url" { sub(/^[^=]*=/, ""); print }' "$runtime_lock")"
runtime_record="$(awk -F'|' -v os="$runtime_os" -v arch="$runtime_arch" '$1 == os && $2 == arch { print $3 "|" $4 }' "$runtime_lock")"
[[ "$lock_format" == "1" ]] || fail "unsupported node-runtime.lock format"
[[ "$runtime_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid locked Node.js version"
[[ -n "$runtime_record" ]] || fail "node-runtime.lock has no entry for $runtime_os-$runtime_arch"
IFS='|' read -r runtime_archive expected_sha256 <<< "$runtime_record"
[[ "$runtime_archive" =~ ^node-v[0-9]+\.[0-9]+\.[0-9]+-[a-z0-9]+-[a-z0-9]+\.tar\.gz$ ]] || fail "invalid runtime archive name in lock"
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "invalid runtime SHA-256 in lock"

download_base="${runtime_mirror:-$locked_base_url}"
if [[ -z "$local_runtime_archive" ]]; then
  [[ "$download_base" =~ ^https://[^[:space:]#]+$ ]] || fail "Node.js runtime mirror must use HTTPS"
fi
runtime_download="$staging_dir/$runtime_archive"
if [[ -n "$local_runtime_archive" ]]; then
  printf 'Using pre-downloaded Node.js %s archive...\n' "$runtime_version"
  cp -- "$local_runtime_archive" "$runtime_download"
else
  printf 'Downloading private Node.js %s runtime for %s-%s...\n' "$runtime_version" "$runtime_os" "$runtime_arch"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "$download_base/$runtime_archive" --output "$runtime_download"
fi

actual_sha256="$(sha256_file "$runtime_download")"
[[ "$actual_sha256" == "$expected_sha256" ]] || fail "Node.js runtime SHA-256 mismatch"
printf 'Verified Node.js runtime SHA-256: %s\n' "$actual_sha256"

mkdir -p -- "$staging_dir/repository/runtime"
tar -xzf "$runtime_download" -C "$staging_dir/repository/runtime" --strip-components=1
rm -f -- "$runtime_download"
staged_node="$staging_dir/repository/runtime/bin/node"
staged_npm_cli="$staging_dir/repository/runtime/lib/node_modules/npm/bin/npm-cli.js"
[[ -x "$staged_node" && -f "$staged_npm_cli" ]] || fail "locked Node.js archive is missing node or npm"
[[ "$("$staged_node" --version)" == "v$runtime_version" ]] || fail "extracted Node.js version does not match node-runtime.lock"

if ! "$staged_node" -e 'const net = require("node:net"); const server = net.createServer(); server.once("error", () => process.exit(1)); server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(() => process.exit(0)));' "$port"; then
  fail "127.0.0.1:$port is already in use"
fi

node_path="$install_dir/runtime/bin/node"
npm_cli="$install_dir/runtime/lib/node_modules/npm/bin/npm-cli.js"
service_manager="none"
if [[ "$install_service" == "true" ]]; then
  case "$runtime_os" in
    linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
        unit_path="$unit_dir/$SYSTEMD_UNIT"
        [[ ! -e "$unit_path" ]] || fail "user service already exists: $unit_path"
        if [[ "$install_dir$node_path" == *['"\\%$']* ]]; then
          fail "install path contains characters unsupported by the generated systemd unit"
        fi
        service_manager="systemd"
      fi
      ;;
    darwin)
      if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$UID" >/dev/null 2>&1; then
        launchd_dir="$HOME/Library/LaunchAgents"
        launchd_path="$launchd_dir/$LAUNCHD_LABEL.plist"
        [[ ! -e "$launchd_path" ]] || fail "user service already exists: $launchd_path"
        if [[ "$install_dir" == *['<>&']* ]]; then
          fail "install path contains XML control characters unsupported by launchd"
        fi
        service_manager="launchd"
      fi
      ;;
  esac
fi

commit="$(git -C "$staging_dir/repository" rev-parse HEAD)"
if [[ -z "$public_base_url" ]]; then
  public_base_url="http://127.0.0.1:$port"
fi
data_dir="$install_dir/data"

umask 077
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    VOICECAN_HOST=*) printf 'VOICECAN_HOST=127.0.0.1\n' ;;
    VOICECAN_PORT=*) printf 'VOICECAN_PORT=%s\n' "$port" ;;
    VOICECAN_DATA_DIR=*) printf 'VOICECAN_DATA_DIR=%s\n' "$data_dir" ;;
    VOICECAN_PUBLIC_BASE_URL=*) printf 'VOICECAN_PUBLIC_BASE_URL=%s\n' "$public_base_url" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$staging_dir/repository/.env.example" > "$staging_dir/repository/.env"
printf 'NODE_ENV=production\n' >> "$staging_dir/repository/.env"
chmod 600 "$staging_dir/repository/.env"

mv -- "$staging_dir/repository" "$install_dir"
rmdir -- "$staging_dir"
staging_dir=""
mkdir -p -- "$data_dir"
chmod 700 "$data_dir"
export PATH="$install_dir/runtime/bin:$PATH"

private_npm() {
  "$node_path" "$npm_cli" "$@"
}

printf 'Installing dependencies and building with private Node.js %s...\n' "$runtime_version"
(
  cd "$install_dir"
  private_npm ci --ignore-scripts
  private_npm run check:public
  private_npm run verify:core
  private_npm run build
)

printf 'Running the explicit database migration...\n'
(
  cd "$install_dir"
  "$node_path" --env-file=.env packages/device-server/dist/cli.js migrate
  private_npm prune --omit=dev --ignore-scripts
)

started=false
case "$service_manager" in
  systemd)
    mkdir -p -- "$unit_dir"
    cat > "$unit_path" <<EOF
[Unit]
Description=Voicecan Device Platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="$install_dir"
ExecStart="$node_path" "--env-file=$install_dir/.env" "$install_dir/packages/device-server/dist/cli.js" serve
Restart=on-failure
RestartSec=5
TimeoutStopSec=45

[Install]
WantedBy=default.target
EOF
    if systemctl --user daemon-reload && systemctl --user enable --now "$SYSTEMD_UNIT"; then
      started=true
    else
      printf 'warning: systemd user service could not be started; the unit remains at %s\n' "$unit_path" >&2
    fi
    ;;
  launchd)
    mkdir -p -- "$launchd_dir" "$data_dir/logs"
    cat > "$launchd_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_path</string>
    <string>--env-file=$install_dir/.env</string>
    <string>$install_dir/packages/device-server/dist/cli.js</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$install_dir</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$data_dir/logs/node-service.log</string>
  <key>StandardErrorPath</key><string>$data_dir/logs/node-service.log</string>
</dict>
</plist>
EOF
    if launchctl bootstrap "gui/$UID" "$launchd_path"; then
      started=true
    else
      printf 'warning: launchd service could not be started; the plist remains at %s\n' "$launchd_path" >&2
    fi
    ;;
esac

if [[ "$started" == "true" ]]; then
  health_url="http://127.0.0.1:$port/health/ready"
  deadline=$((SECONDS + 10#$health_timeout))
  healthy=false
  while ((SECONDS < deadline)); do
    if "$node_path" -e "fetch('$health_url').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
      healthy=true
      break
    fi
    sleep 2
  done
  [[ "$healthy" == "true" ]] || fail "Node.js service did not become healthy at $health_url"
fi

printf '%s\n' "$commit" > "$install_dir/.git/voicecan-node-install-complete"
printf '%s\n' "$runtime_version" > "$install_dir/.git/voicecan-node-runtime-version"
printf '%s\n' "$actual_sha256" > "$install_dir/.git/voicecan-node-runtime-sha256"

cat <<EOF

Voicecan Device Platform is installed with a private Node.js runtime.

  Directory: $install_dir
  Commit:    $commit
  Node:      v$runtime_version ($node_path)
  Node SHA:  $actual_sha256
  npm:       $(private_npm --version)
EOF

if [[ "$started" == "true" ]]; then
  printf '  Admin:     %s/admin\n  Service:   %s (running)\n' "$public_base_url" "$service_manager"
  printf '\nThe native service binds to 127.0.0.1 by default. Use an audited HTTPS/WSS reverse proxy for LAN or Internet access.\n'
  case "$service_manager" in
    systemd) printf '\nView logs with: journalctl --user -u %s --follow\n' "$SYSTEMD_UNIT" ;;
    launchd) printf '\nView logs at: %s/logs/node-service.log\n' "$data_dir" ;;
  esac
else
  cat <<EOF

No user-level service was started. Run in the foreground:
  cd '$install_dir' && '$node_path' --env-file=.env packages/device-server/dist/cli.js serve
EOF
fi
