#!/usr/bin/env bash

# Keep this automation aligned with knowledge/update-test-control-plane.md. The task
# document owns the deployment and rollback contract; this script removes the
# repetitive operator steps without weakening its checks.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

HOST=${TASK_HANDOFF_TEST_HOST:-huadream@192.168.139.109}
SSH_PORT=${TASK_HANDOFF_TEST_SSH_PORT:-}
REUSE_ARTIFACTS=${TASK_HANDOFF_TEST_REUSE_ARTIFACTS:-0}
BASE_VERSION=${TASK_HANDOFF_TEST_BASE_VERSION:-0.0.25}
ARTIFACT_DIR=release/npm/artifacts
BUILD_DATE=$(date +%Y%m%d)
VERSION=${1:-}
AUTO_VERSION=0

log() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$1" >&2
    exit 1
  }
}

for command in node pnpm git ssh scp shasum; do
  require_command "$command"
done

SSH_ARGS=(-o BatchMode=yes)
SCP_ARGS=(-o BatchMode=yes)
if [ -n "$SSH_PORT" ]; then
  case "$SSH_PORT" in
    *[!0-9]*|'') printf 'Unsafe SSH port: %s\n' "$SSH_PORT" >&2; exit 1 ;;
  esac
  SSH_ARGS+=(-p "$SSH_PORT")
  SCP_ARGS+=(-P "$SSH_PORT")
fi

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 15) throw new Error(`Node.js 24.15.0 or newer Node.js 24 is required; received ${process.version}.`);
'

