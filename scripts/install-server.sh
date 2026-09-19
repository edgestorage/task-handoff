#!/bin/sh
set -eu

MIN_NODE_VERSION="24.15.0"
VERSION=""
CHANNEL="stable"
ARTIFACTS_DIR=""
INSTALL_SOURCE="${TASK_HANDOFF_INSTALL_SOURCE:-auto}"
NODE_DIST_URL="${TASK_HANDOFF_NODE_DIST_URL:-}"
NPM_REGISTRY="${TASK_HANDOFF_NPM_REGISTRY:-}"
EFFECTIVE_INSTALL_SOURCE=""
APT_SOURCE_FILE=""
INSTALL_DOCKER="1"
SERVICE_USER="root"
CONTROL_PLANE_HOST="0.0.0.0"
CONTROL_PLANE_PORT="8081"
NODE_AGENT_HOST="127.0.0.1"
NODE_AGENT_PORT="8091"
NODE_AGENT_IPC_PATH="/run/task-handoff/node-agent.sock"
AUTH_MODE="password"

usage() {
  cat <<'USAGE'
Usage: install-server.sh [options]

Installs everything needed by a local TaskHandoff server on Debian, Ubuntu,
RHEL 8/9, or CentOS Stream 9:
  - Node.js 24.15.0 or newer within the Node.js 24 release line
  - Docker (unless --skip-docker is used)
  - control-plane, node-agent, and controlled-instance runtime packages
  - task-handoff-control-plane.service and task-handoff-node-agent.service

Package options:
  --channel <channel>               npm channel: stable, beta, or alpha; default stable
  --version <version>               Install an exact runtime package version
  --artifacts-dir <path>            Install the four release tarballs from this directory
  --install-source <source>         Source profile: auto, official, or china; default auto
  --node-dist-url <url>             Override the Node.js distribution base URL
  --npm-registry <url>              npm registry used for published runtime packages
  --skip-docker                     Do not install or start Docker

Service options:
  --service-user <user>             systemd service user, default root
  --control-plane-host <host>       Control-plane bind host, default 0.0.0.0
  --control-plane-port <port>       Control-plane port, default 8081
  --node-agent-host <host>          Node-agent bind host, default 127.0.0.1
  --node-agent-port <port>          Node-agent port, default 8091
  --node-agent-ipc-path <path>      Local control socket
  --auth-mode <mode>                Control-plane auth mode: password or disabled
USAGE
}

die() {
  echo "Error: $*" >&2
  exit 1
}

need_root() {
  [ "$(id -u)" = "0" ] || die "run this installer as root (for example: sudo sh install-server.sh)"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --artifacts-dir) ARTIFACTS_DIR="${2:-}"; shift 2 ;;
    --install-source) INSTALL_SOURCE="${2:-}"; shift 2 ;;
    --node-dist-url) NODE_DIST_URL="${2:-}"; shift 2 ;;
    --npm-registry) NPM_REGISTRY="${2:-}"; shift 2 ;;
    --skip-docker) INSTALL_DOCKER="0"; shift ;;
    --service-user) SERVICE_USER="${2:-}"; shift 2 ;;
    --control-plane-host) CONTROL_PLANE_HOST="${2:-}"; shift 2 ;;
    --control-plane-port) CONTROL_PLANE_PORT="${2:-}"; shift 2 ;;
    --node-agent-host) NODE_AGENT_HOST="${2:-}"; shift 2 ;;
    --node-agent-port) NODE_AGENT_PORT="${2:-}"; shift 2 ;;
    --node-agent-ipc-path) NODE_AGENT_IPC_PATH="${2:-}"; shift 2 ;;
    --auth-mode) AUTH_MODE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$CHANNEL" = "stable" ] || [ "$CHANNEL" = "beta" ] || [ "$CHANNEL" = "alpha" ] || die "--channel must be stable, beta, or alpha"
[ "$AUTH_MODE" = "password" ] || [ "$AUTH_MODE" = "disabled" ] || die "--auth-mode must be password or disabled"
[ "$INSTALL_SOURCE" = "auto" ] || [ "$INSTALL_SOURCE" = "official" ] || [ "$INSTALL_SOURCE" = "china" ] \
  || die "--install-source must be auto, official, or china"
NODE_DIST_URL_OVERRIDE="$NODE_DIST_URL"
NPM_REGISTRY_OVERRIDE="$NPM_REGISTRY"

