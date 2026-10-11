# WSL runtime

The WSL runtime gives Windows nodes an isolated execution domain for controlled instances without
Docker. It is a first-class runtime alongside Docker and Local: same instance API, same state
machine, same Node Agent proxy, and the same managed runtime artifact convergence model.

## Positioning and isolation

- One controlled instance maps to exactly one WSL distro named from the instance id
  (`instance.runtime.containerName`). Distro names are prefixed, injective, and bounded.
- Every distro shares the same WSL2 lightweight VM, so memory and CPU are governed by the host
  global `.wslconfig`. The Node Agent **never** rewrites `.wslconfig` and does not claim per-instance
  CPU or memory ceilings. The runtime capability declares `isolation: "distro"`, which is weaker
  than container isolation.
- Instance access always uses the existing Node Agent proxy (`accessStrategy: "node-proxy"`); the
  Node Agent allocates the port and resolves the distro's `127.0.0.1:<port>` endpoint through WSL2
  localhost forwarding. Distro-internal addresses never become public instance fields.
- WSL instances publish no `runtimeKind: docker` metrics and do not participate in environment
  templates, image profiles, or "save as template".

## Lifecycle and keep-alive

A distro's lifetime is determined by whether an active `wsl.exe` session exists, **not** by
processes inside the distro. Measured idle reclaim is roughly 10–15 seconds, and resident systemd
units do not keep a distro alive. While an instance's desired lifecycle is `running`, the Node Agent
holds a resident `wsl.exe` session, supervises it, and rebuilds it (waking the distro and waiting for
the unit and endpoint health) if it is lost. Supervisory diagnostics distinguish a lost/reclaimed
session from an instance crash.

Stopping an instance stops its systemd unit, releases the keep-alive session, and terminates the
distro while retaining the distro and its data for the next start.

## Base template

Distros are imported from a single, versioned prebuilt base template produced from the
`task-handoff-images` base layer:

```bash
node scripts/build-wsl-base-template.mjs build \
  --rootfs /path/to/base-layer/rootfs \
  --version <tool-baseline-version> \
  --out release/runtime-artifacts/wsl-base
```

The build script enables the systemd boot model (`/etc/wsl.conf`), records observed tool versions for
diagnostics, and emits `wsl-base-<version>-<arch>.tar.gz` plus a manifest. The rootfs must ship a
systemd init: the `task-handoff-images` base layer is a Docker workload with no init, so the release
workflow installs `systemd systemd-sysv dbus` into the exported rootfs before packaging (the build
script fails the build when either `systemd` or `systemctl` is missing). The Node Agent locates the
template via `TASK_HANDOFF_WSL_BASE_TEMPLATE_DIR`, the bundled `runtime-artifacts/wsl-base` directory,
or the `runtime-artifacts` root, verifies its SHA-256, and caches it at the node level for reuse
across instances. The template provides Node, Python, git, and the base system dependencies; it never
embeds the controlled-instance runtime.

The Runtime Package Release workflow builds and attaches this template as a release asset
(`wsl-base-<version>-x64.tar.gz` plus its manifest) for `linux-x64` nodes, using the pinned
`task-handoff-images` commit as the tool baseline. Nodes without the bundled directory can download
those assets and point `TASK_HANDOFF_WSL_BASE_TEMPLATE_DIR` at the containing folder.

## Enabling the runtime

WSL publication is gated by an explicit node-level switch, so rolling upgrades stay safe:

1. Upgrade every Control Plane first (older Control Planes filter unknown runtime types).
2. Enable WSL per node with `TASK_HANDOFF_WSL_RUNTIME_ENABLED=1` (or the stored runtime setting).

The default is off. Turning the switch off stops new WSL publication without silently deleting an
existing runtime record.

## Workspaces

Both Git sources and `local-folder` sources are supported.

- Git workspaces reuse the managed Git workspace provisioning semantics (ref, depth, submodules,
  LFS, subdirectory, and managed credentials). Credentials are bridged into the distro's temporary
  `/run/task-handoff/git-auth` and never enter the base template, public protocol, or logs.
- `local-folder` sources map the Windows path to a drvfs path (`/mnt/<drive>/...`) and expose it as
  the workspace inside the distro. Windows paths and distro paths stay node-private.

## Recovery

The Node Agent reuses the managed-instance recovery path: on restart it re-identifies existing
distros and systemd units, rebuilds keep-alive sessions, and converges the desired controlled-instance
runtime version instead of creating a second instance record. Orphaned distros owned by this node are
reconciled and reported structurally.
