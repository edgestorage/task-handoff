#!/usr/bin/env bash
set -euo pipefail

host="${TASK_HANDOFF_WEB_HOST:-127.0.0.1}"
if [ "$host" = "0.0.0.0" ]; then
  host="127.0.0.1"
fi

curl -fsS "http://${host}:${TASK_HANDOFF_WEB_PORT:-8080}/api/health" >/dev/null
