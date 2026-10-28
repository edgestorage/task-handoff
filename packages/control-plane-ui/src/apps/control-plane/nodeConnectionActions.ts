import { reactive } from "vue";

import type { Translate } from "../../i18n/status.ts";
import type { Node, NodeStatus } from "../../api/types.ts";

export type NodeConnectionAction = "connect" | "disconnect" | "check";

export type NodeConnectionActionsOptions = {
  checkNode: (nodeId: string) => Promise<NodeStatus>;
  confirmDisconnect: (node: Node) => boolean;
  notify: (message: string, kind: "success" | "error") => void;
  onNodeChecked?: (status: NodeStatus) => void;
  onNodeUpdated?: (node: Node) => void;
  refresh: () => Promise<void>;
  translate: Translate;
  translateError: (error: unknown) => string;
  updateNode: (nodeId: string, input: { connectionEnabled: boolean }) => Promise<Node>;
};

export function createNodeConnectionActions({
  checkNode,
  confirmDisconnect,
  notify,
  onNodeChecked,
  onNodeUpdated,
  refresh,
  translate: t,
  translateError,
  updateNode,
}: NodeConnectionActionsOptions) {
  const actions = reactive<Record<string, NodeConnectionAction>>({});

  function actionFor(nodeId: string) {
    return nodeId ? actions[nodeId] : undefined;
  }

  function refreshInBackground() {
    try {
      void Promise.resolve(refresh()).catch(() => undefined);
    } catch {
      // A projection refresh cannot change the outcome of a committed mutation.
    }
  }

  async function setNodeConnection(node: Node, enabled: boolean) {
    if (!node.id || actionFor(node.id) || (node.connectionEnabled !== false) === enabled) return false;
    if (!enabled && !confirmDisconnect(node)) return false;
    actions[node.id] = enabled ? "connect" : "disconnect";
    try {
      const updated = await updateNode(node.id, { connectionEnabled: enabled });
      onNodeUpdated?.(updated);
      notify(t(enabled
        ? "instances.nodeConnection.reconnectRequested"
        : "instances.nodeConnection.disconnected", { name: node.name || node.id }), "success");
      refreshInBackground();
      return true;
    } catch (error) {
      notify(translateError(error), "error");
      return false;
    } finally {
      delete actions[node.id];
    }
  }

  async function checkNodeConnection(node: Node) {
    if (!node.id || actionFor(node.id) || node.connectionEnabled === false) return false;
    actions[node.id] = "check";
    try {
      const result = await checkNode(node.id);
      onNodeChecked?.(result);
      if (result.status === "online") {
        notify(t("instances.nodeConnection.online", { name: node.name || node.id }), "success");
      } else {
        notify(t("instances.nodeConnection.offline", {
          name: node.name || node.id,
          message: result.error || t("instances.nodeConnection.unknownError"),
        }), "error");
      }
      refreshInBackground();
      return true;
    } catch (error) {
      notify(translateError(error), "error");
      return false;
    } finally {
      delete actions[node.id];
    }
  }

  return {
    actionFor,
    checkNodeConnection,
    setNodeConnection,
  };
}