log "Preflight $HOST"
git status --short
REMOTE_PREFLIGHT=$(ssh "${SSH_ARGS[@]}" "$HOST" 'set -eu
  node --version
  sudo -n true
  systemctl is-active task-handoff-node-agent.service
  systemctl is-active task-handoff-control-plane.service
  systemctl show task-handoff-node-agent.service task-handoff-control-plane.service -p Id -p FragmentPath -p ExecStart -p MainPID --no-pager
  node -p '\''require("/usr/local/lib/node_modules/@task-handoff/server/package.json").version'\''
')
printf '%s\n' "$REMOTE_PREFLIGHT"
printf '%s\n' "$REMOTE_PREFLIGHT" | grep -Fq '/usr/local/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/node-agent/'
printf '%s\n' "$REMOTE_PREFLIGHT" | grep -Fq '/usr/local/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/control-plane/'

if [ -z "$VERSION" ]; then
  AUTO_VERSION=1
  VERSION_PREFIX="$BASE_VERSION-local.$BUILD_DATE."
  CANDIDATES=$(
    find "$ARTIFACT_DIR" release/runtime-artifacts -maxdepth 1 -type f -name "*${VERSION_PREFIX}*" -print 2>/dev/null || true
    ssh "${SSH_ARGS[@]}" "$HOST" "find /usr/local/lib/node_modules/@task-handoff /tmp -maxdepth 1 -name '*${VERSION_PREFIX}*' -print 2>/dev/null; node -p 'require(\"/usr/local/lib/node_modules/@task-handoff/server/package.json\").version'"
  )
  NEXT=$(printf '%s\n' "$CANDIDATES" | awk -v prefix="$VERSION_PREFIX" '
    { position = index($0, prefix); if (!position) next; suffix = substr($0, position + length(prefix)); sub(/[^0-9].*/, "", suffix); if (suffix ~ /^[0-9]+$/ && suffix > maximum) maximum = suffix }
    END { print maximum + 1 }
  ')
  VERSION="$VERSION_PREFIX$NEXT"
fi

case "$VERSION" in
  *[!0-9A-Za-z.+-]*|'') printf 'Unsafe version: %s\n' "$VERSION" >&2; exit 1 ;;
esac
node -e 'if (!require("semver").valid(process.argv[1])) throw new Error(`Invalid semver: ${process.argv[1]}`)' "$VERSION"

REMOTE_STAGE="/tmp/task-handoff-$VERSION"
CHECKSUMS="/private/tmp/task-handoff-$VERSION.sha256"

# Reserving the remote path before building makes an interrupted deployment
# consume its version instead of allowing different code to reuse it later.
log "Reserve version $VERSION"
while ! ssh "${SSH_ARGS[@]}" "$HOST" "mkdir '$REMOTE_STAGE'" 2>/dev/null; do
  if [ "$AUTO_VERSION" -ne 1 ]; then
    printf 'Version already has a remote deployment path and cannot be reused: %s\n' "$VERSION" >&2
    exit 1
  fi
  NEXT=$((NEXT + 1))
  VERSION="$VERSION_PREFIX$NEXT"
  REMOTE_STAGE="/tmp/task-handoff-$VERSION"
  CHECKSUMS="/private/tmp/task-handoff-$VERSION.sha256"
  printf 'Version is already reserved; trying %s\n' "$VERSION"
done
if [ "$REUSE_ARTIFACTS" != 1 ]; then
  for name in server control-plane node-agent controlled-instance; do
    test ! -e "$ARTIFACT_DIR/task-handoff-$name-$VERSION.tgz" || {
      printf 'Version already has a local artifact and cannot be reused: %s\n' "$VERSION" >&2
      exit 1
    }
  done
fi

log "Build and verify $VERSION"
if [ "$REUSE_ARTIFACTS" = 1 ]; then
  log "Reuse existing verified artifacts for $VERSION"
else
  pnpm run typecheck:legacy
  pnpm run typecheck:controlled-instance
  pnpm run control-plane-ui:typecheck
  TASK_HANDOFF_VERSION="$VERSION" pnpm run runtime:pack --target controlled-instance
  TASK_HANDOFF_VERSION="$VERSION" pnpm run runtime:artifact -- --version "$VERSION" --prebuilds-dir release/node-pty-prebuilds
  TASK_HANDOFF_VERSION="$VERSION" pnpm run runtime:pack
fi

for name in server control-plane node-agent controlled-instance; do
  test -f "$ARTIFACT_DIR/task-handoff-$name-$VERSION.tgz"
done
test -f "release/runtime-artifacts/controlled-instance-runtime-$VERSION-linux-universal.tar.gz"
test -f "release/npm/node-agent/runtime-artifacts/controlled-instance-runtime-$VERSION-linux-universal.tar.gz"
node -e '
  const fs = require("node:fs");
  for (const name of ["server", "control-plane", "node-agent", "controlled-instance"]) {
    const current = JSON.parse(fs.readFileSync(`release/npm/${name}/package.json`, "utf8"));
    if (current.version !== process.argv[1]) throw new Error(`${name}: ${current.version}`);
  }
' "$VERSION"

shasum -a 256 \
  "$ARTIFACT_DIR/task-handoff-server-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-control-plane-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-node-agent-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-controlled-instance-$VERSION.tgz" \
  | sed "s#  $ARTIFACT_DIR/#  #" > "$CHECKSUMS"
cat "$CHECKSUMS"

log "Upload and assemble staging runtime"
scp "${SCP_ARGS[@]}" \
  "$ARTIFACT_DIR/task-handoff-server-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-control-plane-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-node-agent-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-controlled-instance-$VERSION.tgz" \
  "$CHECKSUMS" \
  "$HOST:$REMOTE_STAGE/"

ssh "${SSH_ARGS[@]}" "$HOST" \
  "sudo -n env VERSION='$VERSION' REMOTE_STAGE='$REMOTE_STAGE' bash -s" <<'REMOTE'
set -eu
cd "$REMOTE_STAGE"
sha256sum -c "task-handoff-$VERSION.sha256"
NEW="/usr/local/lib/node_modules/@task-handoff/.server-$VERSION-stage"
test ! -e "$NEW"
install -d -m 0755 "$NEW"
tar -xzf "$REMOTE_STAGE/task-handoff-server-$VERSION.tgz" -C "$NEW" --strip-components=1
for name in control-plane node-agent controlled-instance; do
  PACKAGE="$NEW/node_modules/@task-handoff/$name"
  install -d -m 0755 "$PACKAGE"
  tar -xzf "$REMOTE_STAGE/task-handoff-$name-$VERSION.tgz" -C "$PACKAGE" --strip-components=1
  npm install --prefix "$PACKAGE" --omit=dev --ignore-scripts
done
node -e '
  const root = process.argv[1];
  const expected = process.argv[2];
  for (const name of ["server", "control-plane", "node-agent", "controlled-instance"]) {
    const file = name === "server" ? `${root}/package.json` : `${root}/node_modules/@task-handoff/${name}/package.json`;
    const version = require(file).version;
    if (version !== expected) throw new Error(`${name}: ${version}`);
  }
' "$NEW" "$VERSION"
test -x "$NEW/node_modules/@task-handoff/node-agent/bin/task-handoff-node-agent"
test -x "$NEW/node_modules/@task-handoff/control-plane/bin/task-handoff-control-plane"
REMOTE

log "Atomically switch Node Agent and Control Plane"
SWITCH_OUTPUT=$(ssh "${SSH_ARGS[@]}" "$HOST" \
  "sudo -n env VERSION='$VERSION' bash -s" <<'REMOTE'
set -eu
BASE=/usr/local/lib/node_modules/@task-handoff
CURRENT="$BASE/server"
NEW="$BASE/.server-$VERSION-stage"
OLD_VERSION=$(node -p "require('$CURRENT/package.json').version")
STAMP=$(date +%Y%m%d%H%M%S)
BACKUP="$BASE/.server-$OLD_VERSION-backup-$STAMP"
FAILED="$BASE/.server-$VERSION-failed-$STAMP"
test -d "$CURRENT"
test -d "$NEW"
NODE_PID_BEFORE=$(systemctl show task-handoff-node-agent.service -p MainPID --value)
CONTROL_PID_BEFORE=$(systemctl show task-handoff-control-plane.service -p MainPID --value)
SWITCHED=0
rollback() {
  systemctl stop task-handoff-control-plane.service || true
  systemctl stop task-handoff-node-agent.service || true
  if [ "$SWITCHED" -eq 1 ]; then
    if [ -d "$CURRENT" ]; then mv "$CURRENT" "$FAILED"; fi
    if [ -d "$BACKUP" ]; then mv "$BACKUP" "$CURRENT"; fi
  fi
  systemctl start task-handoff-node-agent.service
  systemctl start task-handoff-control-plane.service
  echo "Deployment failed; previous server runtime restored." >&2
}
trap 'rollback' ERR
systemctl stop task-handoff-control-plane.service
systemctl stop task-handoff-node-agent.service
mv "$CURRENT" "$BACKUP"
mv "$NEW" "$CURRENT"
SWITCHED=1
systemctl start task-handoff-node-agent.service
for attempt in $(seq 1 30); do
  [ -S /run/task-handoff/node-agent.sock ] && break
  sleep 1
done
test -S /run/task-handoff/node-agent.sock
systemctl is-active --quiet task-handoff-node-agent.service
systemctl start task-handoff-control-plane.service
healthy=0
for attempt in $(seq 1 30); do
  response=$(curl -fsS http://127.0.0.1:8081/api/health 2>/dev/null || true)
  if printf '%s' "$response" | grep -Fq '"ok":true' && printf '%s' "$response" | grep -Fq "\"packageVersion\":\"$VERSION\""; then
    healthy=1
    break
  fi
  sleep 1
done
test "$healthy" -eq 1
NODE_PID_AFTER=$(systemctl show task-handoff-node-agent.service -p MainPID --value)
CONTROL_PID_AFTER=$(systemctl show task-handoff-control-plane.service -p MainPID --value)
test "$NODE_PID_AFTER" -gt 0
test "$CONTROL_PID_AFTER" -gt 0
test "$NODE_PID_AFTER" != "$NODE_PID_BEFORE"
test "$CONTROL_PID_AFTER" != "$CONTROL_PID_BEFORE"
trap - ERR
printf 'backup=%s\n' "$BACKUP"
printf 'node_agent_pid=%s -> %s\n' "$NODE_PID_BEFORE" "$NODE_PID_AFTER"
printf 'control_plane_pid=%s -> %s\n' "$CONTROL_PID_BEFORE" "$CONTROL_PID_AFTER"
REMOTE
)
printf '%s\n' "$SWITCH_OUTPUT"

log "Validate runtime and controlled-instance convergence"
ssh "${SSH_ARGS[@]}" "$HOST" "sudo -n env VERSION='$VERSION' bash -s" <<'REMOTE'
set -eu
test "$(node -p 'require("/usr/local/lib/node_modules/@task-handoff/server/package.json").version')" = "$VERSION"
systemctl is-active --quiet task-handoff-node-agent.service
systemctl is-active --quiet task-handoff-control-plane.service
test -S /run/task-handoff/node-agent.sock
health=$(curl -fsS http://127.0.0.1:8081/api/health)
printf '%s' "$health" | grep -Fq '"ok":true'
printf '%s' "$health" | grep -Fq "\"packageVersion\":\"$VERSION\""
curl -fsS http://127.0.0.1:8081/api/control-plane/identity >/dev/null

converged=0
for attempt in $(seq 1 90); do
  instances=$(curl -fsS --unix-socket /run/task-handoff/node-agent.sock http://localhost/api/node-agent/instances)
  if printf '%s' "$instances" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
      const expected = process.argv[1];
      const active = (JSON.parse(input).data || []).filter((item) => item.status !== "stopped");
      process.exit(active.every((item) => item.ready && item.runtimeVersion?.desiredVersion === expected && item.runtimeVersion?.actualVersion === expected && item.runtimeVersion?.phase === "matched") ? 0 : 1);
    });
  ' "$VERSION"; then
    converged=1
    break
  fi
  sleep 1
done
test "$converged" -eq 1

printf 'health=%s\n' "$health"
printf 'instances=%s\n' "$instances"
printf 'ui_assets='
curl -fsS http://127.0.0.1:8081/ | grep -oE 'assets/[^" ]+\.(js|css)' | sort -u | tr '\n' ','
printf '\n'
REMOTE

log "Deployment complete"
printf 'version=%s\n' "$VERSION"
printf '%s\n' "$SWITCH_OUTPUT"
printf 'remote_stage=%s\n' "$REMOTE_STAGE"
printf 'Keep the backup until feature acceptance is complete.\n'
