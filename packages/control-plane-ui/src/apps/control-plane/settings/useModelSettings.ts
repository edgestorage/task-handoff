import { computed, reactive, ref } from "vue";
import { createModel, deleteModel, reorderModels, updateModel } from "../../../api/queries";
import type { ModelApp, ModelConfig } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";

type UseModelSettingsInput = {
  errorText: (error: unknown) => string;
  models: () => ModelConfig[];
  onModelDeleted: (modelId: string) => void;
  refresh: () => Promise<void>;
};

export function useModelSettings({ errorText, models, onModelDeleted, refresh }: UseModelSettingsInput) {
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
  });

  const formModelBusyId = computed(() => editingModelId.value || "__new_model__");
  const canSaveModel = computed(() => {
    if (!settingsModel.name.trim() || !settingsModel.endpoint.trim() || !settingsModel.model.trim()) {
      return false;
    }
    if (!editingModelId.value && !settingsModel.key.trim()) {
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
  }

  function editModel(model: ModelConfig) {
    editingModelId.value = model.id;
    settingsModel.name = model.name;
    settingsModel.endpoint = model.endpoint;
    settingsModel.key = "";
    settingsModel.model = model.model;
    settingsModel.app = model.app;
    settingsModel.enabled = model.enabled;
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
      const saved = editingModelId.value ? await updateModel(editingModelId.value, payload) : await createModel({ ...payload, key: settingsModel.key.trim() });
      modelSaveSuccess.value = `${saved.name} saved.`;
      resetModelForm();
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      savingModelId.value = "";
    }
  }

  async function removeModel(model: ModelConfig) {
    if (deletingModelId.value) {
      return;
    }
    if (!window.confirm(`Delete model ${model.name}?`)) {
      return;
    }
    deletingModelId.value = model.id;
    clearModelFeedback();
    try {
      await deleteModel(model.id);
      if (editingModelId.value === model.id) {
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
    const items = [...models()];
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

  return {
    canSaveModel,
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
