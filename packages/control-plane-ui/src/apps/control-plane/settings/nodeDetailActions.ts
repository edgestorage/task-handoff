export type NodeDetailActionStateInput = {
  nodeId: string;
  isBuiltinNode: boolean;
  checkingNodeId: string;
  creatingPairingInviteNodeId: string;
  deletingNodeId: string;
  renamingNodeId: string;
};

export function nodeDetailActionState(input: NodeDetailActionStateInput) {
  const pairingInviteBusy = input.creatingPairingInviteNodeId === input.nodeId;
  const removeBusy = input.deletingNodeId === input.nodeId;
  const menuBusy = pairingInviteBusy || removeBusy;

  return {
    canDelete: !input.isBuiltinNode,
    menu: {
      busy: menuBusy,
      label: menuBusy ? "Node action in progress" : "More node actions",
    },
    check: {
      busy: input.checkingNodeId === input.nodeId,
      disabled: Boolean(input.checkingNodeId),
      label: input.checkingNodeId === input.nodeId ? "Checking connection" : "Check connection",
    },
    rename: {
      busy: input.renamingNodeId === input.nodeId,
      disabled: Boolean(input.renamingNodeId),
      label: input.renamingNodeId === input.nodeId ? "Renaming" : "Rename",
    },
    pairingInvite: {
      busy: pairingInviteBusy,
      disabled: Boolean(input.creatingPairingInviteNodeId),
      label: pairingInviteBusy ? "Generating join token" : "Generate join token",
    },
    remove: {
      busy: removeBusy,
      disabled: Boolean(input.deletingNodeId),
      label: removeBusy ? "Deleting node" : "Delete node",
    },
  };
}
