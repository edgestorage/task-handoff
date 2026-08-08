# Mobile Control Plane Operations

## Public Control Plane prerequisites

Expose the user-managed Control Plane through a stable DNS name with a publicly trusted HTTPS certificate. Enable Control Plane authentication. Do not expose a node-agent or controlled-instance endpoint in place of the Control Plane. The reverse proxy must support same-origin WebSocket upgrades for `/api/events` and preserve normal API request sizes for attachment uploads.

Add the address as an origin such as `https://control.example.com`; paths, query strings, embedded credentials, HTTP on non-loopback hosts, and redirects are rejected. Verify the displayed Control Plane ID and signing-key fingerprint before signing in.

## Mobile sessions and AI Sessions

Login creates a separately revocable mobile device session. After login, the app opens AI Session Inbox directly. Node and Instance directories follow authoritative realtime state. Mobile can run the server-authorized Instance start, stop, restart, and image-retry actions and can access supported App Sessions, including terminals. Instance creation/deletion, Node lifecycle repair, application installation, provider/model configuration, and advanced settings remain desktop responsibilities.

The app supports snapshot-first live sessions, history/resume, new sessions, messages, approvals, interrupt, queue actions, sub-agents, mobile uploads, and server-selected runtime files. A runtime path always belongs to the selected controlled instance and must stay within its reported workspace.

## Result unknown

If connectivity disappears after a non-idempotent action is submitted, the app reports that the result is unknown and does not resend it. Wait for snapshot recovery and inspect the current session before deciding on another action. New-session creation is the exception: retries reuse its stable `clientRequestId`, so `created` and `already-created` converge on the same session.

## Lost or replaced device

From the authenticated desktop/Web Control Plane UI, revoke the device's mobile session. Rotate the Control Plane identity only for an actual identity compromise; normal certificate renewal does not require changing the signing identity. A signing-key fingerprint change intentionally blocks an existing profile until the operator reviews and reconnects it.

## Rollback

Rolling back or uninstalling the mobile client does not stop the Control Plane, node-agent, controlled instances, or active AI Sessions. The mobile app is a client projection; authoritative work continues server-side. Revoke unused mobile sessions after rollback.