need_root
command -v systemctl >/dev/null 2>&1 || die "systemd is required"

china_environment_hint() {
  if [ -n "${TZ:-}" ]; then
    case "$TZ" in Asia/Shanghai|Asia/Chongqing) return 0 ;; esac
  elif [ -r /etc/timezone ] && grep -Eq '^Asia/(Shanghai|Chongqing)$' /etc/timezone; then
    return 0
  fi
  case "${LANG:-}${LC_ALL:-}" in *zh_CN*) return 0 ;; esac
  return 1
}

select_install_source() {
  EFFECTIVE_INSTALL_SOURCE="$INSTALL_SOURCE"
  if [ "$EFFECTIVE_INSTALL_SOURCE" = "auto" ]; then
    if china_environment_hint; then
      EFFECTIVE_INSTALL_SOURCE="china"
    elif command -v curl >/dev/null 2>&1 && ! curl -4 -fsSL \
      --connect-timeout 3 --max-time 8 \
      https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o /dev/null; then
      EFFECTIVE_INSTALL_SOURCE="china"
    else
      EFFECTIVE_INSTALL_SOURCE="official"
    fi
  fi
  NODE_DIST_URL="$NODE_DIST_URL_OVERRIDE"
  NPM_REGISTRY="$NPM_REGISTRY_OVERRIDE"
  if [ -z "$NODE_DIST_URL" ]; then
    if [ "$EFFECTIVE_INSTALL_SOURCE" = "china" ]; then
      NODE_DIST_URL="https://npmmirror.com/mirrors/node"
    else
      NODE_DIST_URL="https://nodejs.org/dist"
    fi
  fi
  if [ -z "$NPM_REGISTRY" ] && [ "$EFFECTIVE_INSTALL_SOURCE" = "china" ]; then
    NPM_REGISTRY="https://registry.npmmirror.com"
  fi
  echo "Using $EFFECTIVE_INSTALL_SOURCE install sources (Node.js: $NODE_DIST_URL${NPM_REGISTRY:+, npm: $NPM_REGISTRY})."
}

prepare_apt_source() {
  [ -r /etc/os-release ] || return 1
  os_id="$(. /etc/os-release && printf '%s' "$ID")"
  os_codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  [ -n "$os_codename" ] || return 1
  APT_SOURCE_FILE="$(mktemp)"
  # APT authenticates signed repository metadata, so HTTP can bootstrap ca-certificates safely.
  case "$os_id:$EFFECTIVE_INSTALL_SOURCE" in
    debian:china)
      printf '%s\n' \
        "deb http://mirrors.tuna.tsinghua.edu.cn/debian/ $os_codename main" \
        "deb http://mirrors.tuna.tsinghua.edu.cn/debian/ $os_codename-updates main" \
        "deb http://mirrors.tuna.tsinghua.edu.cn/debian-security $os_codename-security main" > "$APT_SOURCE_FILE"
      ;;
    debian:*)
      printf '%s\n' \
        "deb http://deb.debian.org/debian $os_codename main" \
        "deb http://deb.debian.org/debian $os_codename-updates main" \
        "deb http://security.debian.org/debian-security $os_codename-security main" > "$APT_SOURCE_FILE"
      ;;
    ubuntu:china)
      case "$(uname -m)" in x86_64|amd64) apt_base="ubuntu" ;; *) apt_base="ubuntu-ports" ;; esac
      printf '%s\n' \
        "deb http://mirrors.tuna.tsinghua.edu.cn/$apt_base/ $os_codename main universe" \
        "deb http://mirrors.tuna.tsinghua.edu.cn/$apt_base/ $os_codename-updates main universe" \
        "deb http://mirrors.tuna.tsinghua.edu.cn/$apt_base/ $os_codename-security main universe" > "$APT_SOURCE_FILE"
      ;;
    ubuntu:*)
      case "$(uname -m)" in
        x86_64|amd64) apt_host="archive.ubuntu.com/ubuntu"; apt_security_host="security.ubuntu.com/ubuntu" ;;
        *) apt_host="ports.ubuntu.com/ubuntu-ports"; apt_security_host="$apt_host" ;;
      esac
      printf '%s\n' \
        "deb http://$apt_host/ $os_codename main universe" \
        "deb http://$apt_host/ $os_codename-updates main universe" \
        "deb http://$apt_security_host/ $os_codename-security main universe" > "$APT_SOURCE_FILE"
      ;;
    *) rm -f "$APT_SOURCE_FILE"; APT_SOURCE_FILE=""; return 1 ;;
  esac
}

