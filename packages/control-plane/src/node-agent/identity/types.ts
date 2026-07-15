export type NodeAgentPairingInvite = {
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  controlPlaneName?: string;
  controlPlaneUrl?: string;
};

export type NodeAgentRemoteControlPlane = {
  id: string;
  keyId: string;
  name?: string;
  url?: string;
  secret: string;
  pairedAt: string;
  updatedAt: string;
  active?: boolean;
};

export type PublicNodeAgentRemoteControlPlane = Omit<NodeAgentRemoteControlPlane, "secret"> & {
  current: boolean;
};

export type NodeAgentIdentity = {
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  pairingInvites?: NodeAgentPairingInvite[];
  remoteControlPlanes?: NodeAgentRemoteControlPlane[];
};
