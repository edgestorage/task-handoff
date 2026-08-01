#!/usr/bin/env bash
set -euo pipefail

readonly bootstrap_version="1"
readonly marker="/opt/task-handoff/.identity-initialized"
readonly ready_marker="/opt/task-handoff/.bootstrap-ready"
readonly requested_uid="${TASK_HANDOFF_RUN_UID:-1000}"
readonly requested_gid="${TASK_HANDOFF_RUN_GID:-1000}"

fail() {
  echo "TaskHandoff bootstrap: $*" >&2
  exit 78
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "base image is missing required command: $1"
}

case "${requested_uid}:${requested_gid}" in
  *[!0-9:]*|:*|*:) fail "runtime UID and GID must be numeric" ;;
esac
[ "${requested_uid}" != "0" ] || fail "refusing to run the controlled instance as root"

for command in bash node sudo visudo getent useradd groupadd usermod tar install; do
  require_command "${command}"
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 15) { console.error(`TaskHandoff bootstrap requires Node.js >=24.15 <25, found ${process.versions.node}`); process.exit(78); }'

install_launcher() {
  install -d -o root -g root -m 0755 \
    /opt/task-handoff \
    /opt/task-handoff/instance-runtime \
    /opt/task-handoff/instance-runtime/releases \
    /opt/task-handoff/instance-runtime/staging \
    /opt/task-handoff/instance-runtime/incoming \
    /usr/local/lib/task-handoff
  install -m 0755 /root/.task-handoff-entrypoint.bootstrap /usr/local/bin/task-handoff-entrypoint
  install -m 0755 /root/.task-handoff-instance-launcher.bootstrap /usr/local/bin/task-handoff-instance-launcher
  install -m 0755 /root/.task-handoff-runtime-installer.bootstrap /usr/local/lib/task-handoff/runtime-installer.mjs
  ln -sfn /usr/local/lib/task-handoff/runtime-installer.mjs /usr/local/bin/task-handoff-runtime
}

resolve_runtime_user() {
  local passwd_entry
  passwd_entry="$(getent passwd "${requested_uid}" || true)"
  if [ -n "${passwd_entry}" ]; then
    printf '%s\n' "${passwd_entry%%:*}"
    return
  fi

  local group_name
  group_name="$(getent group "${requested_gid}" | cut -d: -f1 || true)"
  if [ -z "${group_name}" ]; then
    group_name="task-handoff-${requested_gid}"
    groupadd --gid "${requested_gid}" "${group_name}"
  fi

  local user_name="agent"
  if getent passwd "${user_name}" >/dev/null 2>&1; then
    user_name="task-handoff-${requested_uid}"
  fi
  useradd --uid "${requested_uid}" --gid "${requested_gid}" --home-dir /home/agent --shell /bin/bash "${user_name}"
  printf '%s\n' "${user_name}"
}

install_launcher
rm -f "${ready_marker}"
runtime_user="$(resolve_runtime_user)"
expected_marker="${bootstrap_version}:${requested_uid}:${requested_gid}:${runtime_user}"

if [ "$(cat "${marker}" 2>/dev/null || true)" != "${expected_marker}" ]; then
  install -d -o "${requested_uid}" -g "${requested_gid}" -m 0755 /home/agent /data
  chown -R "${requested_uid}:${requested_gid}" /home/agent /data
  if [ "${TASK_HANDOFF_WORKSPACE_MODE:-local-bind}" != "local-bind" ]; then
    install -d -o "${requested_uid}" -g "${requested_gid}" -m 0755 "${TASK_HANDOFF_WORKSPACE:-/workspace}"
    chown -R "${requested_uid}:${requested_gid}" "${TASK_HANDOFF_WORKSPACE:-/workspace}"
  fi
  printf '%s ALL=(root) NOPASSWD: ALL\n' "${runtime_user}" > /etc/sudoers.d/task-handoff-runtime
  chmod 0440 /etc/sudoers.d/task-handoff-runtime
  visudo -cf /etc/sudoers.d/task-handoff-runtime >/dev/null
  printf '%s\n' "${expected_marker}" > "${marker}"
fi

export HOME=/home/agent
export USER="${runtime_user}"
export LOGNAME="${runtime_user}"

sudo -n -u "${runtime_user}" env \
  HOME="${HOME}" USER="${USER}" LOGNAME="${LOGNAME}" \
  TASK_HANDOFF_RUN_UID="${requested_uid}" TASK_HANDOFF_RUN_GID="${requested_gid}" \
  TASK_HANDOFF_WORKSPACE="${TASK_HANDOFF_WORKSPACE:-/workspace}" \
  TASK_HANDOFF_WORKSPACE_MODE="${TASK_HANDOFF_WORKSPACE_MODE:-local-bind}" \
  TASK_HANDOFF_WORKSPACE_READ_ONLY="${TASK_HANDOFF_WORKSPACE_READ_ONLY:-false}" \
  bash -ceu '
    test "$(id -u)" = "$TASK_HANDOFF_RUN_UID"
    test "$(id -g)" = "$TASK_HANDOFF_RUN_GID"
    test -w "$HOME"
    sudo -n true
    workspace="${TASK_HANDOFF_WORKSPACE:-/workspace}"
    if [ "${TASK_HANDOFF_WORKSPACE_MODE:-local-bind}" != "git-clone" ] && [ "${TASK_HANDOFF_WORKSPACE_READ_ONLY:-false}" != "true" ]; then
      probe="$workspace/.task-handoff-write-probe-$$"
      (umask 077; : > "$probe"; rm -f "$probe") || { echo "Workspace is not writable by UID:GID $(id -u):$(id -g): $workspace" >&2; exit 73; }
    fi
  '

: > "${ready_marker}"

exec sudo -n -E -u "${runtime_user}" \
  task-handoff-entrypoint task-handoff web
