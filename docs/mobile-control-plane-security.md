# Mobile Control Plane Security Model

## Trust boundaries

The mobile app trusts a Control Plane only after validating its HTTPS origin and signed public identity. The saved profile pins `controlPlaneId` and the Ed25519 public-key fingerprint. A changed origin identity is a blocking event, not an automatic migration.

The app communicates only with that Control Plane over same-origin HTTPS and WSS. It never receives Node credentials, direct Node endpoints, pairing material, instance registration tokens, or proxy access targets. Node and Instance screens consume dedicated strict directory projections.

## Protected assets

- Mobile bearer sessions and device identity are stored with this-device-only Keychain/Keystore accessibility. Public profile metadata, its index, and active-profile pointer use bounded app-private file records so profile growth cannot exceed native secure-value limits.
- Passwords exist only during verified login and are not persisted.
- Drafts are versioned and scoped by `(controlPlaneId, instanceId, sessionId)` in app-private document storage; credentials and device identity remain in platform secure storage. Draft writes are serialized, bounded, and deleted with their profile instead of exceeding native Keychain/Keystore value limits.
- Device file URIs and base64 content are transient. Business messages contain only scoped, expiring `upload-ref` values or absolute controlled-instance `runtime-path` references produced from server candidates.
- Metrics use allowlisted dimensions and never contain secrets, session text, paths, attachment names, or message bodies.

## Threats and controls

| Threat | Control |
| --- | --- |
| Malicious URL, embedded credentials, redirect, or non-Control-Plane service | Origin parser accepts production HTTPS origins only, forbids credentials/path/query/fragment, disables redirects, verifies the signed identity schema and signature. |
| TLS failure or certificate/identity change | TLS errors block enrollment; identity fingerprint changes require explicit operator review. No broad TLS bypass exists. |
| Credential exfiltration | Login occurs only after identity verification, uses same-origin requests with `credentials: omit`, and the transport owns the bearer header. |
| Direct Node access | Dependency, source-route, network-owner, and production bundle checks reject Node transports, Node credentials, relay tokens, and network creation outside Direct transport. |
| Cross-profile/session state bleed | Stores, drafts, busy keys, query keys, upload refs, and recovery epochs include the full Control Plane/Instance/Session identity. |
| Duplicate non-idempotent action after packet loss | Send, approval, interrupt, and queue actions enter `result-unknown`, never replay automatically, and recover from an authoritative snapshot. Create keeps one stable `clientRequestId`. |
| Markdown or link execution | Raw HTML tags are removed; only HTTP, HTTPS, and mailto links can invoke the system handler. Unknown schemes remain inert text. |
| Attachment scope/path confusion | Upload refs are server-scoped, expiring, and single-use. Runtime paths originate from server file candidates and remain beneath the authoritative session cwd. Device URI schemes are rejected. |
| Excess native media access | Image selection uses the system library picker without requesting broad library access. The Expo config plugin removes unused camera and microphone permissions, and the boundary check locks that configuration. Picker cache copies are deleted after upload; Android pending picker results are recovered after Activity destruction. |
| Lost device | The Control Plane administrator revokes the mobile session from the authenticated desktop/Web UI. This-device-only storage prevents backup migration but does not replace device lock and remote session revocation. |

## Review checklist

Before release, run mobile boundary, unit, bundle, protocol, Control Plane integration, and native build checks. Review any newly introduced dependency, route, link scheme, persistent field, metric dimension, or native permission against this document.

Cloud Relay profiles use the separately published cloud contract and one installation-wide cloud account session whose refresh credential remains in this-device-only secure storage. One app installation cannot retain Relay profiles for multiple cloud device sessions: switching accounts requires an explicit logout. Logout removes every `cloud-relay` Control Plane profile and credential owned by that account while preserving all manually configured `direct` profiles. Production builds trust only `https://cloud.thandoff.com` and cloud Relay DNS; staging pins one build-time HTTPS origin. Relay transport carries the same shared Control Plane client requests and authoritative snapshots/events as direct transport and does not persist Control Plane passwords, Node endpoints or Node credentials. Removing one Relay profile does not revoke the shared cloud account, while device revocation forces reauthentication without deleting direct profiles.
