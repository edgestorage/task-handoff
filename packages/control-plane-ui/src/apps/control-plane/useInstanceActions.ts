import { ref } from "vue";
import {
  deleteControlledInstance,
  restartControlledInstance,
  retryInstanceImageProvisioning,
  startControlledInstance,
  stopControlledInstance,
  syncControlledInstanceConfig,
} from "../../api/queries";
import type { InstanceBoardItem } from "../../api/types";
import { canShowInstanceAction } from "./useInstanceStatus";
import type { Translate } from "../../i18n/status.ts";

export type InstanceAction = "start" | "stop" | "restart" | "retry-image" | "delete";
export type ConfigSyncDirection = "import" | "export";

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
  const activeConfigSyncKey = ref("");

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

  async function runRowConfigSync(direction: ConfigSyncDirection, preset: string, instance: InstanceBoardItem) {
    const key = configSyncKey(instance, direction, preset);
    if (activeConfigSyncKey.value || isInstanceActionBusy(instance)) {
      return;
    }
    activeConfigSyncKey.value = key;
    try {
      await syncControlledInstanceConfig(instance.id, direction, preset);
      await refresh();
    } catch (error) {
      reportActionError(errorText(error));
      await refresh();
    } finally {
      activeConfigSyncKey.value = "";
      closeInstanceMenu();
    }
  }

  function isInstanceActionBusy(instance: InstanceBoardItem) {
    return activeInstanceActionId.value === instance.id;
  }

  function configSyncKey(instance: InstanceBoardItem, direction: ConfigSyncDirection, preset: string) {
    return `${instance.id}:${direction}:${preset}`;
  }

  function isConfigSyncBusy(instance: InstanceBoardItem) {
    return activeConfigSyncKey.value.startsWith(`${instance.id}:`);
  }

  function canExportConfig(instance: InstanceBoardItem) {
    return instance.project?.source.type === "local-folder";
  }

  function configSyncLabel(instance: InstanceBoardItem, direction: ConfigSyncDirection, preset: string, label: string) {
    return activeConfigSyncKey.value === configSyncKey(instance, direction, preset)
      ? t(direction === "import" ? "instances.actions.importing" : "instances.actions.exporting", { name: label })
      : label;
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
    configSyncLabel,
    isConfigSyncBusy,
    isInstanceActionBusy,
    runInstanceAction,
    runRowConfigSync,
    runRowInstanceAction,
    startCreatedInstance,
  };
}
