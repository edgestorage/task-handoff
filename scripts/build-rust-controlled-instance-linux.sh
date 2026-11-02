#!/usr/bin/env bash

# Build the Linux controlled-instance binaries used by the runtime artifact.
# The release workflow runs equivalent commands on native Linux runners; this
# helper keeps local test deployments on the same glibc baseline without
# depending on host-side cross compilers.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARCHS=${TASK_HANDOFF_RUST_CONTROLLED_INSTANCE_ARCHS:-x64,arm64}
OUTPUT_DIR=${TASK_HANDOFF_RUST_CONTROLLED_INSTANCE_BINARIES_DIR:-"$ROOT/release/rust-controlled-instance-binaries"}
IMAGE=${TASK_HANDOFF_RUST_CONTROLLED_INSTANCE_DOCKER_IMAGE:-rust:1.89-bookworm}
X64_IMAGE=${TASK_HANDOFF_RUST_CONTROLLED_INSTANCE_DOCKER_IMAGE_X64:-$IMAGE}
ARM64_IMAGE=${TASK_HANDOFF_RUST_CONTROLLED_INSTANCE_DOCKER_IMAGE_ARM64:-$IMAGE}
# Offline hosts may already have the older Debian 11 Rust image for one
# architecture. Its glibc baseline is still compatible with the Debian 12
# controlled-instance runtime, so use it when the primary pull is unavailable.
FALLBACK_IMAGE=${TASK_HANDOFF_RUST_CONTROLLED_INSTANCE_FALLBACK_DOCKER_IMAGE:-rust:1.89-bullseye}
CARGO_REGISTRY_DIR=${CARGO_REGISTRY_DIR:-${CARGO_HOME:-$HOME/.cargo}/registry}
OFFLINE=${TASK_HANDOFF_RUST_BUILD_OFFLINE:-1}

if [ "$OFFLINE" = 1 ] && [ ! -d "$CARGO_REGISTRY_DIR" ]; then
  printf 'Cargo registry cache is unavailable for an offline build: %s\n' "$CARGO_REGISTRY_DIR" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required to build the Linux controlled-instance binaries.\n' >&2
  exit 1
}

docker info >/dev/null 2>&1 || {
  printf 'The Docker daemon is not available.\n' >&2
  exit 1
}

printf 'Building Linux controlled-instance binaries: %s\n' "$ARCHS"
mkdir -p "$OUTPUT_DIR"
extra_mounts=()
if [ "$OFFLINE" = 1 ]; then
  extra_mounts=(-v "$CARGO_REGISTRY_DIR:/usr/local/cargo/registry:ro")
fi

IFS=',' read -r -a REQUESTED_ARCHS <<<"$ARCHS"
for arch in "${REQUESTED_ARCHS[@]}"; do
  case "$arch" in
    x64) docker_arch=amd64; rust_target=x86_64-unknown-linux-gnu; image=$X64_IMAGE ;;
    arm64) docker_arch=arm64; rust_target=aarch64-unknown-linux-gnu; image=$ARM64_IMAGE ;;
    *)
      printf 'Unsupported controlled-instance architecture: %s\n' "$arch" >&2
      exit 1
      ;;
  esac
  printf '\n==> linux-%s\n' "$arch"
  local_image_platform=$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)
  if [ "$local_image_platform" != "linux/$docker_arch" ]; then
    for attempt in 1 2 3; do
      if docker pull --platform "linux/$docker_arch" "$image"; then
        break
      fi
      if [ "$attempt" -eq 3 ]; then
        fallback_platform=$(docker image inspect "$FALLBACK_IMAGE" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)
        if [ "$fallback_platform" = "linux/$docker_arch" ]; then
          printf 'Could not pull %s for linux/%s; using local fallback %s.\n' "$image" "$docker_arch" "$FALLBACK_IMAGE" >&2
          image=$FALLBACK_IMAGE
          break
        fi
        printf 'Could not pull %s for linux/%s.\n' "$image" "$docker_arch" >&2
        exit 1
      fi
      sleep 3
    done
  fi
  docker run --rm \
    --platform "linux/$docker_arch" \
    -v "$ROOT:/workspace" \
    -v "$OUTPUT_DIR:/out" \
    "${extra_mounts[@]}" \
    -w /workspace/controlled-instance-rs \
    -e CARGO_TARGET_DIR="target/linux-$arch" \
    -e CARGO_NET_OFFLINE="$OFFLINE" \
    -e RUST_TOOLCHAIN="$rust_target" \
    "$image" \
    bash -c '
      set -euo pipefail
      export PATH="/usr/local/rustup/toolchains/1.89.0-${RUST_TOOLCHAIN}/bin:${PATH}"
      cargo build --locked --release -p controlled-instance-cli
      install -m 0755 "$CARGO_TARGET_DIR/release/controlled-instance-rs" \
        "/out/controlled-instance-linux-'"$arch"'"
    '
done

printf '\nControlled-instance Linux binaries:\n'
ls -lh "$OUTPUT_DIR"/controlled-instance-linux-*
