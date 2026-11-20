# Controlled Instance v0.0.47 Source Compatibility Baseline

## Authority and evidence boundaries

The target release has not been selected. Following the project compatibility rule, the baseline is the newest stable tag reachable from main: `v0.0.47`. Current Node remains the target behavioral implementation and rollback path; release-source compatibility and target-current changes are separate inputs.

| Source | Fixed identity |
| --- | --- |
| Previous release tag / commit | `v0.0.46` / `445c5402148a99835daa5443754abd3cdb24ac30` |
| Selected release tag / commit | `v0.0.47` / `f968aecb5c8c0ec00f37f21e3a022c6aa3cfeb9a` |
| Selected controlled-instance source tree | `8abb6342140ec2c348bb8af26138c82144979e16` |
| Target-current HEAD at this audit | `9b2d6e17cce4a6a65d00f2ed4504f45546256edf` |
| Route evidence | `fixtures/node-routes-v0.0.47.json`, static AST registrations with source origins |
| Runtime artifact | Not fetched or verified in this audit; no v0.0.47 manifest/archive hashes claimed |

The old [v0.0.46 artifact record](baseline-v0.0.46.md) remains historical evidence. Do not replace its version strings and reuse the hashes. Workspace package.json versions are not proof of the release runtime archive version or launcher ABI. Node Agent and instance form one internal version domain; N-1 review covers independently upgraded clients/control-plane and durable historical records, rather than old/new combinations of the private runtime pair.

## Route evidence (U00-B02)

- `v0.0.46`: 201 normalized method/path registrations, five GET WebSocket upgrade markers.
- `v0.0.47`: 202 registrations, six GET upgrade markers.
- Added: `GET /api/internal/instance-shell`, WebSocket, registration-token domain. No removed routes or changed upgrade markers for existing routes.
- Current Node and the Rust router have the same normalized set as the selected release. The Axum trailing-slash proxy alias and structured not-found sentinel remain explicit implementation-only registrations.
- The matrix baseline formerly excluded instance-shell while inventory and Rust metadata still named v0.0.46. Two regression tests reproduced these mismatches; the pinned release snapshot now checks baseline membership/transport separately from current Node/Rust parity.

Reproduce from the repository root (reads Git objects, never checks out over dirty files):

```sh
node scripts/controlled-instance-route-baseline.mjs --ref v0.0.46
node scripts/controlled-instance-route-baseline.mjs --ref v0.0.47
node --test test/controlled-instance-route-contract.test.js
```

The extractor is shared with the Node registration contract. Generation fails on unresolved registrations/direct upgrade listeners. The committed snapshot makes the contract test usable without historical tag objects in a shallow CI checkout. This is registration evidence, not body/status/auth/error/event/stream behavioral certification.

## Protocol and durable-data review (U00-B03)

This delta table accounts for all 41 changed files in the declared source scope between the release tags. It classifies contract impact and routes remaining behavioral work; it does not add a second Node-to-Rust ownership inventory. Source ownership remains in migration-inventory.json. No listed domain is declared behaviorally complete by this table.

### U00-D01: Packaging / dependency declarations

- `packages/ai-session-runtime/package.json`
- `packages/app-runtime/package.json`
- `packages/controlled-instance/package.json`
- `packages/core/package.json`
- `packages/protocol/package.json`

No independent wire contract inferred from package versions; retain release tag/source identity.

### U00-D02: Historical attachment identity / content reads

- `packages/ai-session-runtime/src/ai-session-attachments.ts`
- `packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts`
- `packages/ai-session-runtime/src/ai-session-registry.ts`

U03/U11: durable attachment IDs own content; v0.0.46 OpenCode provider-part IDs need read-side resolution without inventing content. Existing store/provider fixtures are partial evidence.

### U00-D03: Shared session title primitives / exports

- `packages/ai-session-runtime/src/ai-session-title.ts`
- `packages/ai-session-runtime/src/codex-app-server/session/title-generator.ts`
- `packages/ai-session-runtime/src/index.ts`

U04/U07: title prompt/parser and Codex title reuse; no new public session field. Verify selected model/effort and cancellation at provider boundary.

### U00-D04: OpenCode projection, stream and title lifecycle

- `packages/ai-session-runtime/src/opencode.ts`
- `packages/ai-session-runtime/src/opencode/projector.ts`
- `packages/ai-session-runtime/test/opencode-projector.test.ts`

U01/U02/U04: server.connected discovery versus sync hints, buffered text/reasoning ordering, first-title ownership and legacy attachment projection. Projector fixtures do not certify full live provider ordering.

### U00-D05: App runtime PTY/process adapter and OpenCode title config

- `packages/app-runtime/src/managed-app-definitions/opencode/server-config.ts`
- `packages/app-runtime/src/runtime-utils.ts`
- `packages/app-runtime/src/runtime.ts`
- `packages/app-runtime/story-agent-runtime.test.js`

U05/U07: shared core process/PTY ownership and title-agent disable; runtime/stop/env semantics require platform evidence. Internal node-agent/instance implementation is not an independent N-1 pair.

### U00-D06: Instance shell runtime and tests

- `packages/controlled-instance/src/web/instance-shell.ts`
- `packages/controlled-instance/instance-shell.test.ts`

U05/U10/U12: new Node Agent-authenticated GET upgrade in v0.0.47; subprotocol, exec/TTY, resize/signal, limits, drain cleanup. Existing Rust handlers/compile checks are not platform acceptance.

### U00-D07: Instance web integration / capability producer / title model

- `packages/controlled-instance/src/web/server.ts`
- `packages/controlled-instance/src/web/status.ts`
- `packages/controlled-instance/src/web/session-title-model.ts`

