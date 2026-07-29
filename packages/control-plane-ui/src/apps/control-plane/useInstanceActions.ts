import { ref } from "vue";
import {
  deleteControlledInstance,
  restartControlledInstance,
  retryInstanceImageProvisioning,
  startControlledInstance,
  stopControlledInstance,
} from "../../api/queries";
import type { InstanceBoardItem } from "../../api/types";
import { canExportInstanceConfig } from "./instanceConfigSync";
import { canShowInstanceAction } from "./useInstanceStatus";
import type { Translate } from "../../i18n/status.ts";

export type InstanceAction = "start" | "stop" | "restart" | "retry-image" | "delete";

type UseInstanceActionsInput = {
  clearActiveInstance: (instanceId: string) => void;
  closeInstanceMenu: () => void;
  errorText: (error: unknown) => string;
  notifyError?: (message: string) => void;
  refresh: () => Promise<void>;
  translate: Translate;
};

export function useInstanceActions({ clearActiveInstance, closeInstanceMenu, errorText, notifyError, refresh, translate: t }: UseInstanceActionsInput) {
  const activeInstanceAction = ref<InstanceAction | "">("");
  const activeInstanceActionId = ref("");

  function reportActionError(message: string) {
    notifyError?.(message);
  }

  async function startCreatedInstance(id: string) {
    activeInstanceAction.value = "start";
    activeInstanceActionId.value = id;
    try {
      await startControlledInstance(id);
    } catch (error) {
      reportActionError(t("instances.create.feedback.createdButStartFailed", { error: errorText(error) }));
      await refresh();
    } finally {
      activeInstanceAction.value = "";
      activeInstanceActionId.value = "";
    }
  }

  async function runInstanceAction(action: InstanceAction, instance: InstanceBoardItem) {
    if (isInstanceActionBusy(instance) || !canShowInstanceAction(instance, action)) {
      return;
    }
    if (action === "delete" && !window.confirm(t("instances.actions.deleteConfirm", { name: instance.name }))) {
      return;
    }
    activeInstanceAction.value = action;
    activeInstanceActionId.value = instance.id;
    try {
      if (action === "start") {
        await startControlledInstance(instance.id);
      } else if (action === "stop") {
        await stopControlledInstance(instance.id);
      } else if (action === "restart") {
        await restartControlledInstance(instance.id);
      } else if (action === "retry-image") {
        await retryInstanceImageProvisioning(instance.id);
      } else {
        await deleteControlledInstance(instance.id);
        clearActiveInstance(instance.id);
        await refresh();
      }
    } catch (error) {
      reportActionError(errorText(error));
      await refresh();
    } finally {
      activeInstanceAction.value = "";
      activeInstanceActionId.value = "";
    }
  }

  async function runRowInstanceAction(action: InstanceAction, instance: InstanceBoardItem) {
    await runInstanceAction(action, instance);
    closeInstanceMenu();
  }

  function isInstanceActionBusy(instance: InstanceBoardItem) {
    return activeInstanceActionId.value === instance.id;
  }

  function canExportConfig(instance: InstanceBoardItem) {
    return canExportInstanceConfig(instance);
  }

  function activeActionLabel(instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) {
    if (activeInstanceActionId.value !== instance.id || activeInstanceAction.value !== action) return idleLabel;
    const key: Record<InstanceAction, string> = {
      start: "instances.actions.starting",
      stop: "instances.actions.stopping",
      restart: "instances.actions.restarting",
      "retry-image": "instances.actions.retryingImage",
      delete: "instances.actions.deleting",
    };
    return t(key[action]);
  }

  return {
    activeActionLabel,
    canExportConfig,
    isInstanceActionBusy,
    runInstanceAction,
    runRowInstanceAction,
    startCreatedInstance,
  };
}
