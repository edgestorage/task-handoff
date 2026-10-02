# Control Plane CLI (`thctl`)

`thctl` is the command line client for the TaskHandoff Control Plane. It connects to one or more Control Plane deployments, authorizes through the existing Web login, and exposes the same authoritative projections and commands as the Control Plane UI in a scriptable contract.

The CLI never owns state: reads consume Control Plane projections, writes go through the shared `@task-handoff/control-plane-client` API layer, and `thctl schema` exports the declared leaf contract (arguments, options, input/output JSON Schema) as the single machine-readable source.

## Install

```bash
npm install -g @task-handoff/thctl
thctl --help
```

`@task-handoff/thctl` is published by the TaskHandoff runtime release pipeline, so the CLI version matches the server runtime packages (`@task-handoff/server`, `@task-handoff/control-plane`, `@task-handoff/node-agent`). Prereleases are available through the `alpha` and `beta` dist-tags.

From a repository checkout:

```bash
pnpm install
node bin/thctl.js --help          # repository checkout
pnpm runtime:pack:thctl           # build the publishable package
```

`pnpm exec thctl` is not wired in the workspace root: pnpm does not link a project's own bin, so checkout usage goes through `node bin/thctl.js` (or the packed tarball).

## Profiles

A profile is one pinned Control Plane identity. Profiles live in `~/.config/task-handoff/cli` (honoring `XDG_CONFIG_HOME`, overridable through `TASK_HANDOFF_CLI_CONFIG_DIR`).

```bash
thctl profile add https://control.example.com      # first connect pins the identity fingerprint (TOFU)
thctl profile add http://127.0.0.1:8787 --label local
thctl profile list
thctl profile use local
thctl profile show
thctl profile trust <label> --yes                  # re-pin after a verified identity change
thctl profile remove <label>
```

- `profiles.json` stores origin, Control Plane ID, signing-key fingerprint, protocol version and the capability snapshot; it never stores secrets.
- Identity changes are rejected until `profile trust` re-pins the new fingerprint; a normal certificate renewal does not change the fingerprint.
- The Control Plane must declare the `cliSessions` capability. Servers without it are rejected before login with exit code 14.

## Authorization

`thctl login` reuses the Control Plane Web login as an authorization page; the CLI itself never receives the Web session. The approval page is shown to an already signed-in operator, who approves or denies the request, and the CLI exchanges the approval for its own separately revocable `cli` session.

```bash
thctl login                  # browser flow: opens /cli/authorize and receives the loopback callback
thctl login --device         # devices without a browser: user code + verification URL, polled with backoff
thctl whoami
thctl logout                 # revokes the CLI session server-side and clears the local credential
```

- The loopback callback binds `127.0.0.1` on a random port and validates the `state` parameter.
- The device flow prints the user code and `verificationUriComplete`, then polls the token endpoint; `slow_down` doubles the interval, denial and expiry surface as exit code 5.
- The session token is stored in `credentials.json` (0600, directory 0700), never in `profiles.json`.
- CLI sessions appear in the Control Plane session settings and can be revoked there; a revoked session clears the local credential on the next 401.
- Sessions renew automatically when less than seven days remain.

## Local desktop Control Plane

When the desktop app runs its Control Plane without user management (`--auth-mode disabled`), `thctl` connects without any profile setup or Web login:

```bash
thctl whoami        # discovers the local Control Plane, writes the managed `local` profile, mints a local CLI session
```

- Discovery reads the user-level runtime lock (`${TMPDIR}/task-handoff-control-plane-<uid>.lock`, overridable through `TASK_HANDOFF_CONTROL_PLANE_LOCK_PATH`), checks that the recorded owner process is alive with a matching start identity, takes the loopback host and port, and verifies the signed identity document. Port scanning, LAN addresses and non-loopback origins are never trusted.
- The first discovery writes a managed profile: label `local` (or an origin-derived label if `local` is taken), `source: local-discovery`, pinned to the presented identity (TOFU), and set as the default only when no default exists. Manual profiles are never overwritten, and a manual profile for the same origin is reused instead.
- These servers declare `localCliSessions: true` instead of `cliSessions`. That capability allows session minting only on loopback: with no stored credential the CLI calls `POST /api/auth/cli/local` and stores the returned session in `credentials.json` (0600).
- A disabled Control Plane reached remotely refuses local sessions with exit code 14; run `thctl` on that machine, or enable user management and use `thctl login`.
- Local sessions belong to the built-in `Local Operator` account (`local-trust` identity, Admin, all nodes). They appear as regular `cli` sessions that can be listed and revoked in the Control Plane, and account creation plus session minting are audited.
- Local sessions share the 14-day TTL and revocation semantics and are never renewed through `/api/auth/cli/renew`. When the session expires, is revoked, or is rejected with 401, the CLI clears the credential and mints a new session, continuing the current command. `thctl logout` still revokes the server session and clears the credential; the next command mints a fresh local session while the desktop Control Plane is reachable.
- If the desktop Control Plane moves to a new port, the managed profile converges to the new loopback origin and records the identity change (`profile show --json` exposes `source` and `identityChangedAt`).
- Once the Control Plane is switched to `authentication: required`, the local endpoint is rejected and `thctl` falls back to the Web/device authorization flow.

## Command surface

Global options: `--profile <label>`, `--json`, `--yes`, `--dry-run`.

