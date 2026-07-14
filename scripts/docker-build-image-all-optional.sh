#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

enable_flags="$(
  awk '
    {
      while (match($0, /TASK_HANDOFF_ENABLE_[A-Z0-9_]+/)) {
        print substr($0, RSTART, RLENGTH)
        $0 = substr($0, RSTART + RLENGTH)
      }
    }
  ' scripts/docker-build-image.sh Dockerfile | sort -u
)"

if [ -n "${enable_flags}" ]; then
  echo "Enabling optional image build flags:"
  for flag in ${enable_flags}; do
    value="$(printenv "${flag}" || true)"
    if [ -z "${value}" ]; then
      export "${flag}=1"
      echo "  ${flag}=1"
    else
      echo "  ${flag}=${value}"
    fi
  done
fi

exec sh scripts/docker-build-image.sh "$@"
