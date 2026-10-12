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

## Node agent reachability

An instance inside a distro calls back to the Node Agent on the Windows host. A WSL2 distro lives in
its own network namespace, so `127.0.0.1` inside the distro is the distro itself, and the address the
instance is told to use cannot simply be assumed. Before an instance starts, the Node Agent probes
candidates from inside the distro and writes the first reachable one to `TASK_HANDOFF_NODE_AGENT_URL`:
an explicit override (`TASK_HANDOFF_WSL_NODE_AGENT_URL`, or the `hostAddress` option), then the
distro's `127.0.0.1` (WSL2 mirrored networking shares the host loopback), then the distro default
gateway (the Windows host under the default NAT networking), then the legacy `containerUrl` fallback.
The gateway is read from `/proc/net/route`: the base template ships no `iproute2`, and an
`ip route` based lookup silently degrades the address to the Docker-only `host.docker.internal`
alias, which a distro cannot resolve.

A candidate only wins when `GET <url>/api/node-agent/health` answers 2xx with
`data.role == "node-agent"`, or with a `NODE_AGENT_*` structured error (the external listener requires
an HMAC signature once the node is paired, so `401 NODE_AGENT_HMAC_SIGNATURE_REQUIRED` also proves the
address belongs to this node's Node Agent). A process inside the distro that happens to own the same
port cannot be mistaken for the host Node Agent. When no candidate answers, instance start fails
immediately with `WSL_NODE_AGENT_UNREACHABLE` — including the per-candidate reasons, the listener host
and port, and remediation — instead of leaving the instance in `registering` until registration times
out.

### Host-side allow is required for the distro-to-host direction

Windows filters that traffic by default, in two layers:

- **Windows Defender Firewall.** The `vEthernet (WSL)` adapter is an unidentified network, so it gets
  the Public profile and inbound connections to host services are dropped unless a rule allows them.
  A host service that only listens on `127.0.0.1` is never reachable this way. This is the classic
  WSL behaviour (microsoft/WSL#4139, #4585, #5237) and it is why a distro reaching the node agent port
  times out while the host itself can reach the same port on loopback.
- **WSL Hyper-V firewall.** Since WSL 2.0.9 the Hyper-V firewall filters WSL traffic as well. Measured
  effective policy on a stock Windows 11 25H2 host (WSL `3.0.1.0`):
  `Enabled=True`, `DefaultInboundAction=Block`, `DefaultOutboundAction=Allow`, `LoopbackEnabled=True`,
  `AllowHostPolicyMerge=True`, plus inbound allow rules for ICMP and mDNS only. Because host policy is
  merged (`AllowHostPolicyMerge=True`), an existing Windows Firewall allow rule for the host
  executable already lets the distro through — measured: a Public-profile `Node.js JavaScript Runtime`
  allow rule for `node.exe` made a `0.0.0.0`-bound Node listener reachable from the distro at the
  gateway address.

Pick one of these when a WSL node must be reachable:

- **Mirrored networking (recommended, no administrator rights).** Set `%USERPROFILE%\.wslconfig` to
  `[wsl2]` / `networkingMode=mirrored` and run `wsl --shutdown`. The distro then shares the host
  loopback, so the probe's `127.0.0.1` candidate wins and the default loopback listener works with no
  firewall change. Measured: `wslinfo --networking-mode` reports `mirrored` and the distro reaches the
  node agent with `GET http://127.0.0.1:18091/api/node-agent/health` →
  `401 NODE_AGENT_HMAC_SIGNATURE_REQUIRED`. Mirrored mode is the mode Microsoft recommends for WSL
  networking; it applies to every distro on the machine, and the Node Agent never writes `.wslconfig`
  itself. Watch for VPN and Docker Desktop compatibility, and delete the file to return to NAT.
- **NAT plus a Windows Firewall allow rule (administrator rights).** Allow inbound TCP on the listener
  port for the WSL subnet, and set the node agent external listener bind scope to `all-ipv4`
  (Control Plane → node settings) so the listener accepts the gateway address. Prefer scoping the rule
  to the WSL subnet over opening it to the whole LAN:

  ```powershell
  New-NetFirewallRule -DisplayName "Task Handoff WSL node agent" -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 18091 -RemoteAddress 172.31.192.0/20
  ```

  If the host policy does not merge as expected, add the matching Hyper-V rule
  (`New-NetFirewallHyperVRule -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' …`) and inspect the
  effective state with `Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore -Name
  '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'` and `Get-NetFirewallHyperVRule -VMCreatorId
  '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'`.
- **Or pin an address explicitly** with `TASK_HANDOFF_WSL_NODE_AGENT_URL` to a host address the distro
  can already reach (for example `http://127.0.0.1:<port>` under mirrored networking).

Do not reach for `[wsl2] firewall=false`: measured on Windows 11 25H2 with WSL `3.0.1.0` it changed
nothing — `Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore` stayed identical and a
gateway-bound listener remained unreachable from the distro.

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

Template resolution is Docker-like: the node uses a locally visible template or its node-level cache
when the version it expects is already there, and otherwise **pulls** that version from the same
release channel as the managed runtime artifact (`wsl-base-<version>-<arch>.tar.gz` plus its
manifest, verified against the manifest SHA-256 and written atomically into the cache). The expected
version is the node agent's own release version, so upgrading the app pulls the matching template
automatically. The node agent also prefetches it in the background at startup, so the first instance
creation does not pay for the download. When the channel is unreachable (offline node, or a version
that was never published) the node falls back to whatever version it has locally and logs the
downgrade; a checksum or identity mismatch fails loudly instead of silently downgrading. Set
`TASK_HANDOFF_RUNTIME_RELEASE_BASE_URL` (with a `{version}` placeholder) to point both the runtime
artifact and the template at a mirror.

The packaged template is a portable tar, so it carries no uid/gid and `wsl --import` materialises the
whole rootfs as `root`. Because the Docker image establishes its ownership baseline at build time
(`chown -R agent:agent /workspace /data /home/agent /app` in the `task-handoff-images` base layer),
the Node Agent rebuilds the same baseline inside the distro on first provisioning. Without it the
instance entrypoint cannot create data directories as `agent` (for example
`mkdir: cannot create directory '/data/task-handoff/events': Permission denied`). The step is guarded
by `/var/lib/task-handoff/owner-baseline`, so it also repairs distros imported by older builds and
never re-walks the data directory of a running instance.

The Runtime Package Release workflow builds and attaches this template as a release asset
(`wsl-base-<version>-x64.tar.gz` plus its manifest) for `linux-x64` nodes, using the pinned
`task-handoff-images` commit as the tool baseline, and nodes pull it from there automatically. Point
`TASK_HANDOFF_WSL_BASE_TEMPLATE_DIR` at a folder when you want to pin an air-gapped node to a
template you distributed yourself.

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
