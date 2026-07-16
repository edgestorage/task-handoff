# Codex Control Plane

This repo is evolving from a standalone task handoff CLI into a control plane
for running and supervising Codex work across local and remote workspaces. The
product is organized around four cooperating layers:

- **Control plane**: the web/API management surface. It owns the operator UI,
  node inventory, instance board, chat gateway, and cross-instance AI session
  views.
- **Node agent**: the machine-local runtime manager. It owns node-local
  configuration, runtime resources, controlled instance lifecycle, local folder
  inventory, and host-side session launching.
- **Controlled instance**: a managed workspace runtime, usually Docker today,
  with its own controlled instance API, app runtime, AI sessions, triggers, and metadata.
  The agent is responsible for starting, restoring, stopping, and proxying it.
- **Chat gateway and AI sessions**: the control plane owns Telegram, DingDing,
  Wechat, bindings, and approval routes. AI sessions in each controlled instance
  are the source of truth for conversation state and controls.

Chat integrations such as Telegram, DingDing, Wechat, and future bridges route
through the control-plane gateway to the selected instance's AI-session API.
Controlled instances do not store chat credentials, channels, gateway routing
state, or chat pending tasks.

## Runtime Model

The control plane talks to node agents; node agents manage runtime-specific
resources and expose controlled instances back to the control plane. Docker is
the current primary runtime, with the model structured so Kubernetes and local
host runtimes can be added through runtime capabilities/adapters rather than
special-case UI flows.

Docker image profiles store public registry references with explicit tags or
digests. Node-agents inspect and pull missing images asynchronously when an
instance is created; see
[docs/image-registry-provisioning.md](docs/image-registry-provisioning.md) for
the catalog, inventory, snapshot, and recovery boundaries.

Controlled-instance application installation and removal uses a trusted
built-in catalog and persistent jobs on the final computer; see
[docs/instance-app-management.md](docs/instance-app-management.md) for the
catalog, custom-launcher, safety, event, and support boundaries.

For local Docker testing on this machine, use:

```sh
scripts/docker-up-workspace-local.sh
```

That local helper sets `TASK_HANDOFF_WORKSPACE_HOST=/Users/example/project/work`
before running `pnpm run docker:up:all`, so the container sees that host
directory as `/workspace`. Keep this script local/ignored and do not change the
default `compose.yml` workspace mount for this machine path.

## Server Web Install

Server deployments run the control plane and the server-local node-agent as
separate sibling services. The local node-agent is expected to be up alongside
the web control plane, but it is not a child process of the control plane.

The co-located control plane always manages that local node-agent through its
private Unix socket. In **Settings → Nodes**, the built-in local node can
separately configure the node-agent TCP port and choose loopback-only or all
IPv4 interfaces so other control-planes can pair with it. The socket itself is
always retained and is not a UI setting; remote TCP access continues to require
an invite and paired-HMAC authentication.

On a fresh Debian or Ubuntu server, the bootstrap installer installs Node.js,
Docker, the complete `@task-handoff/server` package, and both systemd services:

```sh
curl -fsSL INSTALL_SERVER_SCRIPT_URL | sudo sh
```

Release distributions should replace `INSTALL_SERVER_SCRIPT_URL` with the URL
of `scripts/install-server.sh` from the same release. See
[docs/server-install.md](docs/server-install.md) for local-tarball installs and
all supported options.

If Node.js and Docker are already installed, install the global server package.
It pins and installs the control-plane, node-agent, and controlled-instance
runtimes at the same version:

```sh
sudo npm install -g @task-handoff/server@latest
sudo task-handoff install
```

Check for and apply npm-based server updates:

```sh
task-handoff check
sudo task-handoff update
```

The aggregate server package also provides `task-handoff control-plane`,
`task-handoff node-agent`, and `task-handoff controlled-instance` as aliases.
The three runtime packages retain their independent executables for standalone
installation.

The aggregate server package can manage both installed systemd services with
`sudo task-handoff start`, `sudo task-handoff stop`, and
`sudo task-handoff restart`. It preserves the node-agent/control-plane startup
and shutdown ordering.

Both commands default to the installed server's release channel: an alpha
install checks `alpha`, a beta install checks `beta`, and a stable install
checks `stable`, which resolves to npm's standard `latest` dist-tag. Use
`--channel` to switch channels explicitly.

This npm updater is only for server runtimes and systemd services. Desktop
application updates use the separate signed desktop release channel.

