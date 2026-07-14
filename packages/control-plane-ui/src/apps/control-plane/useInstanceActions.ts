import { ref } from "vue";
import {
  deleteControlledInstance,
  restartControlledInstance,
  startControlledInstance,
  stopControlledInstance,
  syncControlledInstanceConfig,
} from "../../api/queries";
import type { InstanceBoardItem } from "../../api/types";
import { canShowInstanceAction } from "./useInstanceStatus";

export type InstanceAction = "start" | "stop" | "restart" | "delete";
export type ConfigSyncDirection = "import" | "export";

type UseInstanceActionsInput = {
  clearActiveInstance: (instanceId: string) => void;
  closeInstanceMenu: () => void;
  errorText: (error: unknown) => string;
  notifyError?: (message: string) => void;
  refresh: () => Promise<void>;
};

export function useInstanceActions({ clearActiveInstance, closeInstanceMenu, errorText, notifyError, refresh }: UseInstanceActionsInput) {
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
      reportActionError(`Instance created, but failed to start: ${errorText(error)}`);
    } finally {
      activeInstanceAction.value = "";
      activeInstanceActionId.value = "";
      await refresh();
    }
  }

  async function runInstanceAction(action: InstanceAction, instance: InstanceBoardItem) {
    if (isInstanceActionBusy(instance) || !canShowInstanceAction(instance, action)) {
      return;
    }
    if (action === "delete" && !window.confirm(`Delete ${instance.name}? This removes the instance record and stops its runtime container if it is running.`)) {
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
      } else {
        await deleteControlledInstance(instance.id);
        clearActiveInstance(instance.id);
      }
      await refresh();
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
    return activeConfigSyncKey.value === configSyncKey(instance, direction, preset) ? `${direction === "import" ? "Importing" : "Exporting"} ${label}` : label;
  }

  function activeActionLabel(instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) {
    return activeInstanceActionId.value === instance.id && activeInstanceAction.value === action ? `${idleLabel}ing` : idleLabel;
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
