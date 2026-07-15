import { computed, reactive, ref } from "vue";
import { createModel, createNodeModel, deleteModel, deleteNodeModel, reorderModels, updateModel, updateNodeModel } from "../../../api/queries";
import type { ModelApp, ModelConfig, ModelLocation, Node } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";

type UseModelSettingsInput = {
  errorText: (error: unknown) => string;
  models: () => ModelConfig[];
  nodes: () => Node[];
  onModelDeleted: (modelId: string) => void;
  refresh: () => Promise<void>;
};

export function useModelSettings({ errorText, models, nodes, onModelDeleted, refresh }: UseModelSettingsInput) {
  const editingModelId = ref("");
  const savingModelId = ref("");
  const deletingModelId = ref("");
  const modelSaveSuccess = ref("");
  const settingsModel = reactive({
    name: "",
    endpoint: "",
    key: "",
    model: "",
    app: "codex" as ModelApp,
    enabled: true,
    locationScope: "control-plane",
  });

  const formModelBusyId = computed(() => editingModelId.value || "__new_model__");
  const canSaveModel = computed(() => {
    if (!settingsModel.name.trim() || !settingsModel.endpoint.trim() || !settingsModel.model.trim()) {
      return false;
    }
    if (!editingModelId.value && !settingsModel.key.trim()) {
      return false;
    }
    if (!editingModelId.value && settingsModel.locationScope !== "control-plane" && !nodes().some((node) => node.id === settingsModel.locationScope)) {
      return false;
    }
    return settingsModel.app === "codex" || settingsModel.app === "claude";
  });

  function clearModelFeedback() {
    modelSaveSuccess.value = "";
  }

  function resetModelForm() {
    editingModelId.value = "";
    settingsModel.name = "";
    settingsModel.endpoint = "";
    settingsModel.key = "";
    settingsModel.model = "";
    settingsModel.app = "codex";
    settingsModel.enabled = true;
    settingsModel.locationScope = "control-plane";
  }

  function editModel(model: ModelConfig) {
    editingModelId.value = model.id;
    settingsModel.name = model.name;
    settingsModel.endpoint = model.endpoint;
    settingsModel.key = "";
    settingsModel.model = model.model;
    settingsModel.app = model.app;
    settingsModel.enabled = model.enabled;
    const location = model.locations?.find((item) => item.type === "control-plane") || model.locations?.find((item) => item.type === "node");
    settingsModel.locationScope = location?.type === "node" ? location.nodeId : "control-plane";
    clearModelFeedback();
  }

  async function saveModel() {
    if (!canSaveModel.value || savingModelId.value) {
      return;
    }
    const busyId = formModelBusyId.value;
    savingModelId.value = busyId;
    clearModelFeedback();
    try {
      const payload = {
        name: settingsModel.name.trim(),
        endpoint: settingsModel.endpoint.trim(),
        model: settingsModel.model.trim(),
        app: settingsModel.app,
        enabled: settingsModel.enabled,
        ...(settingsModel.key.trim() ? { key: settingsModel.key.trim() } : {}),
      };
      const editing = models().find((model) => model.id === editingModelId.value);
      let saved: ModelConfig;
      let refreshed = false;
      if (editingModelId.value && editing) {
        const locations = editing.locations?.length
          ? editing.locations
          : [{ type: "control-plane", name: editing.name, enabled: editing.enabled, order: editing.order } as const];
        const results = await Promise.allSettled(locations.map((location) => location.type === "node"
          ? updateNodeModel(location.nodeId, editingModelId.value, payload)
          : updateModel(editingModelId.value, payload)));
        await refresh();
        refreshed = true;
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        saved = results.find((result): result is PromiseFulfilledResult<ModelConfig> => result.status === "fulfilled")!.value;
      } else {
        saved = settingsModel.locationScope === "control-plane"
          ? await createModel({ ...payload, key: settingsModel.key.trim() })
          : await createNodeModel(settingsModel.locationScope, { ...payload, key: settingsModel.key.trim() });
      }
      modelSaveSuccess.value = `${saved.name} saved.`;
      resetModelForm();
      if (!refreshed) await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      savingModelId.value = "";
    }
  }

  async function removeModel(model: ModelConfig, location: ModelLocation) {
    if (deletingModelId.value) {
      return;
    }
    const locationName = location.type === "control-plane"
      ? "Control plane"
      : nodes().find((node) => node.id === location.nodeId)?.name || location.nodeId;
    if (!window.confirm(`Delete ${model.name} from ${locationName}? Other locations will be kept.`)) {
      return;
    }
    deletingModelId.value = model.id;
    clearModelFeedback();
    try {
      if (location.type === "node") await deleteNodeModel(location.nodeId, model.id);
      else await deleteModel(model.id);
      if (editingModelId.value === model.id && (model.locations?.length || 1) === 1) {
        resetModelForm();
      }
      onModelDeleted(model.id);
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      deletingModelId.value = "";
    }
  }

  async function moveModel(modelId: string, direction: -1 | 1) {
    const items = models().filter((model) => model.locations?.some((location) => location.type === "control-plane"));
    const index = items.findIndex((model) => model.id === modelId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= items.length || savingModelId.value) {
      return;
    }
    const reordered = [...items];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    savingModelId.value = modelId;
    try {
      await reorderModels(reordered.map((model) => model.id));
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      savingModelId.value = "";
    }
  }

  function canMoveModel(modelId: string, direction: -1 | 1) {
    const items = models().filter((model) => model.locations?.some((location) => location.type === "control-plane"));
    const index = items.findIndex((model) => model.id === modelId);
    const nextIndex = index + direction;
    return index >= 0 && nextIndex >= 0 && nextIndex < items.length;
  }

  return {
    canSaveModel,
    canMoveModel,
    clearModelFeedback,
    deletingModelId,
    editModel,
    editingModelId,
    formModelBusyId,
    modelSaveSuccess,
    moveModel,
    removeModel,
    resetModelForm,
    saveModel,
    savingModelId,
    settingsModel,
  };
}
