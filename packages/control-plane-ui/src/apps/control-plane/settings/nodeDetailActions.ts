export type NodeDetailActionStateInput = {
  nodeId: string;
  isBuiltinNode: boolean;
  checkingNodeId: string;
  creatingPairingInviteNodeId: string;
  deletingNodeId: string;
  renamingNodeId: string;
};

export function nodeDetailActionState(input: NodeDetailActionStateInput, t: Translate) {
  const pairingInviteBusy = input.creatingPairingInviteNodeId === input.nodeId;
  const removeBusy = input.deletingNodeId === input.nodeId;
  const menuBusy = pairingInviteBusy || removeBusy;

  return {
    canDelete: !input.isBuiltinNode,
    menu: {
      busy: menuBusy,
      label: menuBusy ? t("settings.nodeDetail.actionInProgress") : t("settings.nodeDetail.moreActions"),
    },
    check: {
      busy: input.checkingNodeId === input.nodeId,
      disabled: Boolean(input.checkingNodeId),
      label: input.checkingNodeId === input.nodeId ? t("settings.nodeDetail.checkingConnection") : t("settings.nodeDetail.checkConnection"),
    },
    rename: {
      busy: input.renamingNodeId === input.nodeId,
      disabled: Boolean(input.renamingNodeId),
      label: input.renamingNodeId === input.nodeId ? t("settings.nodeDetail.renaming") : t("settings.nodeDetail.rename"),
    },
    pairingInvite: {
      busy: pairingInviteBusy,
      disabled: Boolean(input.creatingPairingInviteNodeId),
      label: pairingInviteBusy ? t("settings.nodeDetail.generatingToken") : t("settings.nodeDetail.generateToken"),
    },
    remove: {
      busy: removeBusy,
      disabled: Boolean(input.deletingNodeId),
      label: removeBusy ? t("settings.nodeDetail.deletingNode") : t("settings.nodeDetail.deleteNode"),
    },
  };
}
import type { Translate } from "../../../i18n/status.ts";