U01/U04/U07/U10: web server wires shell lifecycle and title generation, publishes additive capability and resolves attachment reads; no extra routes beyond shell. Preserve private model credentials and selected model boundary.

### U00-D08: Core JavaScript runtime, process tree and PTY

- `packages/core/src/core/javascript-runtime.ts`
- `packages/core/src/core/process-tree.ts`
- `packages/core/src/core/pty.ts`

U05/U12/U13: implementation/platform adapter boundaries, not extra controlled-instance public APIs. Verify cancellation, signals, descendants, environment and supported platform runtimes.

### U00-D09: Server installer JavaScript-runtime preservation

- `packages/core/src/core/server-update-installation.ts`

Outside controlled-instance behavior: server update installer now forwards configured runtime. Keep upgrade/rescue context; do not migrate the Control Plane/Node Agent installer into Rust instance.

### U00-D10: Immutable scalar schema reuse

- `packages/protocol/src/ai-sessions.ts`
- `packages/protocol/src/triggers.ts`
- `packages/protocol/src/internal/text-schemas.ts`

U00 static: expanding new scalar aliases in ai-sessions.ts/triggers.ts gives byte-identical v0.0.46 source after deleting the new import. This establishes this refactor classification, not complete schema/runtime equivalence.

### U00-D11: Controlled-instance shell capability and model-provider capability

- `packages/protocol/src/control-plane.ts`

U07/U10: shell capability is additive; absence/invalid values close only that domain. Provider image capability is additive model configuration; historical missing/invalid values sanitize to text-only, and NodeModelPublicRecord omits the field for old readers. Control-plane relay event/sanitizer allocation changes remain at their owner.

### U00-D12: Directory shell capability projection

- `packages/protocol/src/control-plane-directory.ts`

Control Plane/client boundary: missing/malformed shell sub-capability disables only shell; U10 checks instance producer contract without migrating the directory service.

### U00-D13: Instance-shell wire model and source tests

- `packages/protocol/src/instance-shell.ts`
- `packages/protocol/test/instance-shell.test.ts`

U10/U12: framed shell capability/subprotocol/version and strict action schemas. This is node-agent/instance private version domain; independent consumers still gate through public capability.

### U00-D14: Node Agent capabilities / Control Plane trust events

- `packages/protocol/src/node-agent-capabilities.ts`
- `packages/protocol/src/node-agent-control-plane-trust.ts`

Outside instance ownership: providerCapabilities and controlPlaneTrust capability queries plus trust invalidation event belong to Node Agent/Control Plane. Preserve protocol-package read compatibility; no instance trust owner or separate capability system.

### U00-D15: Operation-approval generation / permission

- `packages/protocol/src/operation-approvals.ts`

Outside instance: Control Plane approval register generation and administrator permission. Do not confuse with provider approval actions in U01/U04.

### U00-D16: WebSocket bridge pre-captured frames

- `packages/protocol/src/websocket-bridge.ts`

U02/U10: shared bridge accepts initialClientFrames, subject to existing queue/backlog semantics. Inspect actual instance callers before claiming a new instance path; source-package export alone is insufficient.

### U00-D17: Protocol export surface

- `packages/protocol/src/index.ts`

New instance-shell export. Compatibility/barrel inclusion does not make every exported Control Plane model an instance business owner.

### U00-D18: Existing protocol compatibility test expectations

- `packages/protocol/test/codex-settings.test.ts`
- `packages/protocol/test/model-selection-v0.0.23-compatibility.test.ts`

U07: codex-settings and legacy v0.0.23 model-selection tests accommodate provider capability shape; current source test expectations are not direct evidence of Rust replay.

## Target-current and dirty scope (U00-B04)

After v0.0.47, the current Node production source changes are chiefly instance-private managed CLI catalog/resolution/environment, installation admission/active-session accounting, installer/update recipe and workspace-root resolution, shell preparation, and diagnostics. OpenCode adds a 30-second timeline projection freshness window, in-flight refresh deduplication, and 300ms event reconciliation coalescing. The two protocol files add the optional connectionEnabled flag to Control Plane node-event/directory projections, outside the instance business owner. These are target-current semantics to validate in U04/U05/U06/U07/U12; they do not add HTTP registrations or redefine the frozen release snapshot.

At audit start the current worktree contained prior uncommitted Rust parity repairs and shared fixtures/tests. Node production source itself had no uncommitted edits; the Node test/projector fixtures did. The fixed HEAD alone therefore does not identify the Rust target: retain the dirty diff and fixture files in this branch. Do not run an old dist bundle as current-source evidence.

## Compatibility requirements retained

- Existing client capability documents may omit additive sub-capabilities; normalize after validation and disable only the unsupported domain. Do not change a connection protocol date for migration bookkeeping.
- Historical provider-part attachment IDs resolve only within their owning message's durable manifests; missing content remains missing. Provider titles/chunk state stay in their provider boundary.
- Public models remain minimal. Private model keys, runtime topology, shell tasks and ephemeral tokens do not enter public/persistent session models.
- Read-side migrate/sanitize precedes current parsing; unknown fields do not invalidate whole snapshots. API mutation inputs can remain strict.
- Upgrade/rescue and rollback require separate artifact/runtime evidence. This U00 source audit does not certify a platform, release a default Rust artifact, or authorize deployment.

U00 completion means source identities, route partition and the above delta classification are reconciled. Full per-route behavior, source-test replay, WS/CLI/provider recordings, historical-data execution, platform runtime and upgrade/rollback remain in the project acceptance board.