apt_get() {
  if [ -n "$APT_SOURCE_FILE" ]; then
    apt-get -o "Dir::Etc::sourcelist=$APT_SOURCE_FILE" -o "Dir::Etc::sourceparts=-" "$@"
  else
    apt-get "$@"
  fi
}

HAD_CURL="0"
if command -v curl >/dev/null 2>&1; then HAD_CURL="1"; fi
select_install_source
if command -v apt-get >/dev/null 2>&1; then prepare_apt_source || true; fi

version_is_at_least() {
  awk -v current="$1" -v minimum="$2" 'BEGIN {
    split(current, left, "."); split(minimum, right, ".");
    for (i = 1; i <= 3; i++) {
      if ((left[i] + 0) > (right[i] + 0)) exit 0;
      if ((left[i] + 0) < (right[i] + 0)) exit 1;
    }
    exit 0;
  }'
}

node_is_compatible() {
  command -v node >/dev/null 2>&1 || return 1
  current_node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  case "$current_node_version" in
    24.*) version_is_at_least "$current_node_version" "$MIN_NODE_VERSION" ;;
    *) return 1 ;;
  esac
}

install_node_prerequisites() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    echo "[1/5] Refreshing apt package metadata"
    apt_get update
    apt_get install -y ca-certificates curl xz-utils
  elif command -v dnf >/dev/null 2>&1; then
    echo "[1/5] Installing Node.js archive prerequisites with dnf"
    dnf install -y ca-certificates curl tar xz
  else
    die "automatic Node.js installation requires apt-get or dnf; install Node.js $MIN_NODE_VERSION with npm manually"
  fi
}

ensure_supported_linux_runtime() {
  for command in awk getconf uname; do command -v "$command" >/dev/null 2>&1 || die "$command is required"; done
  [ "$(uname -s)" = "Linux" ] || die "runtime packages support Linux hosts only"
  case "$(uname -m)" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) die "runtime packages support x86_64 and arm64 Linux hosts only" ;;
  esac
  glibc_version="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }')"
  [ -n "$glibc_version" ] && version_is_at_least "$glibc_version" "2.28" \
    || die "runtime packages require glibc 2.28 or newer; found ${glibc_version:-unknown}"
}

echo "[2/5] Ensuring Node.js >= $MIN_NODE_VERSION"
if node_is_compatible && command -v npm >/dev/null 2>&1; then
  ensure_supported_linux_runtime
  echo "Using existing Node.js $(node --version) and npm $(npm --version)"
else
  echo "Installing the current Node.js 24 build with its bundled npm."
  install_node_prerequisites
  if [ "$HAD_CURL" = "0" ] && [ "$INSTALL_SOURCE" = "auto" ]; then
    select_install_source
    rm -f "$APT_SOURCE_FILE"
    APT_SOURCE_FILE=""
    if command -v apt-get >/dev/null 2>&1; then prepare_apt_source || true; fi
  fi
  for command in awk curl getconf mktemp sha256sum tar uname; do command -v "$command" >/dev/null 2>&1 || die "$command is required"; done
  ensure_supported_linux_runtime
  node_tmp="$(mktemp -d)"
  trap 'rm -rf "$node_tmp"' EXIT HUP INT TERM
  curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 \
    "$NODE_DIST_URL/latest-v24.x/SHASUMS256.txt" -o "$node_tmp/SHASUMS256.txt"
  node_archive="$(awk -v suffix="linux-$node_arch.tar.xz" '$2 ~ suffix "$" { print $2; exit }' "$node_tmp/SHASUMS256.txt")"
  [ -n "$node_archive" ] || die "could not find the Node.js 24 archive for $node_arch at $NODE_DIST_URL"
  curl --fail --location --show-error --connect-timeout 10 --max-time 600 --retry 2 \
    "$NODE_DIST_URL/latest-v24.x/$node_archive" -o "$node_tmp/$node_archive"
  expected_checksum="$(awk -v archive="$node_archive" '$2 == archive { print $1; exit }' "$node_tmp/SHASUMS256.txt")"
  actual_checksum="$(sha256sum "$node_tmp/$node_archive" | awk '{ print $1 }')"
  [ "$actual_checksum" = "$expected_checksum" ] || die "Node.js archive checksum verification failed"
  tar -xJf "$node_tmp/$node_archive" --strip-components=1 -C /usr/local
  rm -rf "$node_tmp"
  trap - EXIT HUP INT TERM
