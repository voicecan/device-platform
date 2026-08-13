#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_REPOSITORY="https://github.com/voicecan/device-platform.git"
readonly DEFAULT_REF="main"
readonly DEFAULT_PROJECT="voicecan-device-platform"
readonly DEFAULT_PORT="8787"
readonly DEFAULT_HEALTH_TIMEOUT="120"

repository="${VOICECAN_REPOSITORY:-$DEFAULT_REPOSITORY}"
ref="${VOICECAN_REF:-$DEFAULT_REF}"
project="${VOICECAN_COMPOSE_PROJECT:-$DEFAULT_PROJECT}"
port="${VOICECAN_PORT:-$DEFAULT_PORT}"
health_timeout="${VOICECAN_INSTALL_HEALTH_TIMEOUT:-$DEFAULT_HEALTH_TIMEOUT}"
public_base_url="${VOICECAN_PUBLIC_BASE_URL:-}"
install_dir="${VOICECAN_INSTALL_DIR:-}"
staging_dir=""

usage() {
  cat <<'EOF'
Install the main release of Voicecan Device Platform with Docker Compose.

Usage:
  install.sh [options]

Options:
  --repository URL    Public Git repository URL
  --ref REF           Release branch or tag (default: main)
  --install-dir DIR   Source/config directory
  --port PORT         Loopback HTTP port (default: 8787)
  --public-url URL    Public base URL written to .env
  --project NAME      Docker Compose project name
  -h, --help          Show this help

The same settings can be supplied with VOICECAN_REPOSITORY, VOICECAN_REF,
VOICECAN_INSTALL_DIR, VOICECAN_PORT, VOICECAN_PUBLIC_BASE_URL, and
VOICECAN_COMPOSE_PROJECT.
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
    --project)
      (($# >= 2)) || fail "--project requires a value"
      project="$2"
      shift 2
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

[[ "$install_dir" != "/" ]] || fail "the filesystem root is not a valid install directory"
[[ "$repository" != -* && "$repository" != *$'\n'* ]] || fail "invalid repository URL"
[[ "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || fail "invalid Git ref"
[[ "$ref" != *..* && "$ref" != *@\{* ]] || fail "unsafe Git ref"
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "invalid Compose project name"
[[ "$port" =~ ^[0-9]+$ ]] || fail "port must be an integer"
((10#$port >= 1 && 10#$port <= 65535)) || fail "port must be between 1 and 65535"
[[ "$health_timeout" =~ ^[0-9]+$ ]] || fail "VOICECAN_INSTALL_HEALTH_TIMEOUT must be an integer"
((10#$health_timeout >= 10 && 10#$health_timeout <= 600)) || fail "health timeout must be between 10 and 600 seconds"
[[ "$public_base_url" != *$'\n'* ]] || fail "public URL must not contain a newline"
if [[ -n "$public_base_url" ]]; then
  [[ "$public_base_url" =~ ^https?://[^[:space:]#]+$ ]] || fail "public URL must be an HTTP(S) URL without spaces or fragments"
fi

for command_name in git docker; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose)"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not available to the current user"

if [[ -e "$install_dir" ]]; then
  if [[ -d "$install_dir/.git" && -f "$install_dir/.env" && -f "$install_dir/.git/voicecan-install-complete" ]]; then
    installed_commit="$(git -C "$install_dir" rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown')"
    printf 'Voicecan Device Platform is already installed.\n'
    printf 'Directory: %s\nCommit:    %s\n' "$install_dir" "$installed_commit"
    printf 'This installer never overwrites an existing installation. Follow the release migration guide to upgrade.\n'
    exit 0
  fi
  fail "install directory exists but is not a completed installation; inspect it before following the recovery/upgrade guide: $install_dir"
fi

existing_containers="$(docker ps --all --filter "label=com.docker.compose.project=$project" --quiet)"
[[ -z "$existing_containers" ]] || fail "Compose project '$project' already owns containers; choose another name with --project"
if docker volume inspect "${project}_voicecan-device-data" >/dev/null 2>&1; then
  fail "Compose project '$project' already owns a data volume; choose another name or follow the recovery/upgrade guide"
fi

install_parent="$(dirname "$install_dir")"
mkdir -p -- "$install_parent"
staging_dir="$(mktemp -d "$install_parent/.voicecan-device-platform.XXXXXX")"

printf 'Cloning %s (%s)...\n' "$repository" "$ref"
git clone --quiet --depth 1 --single-branch --branch "$ref" -- "$repository" "$staging_dir/repository"

for required_path in Dockerfile deploy/docker-compose.yml .env.example core-artifacts.lock.json; do
  [[ -f "$staging_dir/repository/$required_path" ]] || fail "release is missing $required_path"
done

commit="$(git -C "$staging_dir/repository" rev-parse HEAD)"
short_commit="${commit:0:12}"
image="voicecan-device-platform:$short_commit"

if [[ -z "$public_base_url" ]]; then
  public_base_url="http://127.0.0.1:$port"
fi

umask 077
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    VOICECAN_PORT=*) printf 'VOICECAN_PORT=%s\n' "$port" ;;
    VOICECAN_DATA_DIR=*) printf 'VOICECAN_DATA_DIR=/data\n' ;;
    VOICECAN_PUBLIC_BASE_URL=*) printf 'VOICECAN_PUBLIC_BASE_URL=%s\n' "$public_base_url" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$staging_dir/repository/.env.example" > "$staging_dir/repository/.env"
printf 'VOICECAN_DEVICE_IMAGE=%s\n' "$image" >> "$staging_dir/repository/.env"
chmod 600 "$staging_dir/repository/.env"

mv -- "$staging_dir/repository" "$install_dir"
rmdir -- "$staging_dir"
staging_dir=""

compose=(
  docker compose
  --project-name "$project"
  --project-directory "$install_dir"
  --file "$install_dir/deploy/docker-compose.yml"
)

printf 'Building verified image %s...\n' "$image"
"${compose[@]}" build

printf 'Running the explicit database migration...\n'
"${compose[@]}" run --rm --no-deps migrate

printf 'Starting Device Platform...\n'
"${compose[@]}" up --detach --no-deps device-server

container_id="$("${compose[@]}" ps --quiet device-server)"
[[ -n "$container_id" ]] || fail "Device Platform container was not created"

deadline=$((SECONDS + 10#$health_timeout))
health="starting"
while ((SECONDS < deadline)); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || printf 'missing')"
  case "$health" in
    healthy) break ;;
    unhealthy|exited|dead|missing) break ;;
  esac
  sleep 2
done

if [[ "$health" != "healthy" ]]; then
  "${compose[@]}" logs --tail 80 device-server >&2 || true
  fail "Device Platform did not become healthy (state: $health)"
fi

printf '%s\n' "$commit" > "$install_dir/.git/voicecan-install-complete"

cat <<EOF

Voicecan Device Platform is installed and healthy.

  Admin:     $public_base_url/admin
  Directory: $install_dir
  Commit:    $commit
  Image:     $image

The service listens on loopback by default. On a remote host, use an SSH tunnel
or put an audited HTTPS/WSS reverse proxy in front of it.

After opening Admin, retrieve the one-time setup token only when needed:
  cd '$install_dir' && docker compose --project-name '$project' --file deploy/docker-compose.yml exec device-server sh -c 'cat /data/setup-token'

View logs:
  cd '$install_dir' && docker compose --project-name '$project' --file deploy/docker-compose.yml logs --follow device-server
EOF
