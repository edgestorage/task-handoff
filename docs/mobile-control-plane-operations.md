# Mobile Control Plane Operations

## Public Control Plane prerequisites

Expose the user-managed Control Plane through a stable DNS name with a publicly trusted HTTPS certificate. Enable Control Plane authentication. Do not expose a node-agent or controlled-instance endpoint in place of the Control Plane. The reverse proxy must support same-origin WebSocket upgrades for `/api/events` and preserve normal API request sizes for attachment uploads.

Add the address as an origin such as `https://control.example.com`; paths, query strings, embedded credentials, HTTP on non-loopback hosts, and redirects are rejected. Verify the displayed Control Plane ID and signing-key fingerprint before signing in.

## Mobile sessions and AI Sessions

Login creates a separately revocable mobile device session. After login, the app opens AI Session Inbox directly. Node and Instance directories follow authoritative realtime state. Mobile can run the server-authorized Instance start, stop, restart, and image-retry actions and can access supported App Sessions, including terminals. Instance creation/deletion, Node lifecycle repair, application installation, provider/model configuration, and advanced settings remain desktop responsibilities.

The app supports snapshot-first live sessions, history/resume, new sessions, messages, approvals, interrupt, queue actions, sub-agents, mobile uploads, and server-selected runtime files. A runtime path always belongs to the selected controlled instance and must stay within its reported workspace.

## Approval center

The mobile client exposes one floating approval center across AI Sessions, Stories, App Sessions, and Instances. It has no button or empty panel when the loaded pending count is zero. When approvals are present, the shield button shows the pending count (`99+` above 99) and expands in place to a list. The list combines five existing domain sources:

- AI Session approvals from the current AI Session snapshot.
- Story decisions from non-archived Stories whose owner advertises decision tools.
- Operation approvals from the authenticated owner's approval snapshot and events.
- Control Plane device trust for `control-plane-device` ownership requests.
- Node control-plane trust for online nodes whose normalized Node Agent capability advertises `controlPlaneTrust`.

The center is a client-side projection. It does not create an approval record, grants permission, or bypass a domain decision API. AI Session approvals remain busy until the AI Session store confirms removal; Story, device trust, and node trust keep their revision and fingerprint fences. Operation approvals keep their existing revision and owner audience.

Expanded state, scroll position, selection, and full-screen detail return are shared across the four primary tabs. Switching Control Plane profile starts a fresh collapsed view for that profile. The keyboard, composer, native tab bar, safe area, device-trust gate, and full-screen approval detail can temporarily close the expanded panel; the user's expansion preference is restored after the obstruction clears. When the last authoritative pending item disappears, the panel collapses and all approval UI is removed. A later item appears as a collapsed button.

### Source diagnostics and retry

The panel remains available for other loaded pending approvals if one source cannot refresh. Its diagnostic identifies the unavailable source with a normalized message and never includes approval text, request identifiers, credentials, or fingerprints. Items from a stale source remain visible but decisions are disabled until a fresh authoritative snapshot or event marks the source ready. Use Retry in the diagnostic area to refresh one retryable source, or all unavailable retryable sources when more than one is failing.

An offline or stale source keeps the last in-memory count for this app run. Cached data does not grant permission. Reconnect and wait for source recovery before deciding. A `409` refreshes that source and preserves the remaining pending items; an unknown result is not retried automatically except for the existing explicitly confirmed Story resume flow.

Node control-plane trust appears only when the normalized node capability is present. Older Node Agents without that field simply omit this source; they do not block AI Session, Story, operation, or Control Plane device approvals. Do not infer support from a package version.

### Web and mobile behavior

Control Plane Web retains its own `ActionInbox` layout and interaction state. Web and mobile share platform-neutral filtering, keys, and ordering helpers through `@task-handoff/control-plane-client`, but they do not share Vue/DOM components or writable business stores. The device-trust rule against a custom overlay applies to Control Plane Web only; the React Native client uses its own approval-center capability and floating overlay.

### Staged rollout and rollback

Roll out in three stages: deploy the shared projection and Web refactor while keeping the mobile entry hidden; deploy the operation approval user-audience event delivery and verify owner Web/mobile delivery with other-user isolation; then expose the mobile provider and overlay. This order lets operators validate snapshots, events, revision fencing, and partial-source diagnostics before users can act from the floating center.

Rolling back the mobile UI or event consumption removes only that client projection. It does not roll back approval records, alter server decision state, stop node-agent or controlled instances, or affect Web `ActionInbox`. Rolling back the server event audience change makes mobile depend on snapshot/reconnect recovery; Web behavior and the domain approval lifecycle remain unchanged. Revoke unused mobile sessions after a mobile client rollback.

## Result unknown

If connectivity disappears after a non-idempotent action is submitted, the app reports that the result is unknown and does not resend it. Wait for snapshot recovery and inspect the current session before deciding on another action. New-session creation is the exception: retries reuse its stable `clientRequestId`, so `created` and `already-created` converge on the same session.

## Lost or replaced device

From the authenticated desktop/Web Control Plane UI, revoke the device's mobile session. Rotate the Control Plane identity only for an actual identity compromise; normal certificate renewal does not require changing the signing identity. A signing-key fingerprint change intentionally blocks an existing profile until the operator reviews and reconnects it.

## Rollback

Rolling back or uninstalling the mobile client does not stop the Control Plane, node-agent, controlled instances, or active AI Sessions. The mobile app is a client projection; authoritative work continues server-side. Revoke unused mobile sessions after rollback.