| group | commands |
| --- | --- |
| `profile` | `add`, `list`, `use`, `show`, `remove`, `trust` |
| auth | `login`, `logout`, `whoami` |
| `instance` | `list`, `show`, `create`, `delete`, `start`, `stop`, `restart`, `rename` |
| `ai-session` | `list`, `show`, `history`, `turns`, `turn`, `timeline`, `turn-timeline`, `create`, `send`, `interrupt`, `approval`, `resume`, `read`, `rename`, `fork`, `close`, `model`, `reasoning`, `queue list`, `queue steer`, `queue retry`, `queue remove`, `queue edit`, `queue reorder` |
| `app-session` | `list`, `show`, `start`, `stop`, `rename`, `access`, `restart` |
| `node` | `list`, `show`, `rename` |
| `story` | `list`, `show`, `create`, `update`, `archive`, `restore`, `remove`, `document update`, `document remove`, `document reorder`, `automation list`, `automation show`, `automation create`, `automation update`, `automation remove`, `automation enable`, `automation disable`, `automation run`, `automation runs` |
| `trigger` | `list`, `show`, `create`, `update`, `remove`, `run`, `bind`, `unbind`, `apply` |
| `model` | `list`, `show` |
| `user` | `list`, `show`, `sessions`, `session-revoke` |
| stream | `events` |
| contract | `schema` |

- Data goes to stdout, diagnostics to stderr; `--json` keeps the server wire field names.
- Write commands require confirmation. Non-TTY callers must pass `--yes`; `--dry-run` prints the request (or the ordered requests of a multi-step write) without sending it.
- Exit codes: `0` ok, `2` usage, `3` not implemented, `4` confirmation required, `5` not authenticated, `6` forbidden, `7` not found, `8` conflict, `9` rate limited, `10` network, `11` protocol, `12` server, `13` identity, `14` capability missing, `15` cancelled.
- `thctl schema [group [leaf]] [--format json|md] [--out <file>]` exports the contract; leaves marked `outputMode: json-lines` stream one JSON document per line.
- `story automation create|update` read the automation payload from `--config <file>`: the file never carries `storyId` (it comes from the argument) — `create` takes `{ actionId, schedule, enabled?, policy? }`, `update` takes any non-empty subset of `{ actionId, schedule, enabled, policy }`.

### Instances

```bash
thctl instance list --json
thctl instance show <instanceId> --json
thctl instance create --config ./instance.json --start
thctl instance delete <instanceId> --yes
thctl instance delete <instanceId> --volumes --yes

# ./instance.json：POST /api/controlled-instances 的请求体
# {
#   "nodeId": "node_x",
#   "source": { "type": "local-folder", "path": "/Users/me/project" },
#   "imageSelection": { "imageId": "img_x" },
#   "start": true
# }
```

- `create` 的 `runtimeId` 省略时服务端用 `runtime_local_docker`；`nodeId` 省略时按 project/服务端默认节点解析；Docker runtime 必须能从 `environmentSource`、`imageSelection` 或 project 默认镜像解析出镜像，否则 400 `RUNTIME_IMAGE_REQUIRED`。
- 带 `gitCredentialRetention: "instance-retained"` 的创建要求账号具备 `manage-secrets` 权限，否则退出码 6。
- 创建返回 `startOutcome`：`not-requested`（body 未要求 start）、`started`（已请求启动，Docker 镜像可能仍在 provisioning）、`failed`（已创建但启动失败，错误在 `startOutcome.error`）。
- `delete` 的 `deleteVolumes` 恒为布尔值：不带 `--volumes` 发送 `false`（卷保留），带 `--volumes` 发送 `true`；删除未完成时命令以退出码 8 结束，`volumeResults` 在错误详情里，重跑同一命令即可重试。

## Event stream

```bash
thctl events
thctl events --topic ai.sessions --topic instances
thctl events --topic ai-sessions --instance <instanceId>
thctl events --json | jq -c 'select(.topic == "instances")'
```

`thctl events` subscribes to the existing `/api/events` WebSocket with the CLI session bearer token and writes every event envelope as one JSON line (JSON Lines in both default and `--json` mode).

- `--topic` is repeatable; values are protocol topics (for example `ai.sessions`, `app.sessions`, `instances`, `nodes`, `triggers`, `stories`, `models`) or exact event types. The `ai-sessions` and `app-sessions` spellings are accepted as aliases. `--topic` omitted subscribes to `*`.
- `--instance <instanceId>` scopes the subscription server-side; a scope the account cannot see closes the stream with exit code 6.
- Transport frames (`streams.hello`, keepalive `pong`) are consumed by the CLI and never printed.
- The subscription opts into the hierarchical AI Session projection and explicitly disables resource metric snapshots and the high-frequency AI Session transient streams; only authoritative events are printed.
- Disconnects reconnect with the shared exponential backoff and re-subscribe. Reconnection is snapshot-first: nothing is emitted before the new `streams.hello` handshake completes, and replayed event ids are deduplicated, so consumers never see the same event id twice. The command never falls back to polling.
- Credential rejection (HTTP 401) clears the stored CLI session and exits 5; an initial connection failure exits 10 instead of retrying forever, while a failure after the first authoritative handshake keeps retrying.
- `Ctrl+C` closes the stream and exits 0.

## Minimum server version

The Control Plane must be a release that declares the `cliSessions` capability in its public identity document and exposes the CLI authorization and session routes (or, for the local desktop Control Plane, declares `localCliSessions` and exposes `POST /api/auth/cli/local`). Older Control Planes are rejected with exit code 14 before any local state is written. The pinned protocol version is recorded per profile as `YYYY-MM-DD` and shown by `thctl profile show`.