The control plane provides the fleet update entry under each node's **Updates**
tab. It checks and triggers node-agent and controlled-instance updates through
that node-agent, defaults every operation to `stable`, and records update jobs
on the node. Docker instances follow the selected registry channel and preserve
their per-instance data and agent-home volumes when recreated. Desktop updates
remain separate.

The aggregate server update is exposed at **Settings → Basic → Server updates**,
with stable, beta, and alpha channel selection. Theme and public URL settings
also live in Basic; Desktop keeps its independent application updater.

That creates:

```txt
task-handoff-node-agent.service
task-handoff-control-plane.service
```

Remote nodes install only the node-agent. The control plane serves a generic
installer at `/install-node-agent.sh`; pass a one-time join token generated by
the control plane:

```sh
curl -fsSL https://CONTROL_PLANE_HOST/install-node-agent.sh | sudo sh -s -- \
  --control-plane https://CONTROL_PLANE_HOST \
  --join-token JOIN_TOKEN \
  --npm-package @task-handoff/node-agent \
  --controlled-instance-package @task-handoff/controlled-instance \
  --version 1.0.0
```

See [docs/server-install.md](docs/server-install.md) for install options and
the upgrade flow.

## CLI Usage

The CLI starts the server components and manages node pairing:

```sh
task-handoff control-plane
task-handoff node-agent
task-handoff node-agent-invite
task-handoff web
```

Chat adapters, bindings, AI-session messages, queues, and approvals are managed
by the control plane. The former local receiver, sender socket, MCP handoff tool,
and Ink terminal UI are no longer part of the product.

## Package Bin

The package exposes `task-handoff` as its binary:

```json
{
  "bin": {
    "task-handoff": "bin/task-handoff.js"
  }
}
```

During development, use `pnpm cli help`. After global installation, use
`task-handoff help`.

Before publishing, check the package contents:

```sh
pnpm run pack:dry
```

### Docker releases

Every push to `main` builds and smoke-tests the controlled-instance image, then
publishes it to Docker Hub under the immutable `sha-<commit>` tag. Pushing a
semantic version tag such as `v1.2.3` does not rebuild the image: the Docker
workflow waits for that commit image and promotes it to `v1.2.3` in the
registry. Stable releases also update `latest`; prerelease tags such as
`v1.2.3-rc.1` do not.

Publishing requires the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository
secrets. `DOCKERHUB_IMAGE_NAME` can optionally override the default
`task-handoff-controlled-instance` repository name.

### Desktop releases

With Node.js 22.22.2 or newer, pushing a semantic version tag such as `v1.2.3`
builds signed and notarized macOS arm64/x64 installers plus unsigned Windows
x64 and Linux x64 installers, then attaches them to a GitHub Release. Tags with
a prerelease suffix, such as `v1.2.3-rc.1`, create a GitHub prerelease.
The workflow can also be run manually to validate installers without publishing
a release. Both macOS jobs require these GitHub Actions repository secrets:

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate
- `MAC_CSC_KEY_PASSWORD`: password used when exporting the `.p12` certificate
- `APPLE_API_KEY_P8`: base64-encoded App Store Connect API key `.p8` file
- `APPLE_API_KEY_ID`: App Store Connect API key ID
- `APPLE_API_ISSUER`: App Store Connect API issuer UUID

The workflow rejects missing credentials, signs with hardened runtime, submits
the app to Apple's notary service, staples the resulting ticket, and verifies
the signature, ticket, and Gatekeeper assessment before uploading artifacts.
Windows code signing is not enabled yet.

## Package Map

The codebase is split by responsibility:

```txt
bin/task-handoff.js                    Runtime shim that loads dist/cli.js
apps/cli/src/index.ts                  Commander entrypoint
packages/core/src/core/                Shared chat, diagnostics, and persistence helpers
packages/core/src/storage/             Local storage repositories
packages/controlled-instance/src/web/  Controlled instance HTTP/WebSocket API
packages/app-runtime/src/              Desktop app runtime manager
packages/controlled-instance-ui/src/   Controlled instance Vue web UI
packages/control-plane-ui/src/         Control plane Vue web UI
packages/control-plane/src/control-plane/chat/ Control-plane chat gateway and adapters
packages/web-theme/index.css           Shared web theme public entry
dist/                                  Rollup-built JavaScript used by the CLI
```

## License

TaskHandoff is licensed under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE) for attribution information.
