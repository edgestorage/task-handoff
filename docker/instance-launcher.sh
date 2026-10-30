#!/usr/bin/env bash
set -euo pipefail

# Stable launcher ABI 1. Application releases are installed independently of
# the image and selected through the atomic `current` symlink.
readonly runtime_root="${TASK_HANDOFF_INSTANCE_RUNTIME_ROOT:-/opt/task-handoff/instance-runtime}"
readonly current="${runtime_root}/current"
readonly script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

bootstrap_wait() {
  echo "No controlled-instance runtime is active; waiting for node-agent bootstrap."
  trap 'exit 0' TERM INT
  while [ ! -L "${current}" ]; do
    sleep 2 &
    wait "$!"
  done
  echo "A controlled-instance runtime is now active; restart the container to launch it."
  while true; do
    sleep 3600 &
    wait "$!"
  done
}

if [ ! -L "${current}" ]; then
  bootstrap_wait
fi

# The launcher can be restarted by a process whose cwd belongs to the previous
# release. Keep this process and every child on a directory that survives release cleanup.
cd -- "${runtime_root}"

exec "${script_dir}/js-runtime.sh" "${script_dir}/instance-launcher.mjs" "${current}"
