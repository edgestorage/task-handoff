# Controlled Instance Rust Runtime

This workspace is the Rust implementation of the TaskHandoff controlled-instance runtime. Node remains the repository's default runtime and the `v0.0.46` compatibility baseline; select Rust explicitly with `TASK_HANDOFF_CONTROLLED_INSTANCE_IMPLEMENTATION=rust`. This workspace does not move, delete, or silently fall back to the Node implementation.

The only approved exceptions are:

- the JavaScript launcher adapter in `packaging/dist/controlled-instance-cli.js` and `packaging/bin/task-handoff-controlled-instance`;
- the OpenCode Story plugin forwarding adapter;
- the frozen `packages/controlled-instance-ui` Vue application and its prebuilt `ui/**` assets.

The frozen UI is served as static files. It is not being migrated to Rust, and this workspace does not add UI features. Launcher and plugin adapters must remain thin ABI/forwarding layers with no controlled-instance business logic.

## Build and test

Run from `controlled-instance-rs/`:

```sh
cargo fmt --all --check
cargo check --workspace --all-targets
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo check --workspace --all-targets --target x86_64-pc-windows-gnu
```

The Windows GNU check is a compile/type check of `cfg(windows)` code, not a Windows runtime test. It catches Unix-only assumptions but does not prove ConPTY, Job Object, process-tree, signal, or filesystem behavior; those require a Windows runtime on the supported target matrix.

## Migration and differential gates

Run from the repository root:

```sh
node scripts/check-controlled-instance-rust-migration.mjs
node --test test/controlled-instance-route-contract.test.js
node scripts/controlled-instance-differential.mjs --out release/controlled-instance-rust-validation/differential.json
openspec validate rewrite-controlled-instance-in-rust --strict
```

- `check-controlled-instance-rust-migration.mjs` verifies import-closure coverage, Rust ownership, referenced tests, the frozen UI boundary, approved adapters, and the absence of a Node business fallback. It is an ownership/implementation gate, not proof of behavioral parity.
- `controlled-instance-route-contract.test.js` compares `v0.0.46` and target-current Node route registrations with the matrix and Rust production router. The baseline has 201 explicit registrations, including five WebSocket upgrades; target-current Node has 202, with the only extension being `GET /api/internal/instance-shell`.
- `controlled-instance-differential.mjs` starts Node and Rust runtimes and compares normalized HTTP responses for the currently scripted scenarios. It does not yet provide the unified HTTP/WS/CLI/persistence/provider harness required by OpenSpec task 2.4.
- OpenSpec strict validation checks the proposal artifacts; it does not replace runtime acceptance on `192.168.139.109`.

## Run the web runtime

Run from `controlled-instance-rs/`:

```sh
cargo run -p controlled-instance-cli -- web --host 127.0.0.1 --port 8080 --static-dir ../packages/controlled-instance-ui/dist
```

The CLI defaults to the `web` command, matching `task-handoff-controlled-instance`. The frozen Vue UI is consumed from its existing `dist` output; it is not part of the Rust migration.

## Architecture

- `protocol`: controlled-instance wire models, versions, event envelopes, capability documents, IDs.
- `core`: storage paths, atomic writes, permissions, process identity, singleton locks.
- `ai-session`: AI Session authority and event projection.
- `app-runtime`: managed app catalog, sessions, processes, logs, screenshots and proxies.
- `workspace`: repositories, worktrees, credentials, config sync, triggers, Story tool and model configuration.
- `instance`: HTTP/WebSocket service, authentication, event bus, Node Agent client and route wiring.
- `cli`: the `task-handoff-controlled-instance` compatible process entry.
- `test-support`: Node/Rust differential fixtures and normalization helpers.

## Platform status

- Unix PTY creation uses `libc::openpty`, `setsid`, `TIOCSCTTY`, winsize ioctls, and process-group termination. Unix behavior is exercised by workspace tests; Linux runtime evidence comes from the separate acceptance runs.
- Windows PTY creation is implemented with `CreatePseudoConsole`, `CreateProcessW` process attributes, Job Object ownership with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and `taskkill /t` fallback. This is compile-checked for `x86_64-pc-windows-gnu` but has not passed a Windows runtime, ConPTY resize/exit, or process-group differential acceptance.
- macOS and Windows local-runtime artifacts, WSL2 installation, and full platform process smoke tests remain incomplete. See `docs/module-map.md` and the OpenSpec task list for the current gap list.
