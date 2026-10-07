import { ref } from "vue";
import type { InstanceDeleteResult } from "@task-handoff/protocol/control-plane";
import {
  deleteControlledInstance,
  restartControlledInstance,
  retryInstanceImageProvisioning,
  retryInstanceGitProvisioning,
  startControlledInstance,
  stopControlledInstance,
} from "../../api/queries";
import type { InstanceBoardItem } from "../../api/types";
import { canExportInstanceConfig } from "./instanceConfigSync";
import { canShowInstanceAction } from "./useInstanceStatus";
import type { Translate } from "../../i18n/status.ts";

export type InstanceAction = "start" | "stop" | "restart" | "retry-image" | "retry-git" | "delete";

const actionLoadingKeys: Record<InstanceAction, string> = {
  start: "instances.actions.starting",
  stop: "instances.actions.stopping",
  restart: "instances.actions.restarting",
  "retry-image": "instances.actions.retryingImage",
  "retry-git": "instances.actions.retryingGit",
  delete: "instances.actions.deleting",
};

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
  const deleteDialogInstance = ref<InstanceBoardItem>();
  const deleteResult = ref<InstanceDeleteResult>();
  const deleteError = ref("");

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
    if (action === "delete") {
      deleteDialogInstance.value = instance;
      deleteResult.value = undefined;
      deleteError.value = "";
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
      } else if (action === "retry-git") {
        await retryInstanceGitProvisioning(instance.id);
      }
    } catch (error) {
      reportActionError(errorText(error));
      await refresh();
    } finally {
      activeInstanceAction.value = "";
      activeInstanceActionId.value = "";
    }
  }

  function closeDeleteDialog() {
    if (deleteDialogInstance.value && isInstanceActionBusy(deleteDialogInstance.value)) return;
    deleteDialogInstance.value = undefined;
    deleteResult.value = undefined;
    deleteError.value = "";
  }

  async function confirmDeleteInstance(deleteVolumes: boolean) {
    const instance = deleteDialogInstance.value;
    if (!instance || isInstanceActionBusy(instance)) return;
    activeInstanceAction.value = "delete";
    activeInstanceActionId.value = instance.id;
    deleteError.value = "";
    try {
      const result = await deleteControlledInstance(instance.id, deleteVolumes);
      deleteResult.value = result;
      if (!result.completed) return;
      clearActiveInstance(instance.id);
      await refresh();
      if (!result.retainedVolumes.length) {
        deleteDialogInstance.value = undefined;
        deleteResult.value = undefined;
      }
    } catch (error) {
      deleteError.value = errorText(error);
      reportActionError(deleteError.value);
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
    return t(actionLoadingKeys[action]);
  }

  /**
   * In-flight action copy for row surfaces that need to reflect a request
   * before the authoritative instance record reports the transition.
   */
  function activeInstanceActionLabel(instance: InstanceBoardItem) {
    if (activeInstanceActionId.value !== instance.id || !activeInstanceAction.value) return undefined;
    return t(actionLoadingKeys[activeInstanceAction.value]);
  }

  return {
    activeActionLabel,
    activeInstanceActionLabel,
    canExportConfig,
    closeDeleteDialog,
    confirmDeleteInstance,
    deleteDialogInstance,
    deleteError,
    deleteResult,
    isInstanceActionBusy,
    runInstanceAction,
    runRowInstanceAction,
    startCreatedInstance,
  };
}
