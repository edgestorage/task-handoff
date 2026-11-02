# Controlled Instance v0.0.46 Compatibility Baseline

## Release artifact

| Field | Value |
| --- | --- |
| Release | `v0.0.46` |
| Package | `@task-handoff/controlled-instance` |
| Package version | `0.0.46` |
| Source commit | `445c5402148a99835daa5443754abd3cdb24ac30` |
| Runtime platform | `linux` |
| Runtime architecture | `universal` |
| Manifest format | `1` |
| Launcher ABI | `1` |
| Entrypoint | `dist/controlled-instance-cli.js` |
| Manifest asset | `controlled-instance-runtime-0.0.46-linux-universal.manifest.json` |
| Manifest SHA-256 | `b01774cfe2e4ad48381d674a3c057ad135b916fe3b5c458fcf2f73a39498ab4f` |
| Runtime archive | `controlled-instance-runtime-0.0.46-linux-universal.tar.gz` |
| Runtime archive SHA-256 | `a076ab7f961c9b773e1e8bbdc4c24495e56218d334dc8b82ac409be7a92afd62` |
| Payload SHA-256 | `793c97ab971156665818c1421f564ceabd2db5a29909c77ff994c98c765d44ca` |
| Legacy native dependency | `node-pty` Linux x64 and arm64 prebuilds |

Evidence source: GitHub Release `v0.0.46`, asset metadata returned by `gh release view`, and the published runtime manifest.

## Protocol versions

| Boundary | Version |
| --- | --- |
| Node Agent / Control Plane | `2026-10-02` |
| Instance shell | `2026-10-31` |
| Browser tunnel | `2026-08-29` |
| Story | `2026-09-28` |
| TTY stream | `2026-08-11` |
| Compact event envelope | `2026-08-25` |
| Session stream hello | `1` |

## CLI surface

- Process name: `task-handoff-controlled-instance`
- Default command when no subcommand is supplied: `web`
- Web options: `--host`, `-p/--port`, `--static-dir`
- Environment fallbacks: `TASK_HANDOFF_WEB_HOST`, `TASK_HANDOFF_WEB_PORT`, `TASK_HANDOFF_WEB_STATIC_DIR`
- Hidden commands: `git-credential-helper`, `git-ssh`, `git-ssh-askpass`
- Invalid port, unknown options and unsupported platforms exit non-zero with a safe diagnostic.

## Storage paths

When no override is set, paths are derived from `TASK_HANDOFF_CONFIG` or `$XDG_CONFIG_HOME/task-handoff/config.json` and `TASK_HANDOFF_DATA_DIR`:

| Key | Default |
| --- | --- |
| `configPath` | `$XDG_CONFIG_HOME/task-handoff/config.json` |
| `dataDir` | Parent of `configPath` |
| `appCatalogDir` | `<dataDir>/app-catalog` |
| `appSessionsDir` | `<dataDir>/app-sessions` |
| `triggersDir` | `<dataDir>/triggers` |
| `runtimeDir` | `<dataDir>/runtime` |
| `eventsDir` | `<dataDir>/events` |
| `artifactDir` | `<dataDir>/artifacts` |
| `logDir` | `<dataDir>/logs` |
| `webTokenPath` | `<dataDir>/web-token` |

## Compatibility rules

- Preserve the package identity, manifest schema, launcher ABI, `current` symlink and Node Agent install/update flow.
- Preserve HTTP/WS route names, status codes, JSON field names, errors, revisions and event ordering.
- Read `v0.0.46` JSON with unknown fields ignored and warnings recorded; required fields remain strict.
- Write with temporary file + `fsync` + atomic rename and keep `0700`/`0600` permission boundaries.
- Keep `packages/controlled-instance-ui` frozen. Rust only serves its existing `dist` output and implements its API/WS contract.
