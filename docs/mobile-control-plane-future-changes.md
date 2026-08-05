# Deferred Mobile Changes

The first release intentionally has no placeholder UI or dormant branches for the following work. Each area requires a separate OpenSpec change before implementation:

- official account login, Control Plane directory, binding, tickets, relay, and push delivery;
- Node or Instance lifecycle management, pairing, updates, installation, deletion, or configuration;
- terminal, full file management, model/environment/application management, triggers, and full settings;
- background push semantics beyond snapshot-first foreground recovery.

Future account connectivity must implement another `MobileControlPlaneTransport` without weakening Direct identity pinning or introducing Node credentials into the mobile process.
