#!/usr/bin/env bash
set -euo pipefail

# Stable launcher ABI 1. Application releases are installed independently of
# the image and selected through the atomic `current` symlink.
readonly runtime_root="${TASK_HANDOFF_INSTANCE_RUNTIME_ROOT:-/opt/task-handoff/instance-runtime}"
readonly current="${runtime_root}/current"

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
  if command -v task-handoff-controlled-instance >/dev/null 2>&1; then
    exec task-handoff-controlled-instance web \
      --host "${TASK_HANDOFF_WEB_HOST:-0.0.0.0}" \
      --port "${TASK_HANDOFF_WEB_PORT:-8080}"
  fi
  bootstrap_wait
fi

exec node --input-type=module - "${current}" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const current = process.argv[2];
const releaseRoot = fs.realpathSync(current);
const manifestPath = path.join(releaseRoot, "runtime-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.packageName !== "@task-handoff/controlled-instance" || typeof manifest.entrypoint !== "string") {
  throw new Error("Active controlled-instance runtime manifest is invalid.");
}
const entrypoint = path.resolve(releaseRoot, manifest.entrypoint);
if (!entrypoint.startsWith(`${releaseRoot}${path.sep}`) || !fs.statSync(entrypoint).isFile()) {
  throw new Error("Active controlled-instance runtime entrypoint is invalid.");
}
process.argv = [process.execPath, entrypoint, "web", "--host", process.env.TASK_HANDOFF_WEB_HOST || "0.0.0.0", "--port", process.env.TASK_HANDOFF_WEB_PORT || "8080"];
await import(pathToFileURL(entrypoint).href);
NODE
