#!/bin/sh
set -eu

# Select the JavaScript runtime used by TaskHandoff helper scripts. The helper
# runs in its own environment, so it detects an available runtime unless the
# caller explicitly overrides one.
runtime="${TASK_HANDOFF_JS_RUNTIME:-auto}"
if [ -n "${TASK_HANDOFF_JS_RUNTIME_BIN:-}" ]; then
  exec "${TASK_HANDOFF_JS_RUNTIME_BIN}" "$@"
fi

case "${runtime}" in
  auto)
    if command -v node >/dev/null 2>&1; then
      exec node "$@"
    fi
    if command -v bun >/dev/null 2>&1; then
      exec bun "$@"
    fi
    ;;
  node)
    if command -v node >/dev/null 2>&1; then
      exec node "$@"
    fi
    ;;
  bun)
    if command -v bun >/dev/null 2>&1; then
      exec bun "$@"
    fi
    ;;
  *)
    echo "TASK_HANDOFF_JS_RUNTIME must be auto, node, or bun." >&2
    exit 64
    ;;
esac

echo "JavaScript runtime '${runtime}' is not available (set TASK_HANDOFF_JS_RUNTIME_BIN to override)." >&2
exit 69
