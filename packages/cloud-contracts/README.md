# Cloud Contracts

Minimal public wire contracts shared by the TaskHandoff mobile app, Control Plane, and Cloud endpoints.

This package owns only independently versioned API payloads, capabilities, Relay frames, client response validation, and the end-to-end handshake. Cloud persistence records, repositories, credentials, internal state machines, and service implementation models belong to the Cloud Platform and must not be exported here.
