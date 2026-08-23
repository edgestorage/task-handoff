#!/usr/bin/env bash
set -euo pipefail

workspace="/workspace"
staging="${workspace}/.task-handoff-git-provisioning"
checkout="${staging}/checkout"
owner_file="${staging}/owner"
runtime_dir="/run/task-handoff/git-runtime"
mkdir -p "${workspace}" "${runtime_dir}"

fail() {
  printf 'TASK_HANDOFF_GIT_PROVISIONING_ERROR=%s\n' "$1" >&2
  exit "${2:-1}"
}

agent_pids=()
cleanup() {
  for agent_pid in "${agent_pids[@]}"; do kill "${agent_pid}" 2>/dev/null || true; done
  find "${runtime_dir}" -type f \( -name private-key -o -name passphrase -o -name ssh-askpass.sh -o -name ssh-error \) -delete 2>/dev/null || true
}
trap cleanup EXIT INT TERM

existing="$(find "${workspace}" -mindepth 1 -maxdepth 1 ! -name .task-handoff-git-provisioning -print -quit 2>/dev/null)"
if [ -n "${existing}" ]; then
  if [ -e "${workspace}/.git" ]; then
    echo "Workspace is already materialized; skipping provisioning."
    exit 0
  fi
  fail WORKSPACE_NOT_EMPTY 73
fi
if [ -e "${staging}" ]; then
  if [ ! -f "${owner_file}" ] || [ "$(cat "${owner_file}")" != "${TASK_HANDOFF_INSTANCE_ID}" ]; then
    fail WORKSPACE_OWNERSHIP_MISMATCH 73
  fi
  rm -rf -- "${staging}"
fi
chown 1000:1000 "${workspace}"
mkdir -p "${staging}"
printf '%s' "${TASK_HANDOFF_INSTANCE_ID}" >"${owner_file}"
chmod 0600 "${owner_file}"
chown -R 1000:1000 "${staging}"

if [ -d /run/task-handoff/git-auth ]; then
  cp -a /run/task-handoff/git-auth/. "${runtime_dir}/"
  chmod 0700 "${runtime_dir}"
  find "${runtime_dir}" -type f -exec chmod 0600 {} +
  chown -R 1000:1000 "${runtime_dir}"
fi
if [ -f "${runtime_dir}/ssh-askpass.sh" ]; then
  chmod 0700 "${runtime_dir}/ssh-askpass.sh"
  chown 1000:1000 "${runtime_dir}/ssh-askpass.sh"
fi

for credential_dir in "${runtime_dir}"/credential-*; do
  if [ ! -f "${credential_dir}/private-key" ]; then continue; fi
  agent_output="$(runuser -u agent -- ssh-agent -a "${credential_dir}/agent.sock" -s)"
  SSH_AUTH_SOCK="$(printf '%s\n' "${agent_output}" | sed -n 's/^SSH_AUTH_SOCK=\([^;]*\);.*$/\1/p')"
  agent_pid="$(printf '%s\n' "${agent_output}" | sed -n 's/^SSH_AGENT_PID=\([0-9]*\);.*$/\1/p')"
  if [ -z "${SSH_AUTH_SOCK}" ] || [ -z "${agent_pid}" ]; then
    fail SSH_AGENT_UNAVAILABLE 70
  fi
  agent_pids+=("${agent_pid}")
  askpass="/bin/false"
  if [ -f "${credential_dir}/ssh-askpass.sh" ]; then askpass="${credential_dir}/ssh-askpass.sh"; fi
  if ! runuser -u agent -- env \
    SSH_AUTH_SOCK="${SSH_AUTH_SOCK}" \
    SSH_ASKPASS="${askpass}" \
    SSH_ASKPASS_REQUIRE=force \
    DISPLAY=task-handoff:0 \
    ssh-add "${credential_dir}/private-key" </dev/null; then
    fail AUTHENTICATION_REJECTED 74
  fi
  runuser -u agent -- env SSH_AUTH_SOCK="${SSH_AUTH_SOCK}" ssh-add -L >"${credential_dir}/public-identity"
  chmod 0600 "${credential_dir}/public-identity"
  chown 1000:1000 "${credential_dir}/public-identity"
  rm -f -- "${credential_dir}/private-key" "${credential_dir}/passphrase" "${credential_dir}/ssh-askpass.sh"
done

git_config=(
  -c credential.helper=
  -c credential.helper="!node /run/task-handoff/bootstrap/git-provisioning-helper.js credential"
  -c credential.useHttpPath=true
  -c core.sshCommand="node /run/task-handoff/bootstrap/git-provisioning-helper.js ssh"
)
clone_args=(clone)
if [ -n "${TASK_HANDOFF_GIT_DEPTH:-}" ]; then clone_args+=(--depth "${TASK_HANDOFF_GIT_DEPTH}"); fi
if [ "${TASK_HANDOFF_GIT_SUBMODULES:-false}" = "true" ]; then clone_args+=(--recurse-submodules); fi
if [ -n "${TASK_HANDOFF_GIT_REF:-}" ]; then clone_args+=(--branch "${TASK_HANDOFF_GIT_REF}"); fi
clone_args+=(-- "${TASK_HANDOFF_GIT_URL}" "${checkout}")

mkdir -p /tmp/task-handoff-git-home
chown 1000:1000 /tmp/task-handoff-git-home

if ! runuser -u agent -- env \
  HOME=/tmp/task-handoff-git-home \
  GIT_TERMINAL_PROMPT=0 \
  GIT_SSH_COMMAND="node /run/task-handoff/bootstrap/git-provisioning-helper.js ssh" \
  git "${git_config[@]}" "${clone_args[@]}"; then
  fail AUTHENTICATION_REJECTED 74
fi

if [ -n "${TASK_HANDOFF_GIT_COMMIT:-}" ]; then
  if ! runuser -u agent -- git -C "${checkout}" checkout --detach "${TASK_HANDOFF_GIT_COMMIT}"; then
    fail REF_NOT_FOUND 75
  fi
fi
if [ "${TASK_HANDOFF_GIT_LFS:-false}" = "true" ]; then
  if ! runuser -u agent -- env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="node /run/task-handoff/bootstrap/git-provisioning-helper.js ssh" git "${git_config[@]}" -C "${checkout}" lfs pull; then
    fail LFS_FAILED 76
  fi
fi
shopt -s dotglob nullglob
mv -- "${checkout}"/* "${workspace}/"
rm -rf -- "${staging}"
