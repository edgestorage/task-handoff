import type { NodeConnectionAction } from "../useNodeConnectionActions.ts";
import type { Translate } from "../../../i18n/status.ts";

export type NodeDetailActionStateInput = {
  nodeId: string;
  isBuiltinNode: boolean;
  connectionEnabled: boolean;
  connectionAction?: NodeConnectionAction;
  creatingPairingInviteNodeId: string;
  deletingNodeId: string;
  renamingNodeId: string;
};

export function nodeDetailActionState(input: NodeDetailActionStateInput, t: Translate) {
  const connectionBusy = input.connectionAction === "connect" || input.connectionAction === "disconnect";
  const checkingConnection = input.connectionAction === "check";
  const pairingInviteBusy = input.creatingPairingInviteNodeId === input.nodeId;
  const removeBusy = input.deletingNodeId === input.nodeId;
  const menuBusy = Boolean(input.connectionAction) || pairingInviteBusy || removeBusy;

  return {
    canDelete: !input.isBuiltinNode,
    menu: {
      busy: menuBusy,
      disabled: Boolean(input.connectionAction),
      label: menuBusy ? t("settings.nodeDetail.actionInProgress") : t("settings.nodeDetail.moreActions"),
    },
    check: {
      busy: checkingConnection,
      disabled: !input.connectionEnabled || Boolean(input.connectionAction),
      label: checkingConnection ? t("settings.nodeDetail.checkingConnection") : t("settings.nodeDetail.checkConnection"),
    },
    connection: {
      busy: connectionBusy,
      disabled: Boolean(input.connectionAction),
      label: connectionBusy
        ? input.connectionEnabled
          ? t("instances.list.nodeDisconnectPending")
          : t("instances.list.nodeConnectPending")
        : input.connectionEnabled
          ? t("instances.nodeConnection.disconnect")
          : t("instances.nodeConnection.reconnect"),
    },
    rename: {
      busy: input.renamingNodeId === input.nodeId,
      disabled: Boolean(input.renamingNodeId) || Boolean(input.connectionAction),
      label: input.renamingNodeId === input.nodeId ? t("settings.nodeDetail.renaming") : t("settings.nodeDetail.rename"),
    },
    pairingInvite: {
      busy: pairingInviteBusy,
      disabled: Boolean(input.creatingPairingInviteNodeId) || Boolean(input.connectionAction),
      label: pairingInviteBusy ? t("settings.nodeDetail.generatingToken") : t("settings.nodeDetail.generateToken"),
    },
    remove: {
      busy: removeBusy,
      disabled: Boolean(input.deletingNodeId) || Boolean(input.connectionAction),
      label: removeBusy ? t("settings.nodeDetail.deletingNode") : t("settings.nodeDetail.deleteNode"),
    },
  };
}
