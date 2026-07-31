export type NodeAgentPairingInvite = {
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  controlPlaneName?: string;
};

export type NodeAgentControlPlanePairing = {
  id: string;
  keyId: string;
  name?: string;
  secret: string;
  pairedAt: string;
  updatedAt: string;
};

export type PublicNodeAgentControlPlanePairing = Omit<NodeAgentControlPlanePairing, "secret"> & {
  current: boolean;
};

export type NodeAgentControlPlaneConnection = {
  id: string;
  pairingKeyId: string;
  name?: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NodeAgentIdentity = {
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  pairingInvites?: NodeAgentPairingInvite[];
  controlPlanePairings?: NodeAgentControlPlanePairing[];
  controlPlaneConnections?: NodeAgentControlPlaneConnection[];
};
