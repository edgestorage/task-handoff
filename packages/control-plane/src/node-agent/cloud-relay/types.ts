/**
 * Local, node-private state for the account-level cloud relay binding. The
 * credential, the relay private key and the pinned cloud signing key never
 * leave the node; the cloud only holds hashes, the public key fingerprint and
 * the limited registry projection.
 */
export type NodeAgentCloudRelayBindingStatus = "active" | "rebind-required";

export type NodeAgentCloudRelayStoredError = {
  code: string;
  message: string;
  at: string;
  retryable?: boolean;
};

export type NodeAgentCloudRelayBinding = {
  status: NodeAgentCloudRelayBindingStatus;
  nodeHandle: string;
  accountId: string;
  cloudOrigin: string;
  serviceOrigin: string;
  credential: string;
  credentialExpiresAt: string;
  serviceSigningKey?: { kid: string; publicKey: string };
  relayPublicKey: string;
  relayPrivateKey: string;
  /** Control Plane ids whose pairing was created by a relay claim, so unbind can drop exactly those. */
  pairedControlPlaneIds: string[];
  lastError?: NodeAgentCloudRelayStoredError;
  boundAt: string;
  updatedAt: string;
};