fi
node_is_compatible || die "Node.js $MIN_NODE_VERSION or newer is required; found $(node --version 2>/dev/null || echo none)"
command -v npm >/dev/null 2>&1 || die "npm was not installed with Node.js"

echo "[3/5] Ensuring Docker is available"
if [ "$INSTALL_DOCKER" = "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt_get update
      apt_get install -y docker.io
    elif command -v dnf >/dev/null 2>&1; then
      os_id="$(. /etc/os-release && printf '%s' "$ID")"
      case "$os_id" in
        rhel) docker_repo_os="rhel" ;;
        centos) docker_repo_os="centos" ;;
        *) die "automatic Docker installation on dnf hosts supports RHEL and CentOS; install Docker Engine manually or pass --skip-docker" ;;
      esac
      dnf install -y dnf-plugins-core
      dnf config-manager --add-repo "https://download.docker.com/linux/$docker_repo_os/docker-ce.repo"
      dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    else
      die "automatic Docker installation requires apt-get or dnf"
    fi
  fi
  systemctl enable --now docker.service
  docker info >/dev/null
else
  echo "Docker installation skipped by request."
fi

rm -f "$APT_SOURCE_FILE"

if [ -n "$VERSION" ]; then
  PACKAGE_TARGET="$VERSION"
elif [ "$CHANNEL" = "stable" ]; then
  PACKAGE_TARGET="latest"
else
  PACKAGE_TARGET="$CHANNEL"
fi
echo "[4/5] Installing TaskHandoff runtime packages $PACKAGE_TARGET"
if [ -n "$ARTIFACTS_DIR" ]; then
  [ -n "$VERSION" ] || die "--version is required when --artifacts-dir is used"
  [ -d "$ARTIFACTS_DIR" ] || die "artifacts directory does not exist: $ARTIFACTS_DIR"
  control_plane_artifact="$ARTIFACTS_DIR/task-handoff-control-plane-$VERSION.tgz"
  node_agent_artifact="$ARTIFACTS_DIR/task-handoff-node-agent-$VERSION.tgz"
  controlled_instance_artifact="$ARTIFACTS_DIR/task-handoff-controlled-instance-$VERSION.tgz"
  server_artifact="$ARTIFACTS_DIR/task-handoff-server-$VERSION.tgz"
  [ -f "$control_plane_artifact" ] || die "missing artifact: $control_plane_artifact"
  [ -f "$node_agent_artifact" ] || die "missing artifact: $node_agent_artifact"
  [ -f "$controlled_instance_artifact" ] || die "missing artifact: $controlled_instance_artifact"
  [ -f "$server_artifact" ] || die "missing artifact: $server_artifact"
  if [ -n "$NPM_REGISTRY" ]; then
    npm install -g --registry "$NPM_REGISTRY" "$control_plane_artifact" "$node_agent_artifact" "$controlled_instance_artifact" "$server_artifact"
  else
    npm install -g "$control_plane_artifact" "$node_agent_artifact" "$controlled_instance_artifact" "$server_artifact"
  fi
else
  if [ -n "$NPM_REGISTRY" ]; then
    npm install -g --registry "$NPM_REGISTRY" "@task-handoff/server@$PACKAGE_TARGET"
  else
    npm install -g "@task-handoff/server@$PACKAGE_TARGET"
  fi
fi

command -v task-handoff >/dev/null 2>&1 || die "runtime packages did not install task-handoff"

echo "[5/5] Installing and starting TaskHandoff systemd services"
task-handoff install \
  --service-user "$SERVICE_USER" \
  --control-plane-host "$CONTROL_PLANE_HOST" \
  --control-plane-port "$CONTROL_PLANE_PORT" \
  --node-agent-host "$NODE_AGENT_HOST" \
  --node-agent-port "$NODE_AGENT_PORT" \
  --node-agent-ipc-path "$NODE_AGENT_IPC_PATH" \
  --npm-registry "$NPM_REGISTRY" \
  --auth-mode "$AUTH_MODE"

echo "TaskHandoff installation completed."
echo "Open: http://$(hostname -I 2>/dev/null | awk '{ print $1 }'):$CONTROL_PLANE_PORT"
