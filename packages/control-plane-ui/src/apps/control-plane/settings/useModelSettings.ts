import { computed, reactive, ref, watch } from "vue";
import { copyModel, createModel, createNodeModel, deleteModel, deleteNodeModel, discoverModels, reorderModels, testModel, updateModel, updateNodeModel } from "../../../api/queries";
import type { DiscoveredModel, ModelApp, ModelConfig, ModelLocation, ModelProtocol, Node } from "../../../api/types";
import { showControlPlaneToast, showDelayedControlPlaneLoadingToast } from "../useControlPlaneToasts";
import type { Translate } from "../../../i18n/status.ts";
import { translateApiError } from "../../../i18n/apiError.ts";

type UseModelSettingsInput = {
  errorText: (error: unknown) => string;
  models: () => ModelConfig[];
  nodes: () => Node[];
  onModelDeleted: (modelId: string) => void;
  refreshModels: () => Promise<void>;
  translate: Translate;
};

function legacyProtocols(app: ModelApp): ModelProtocol[] {
  return app === "claude" ? ["anthropic-messages"] : app === "opencode" ? ["openai-chat-completions"] : ["openai-responses"];
}

export function useModelSettings({ errorText, models, nodes, onModelDeleted, refreshModels, translate: t }: UseModelSettingsInput) {
  const translateError = (error: unknown) => translateApiError(error, t, errorText(error));
  const editingModelId = ref("");
  const copyingModelId = ref("");
  const savingModelId = ref("");
  const deletingModelId = ref("");
  const modelSaveSuccess = ref("");
  const discoveredModels = ref<DiscoveredModel[]>([]);
  const discoveringModels = ref(false);
  const testingModel = ref(false);
  const settingsModel = reactive({
    name: "",
    endpoint: "",
    key: "",
    model: "",
    modelNames: [] as Array<{ name: string; order: number }>,
    protocols: ["openai-responses"] as ModelProtocol[],
    app: "codex" as ModelApp,
    enabled: true,
    locationScope: "control-plane",
  });
  const initialDraft = ref("");
  const serializeDraft = () => JSON.stringify({ ...settingsModel });
  initialDraft.value = serializeDraft();
  const modelDraftDirty = computed(() => serializeDraft() !== initialDraft.value);

  const formModelBusyId = computed(() => editingModelId.value || copyingModelId.value || "__new_model__");
  const selectedNodeSupportsModelEndpointProbe = computed(() => {
    if (settingsModel.locationScope === "control-plane") return true;
    const node = nodes().find((item) => item.id === settingsModel.locationScope);
    const agent = node?.capabilities?.agent;
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) return false;
    const capabilities = (agent as Record<string, unknown>).capabilities;
    return Boolean(capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
      && (capabilities as Record<string, unknown>).modelEndpointProbe === true);
  });
  const canDiscoverModels = computed(() => Boolean(
    selectedNodeSupportsModelEndpointProbe.value
    &&
    settingsModel.endpoint.trim()
    && (settingsModel.key.trim() || editingModelId.value || copyingModelId.value),
  ));
  const canTestModel = computed(() => canDiscoverModels.value && Boolean(settingsModel.model.trim()) && settingsModel.protocols.length > 0);
  const canSaveModel = computed(() => {
    if (!settingsModel.name.trim() || !settingsModel.endpoint.trim() || !settingsModel.modelNames[0]?.name.trim()) {
      return false;
    }
    if (!settingsModel.modelNames.length || settingsModel.modelNames.some((entry) => !entry.name.trim())) return false;
    if (!editingModelId.value && !copyingModelId.value && !settingsModel.key.trim()) {
      return false;
    }
    if (copyingModelId.value && !settingsModel.key.trim()) {
      const source = models().find((model) => model.id === copyingModelId.value);
      if (source && source.endpoint === settingsModel.endpoint.trim() && source.model === settingsModel.model.trim()) return false;
    }
    if (!editingModelId.value && settingsModel.locationScope !== "control-plane" && !nodes().some((node) => node.id === settingsModel.locationScope)) {
      return false;
    }
    return settingsModel.protocols.length > 0;
  });


  function clearModelFeedback() {
    modelSaveSuccess.value = "";
  }

  function syncPrimaryModelName() { settingsModel.model = settingsModel.modelNames[0]?.name.trim() || ""; }
  function addModelName() { settingsModel.modelNames.push({ name: "", order: (settingsModel.modelNames.length + 1) * 100 }); }
  function removeModelName(index: number) { if (settingsModel.modelNames.length > 1) { settingsModel.modelNames.splice(index, 1); syncPrimaryModelName(); } }
  function moveModelName(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= settingsModel.modelNames.length) return;
    [settingsModel.modelNames[index], settingsModel.modelNames[next]] = [settingsModel.modelNames[next], settingsModel.modelNames[index]];
    settingsModel.modelNames.forEach((entry, itemIndex) => { entry.order = (itemIndex + 1) * 100; });
    syncPrimaryModelName();
  }

  function setProtocols(values: unknown) {
    const supported = new Set<ModelProtocol>(["openai-responses", "openai-chat-completions", "anthropic-messages"]);
    settingsModel.protocols = Array.isArray(values)
      ? values.filter((value): value is ModelProtocol => typeof value === "string" && supported.has(value as ModelProtocol))
      : [];
    if (settingsModel.protocols.includes("openai-responses")) settingsModel.app = "codex";
    else if (settingsModel.protocols.includes("anthropic-messages")) settingsModel.app = "claude";
    else settingsModel.app = "opencode";
  }

  watch(
    () => [settingsModel.endpoint, settingsModel.key, settingsModel.locationScope, editingModelId.value, copyingModelId.value],
    () => {
      discoveredModels.value = [];
    },
  );

  function endpointDraft() {
    return {
      endpoint: settingsModel.endpoint.trim(),
      ...(settingsModel.key.trim() ? { key: settingsModel.key.trim() } : {}),
      ...(editingModelId.value || copyingModelId.value ? { existingModelId: editingModelId.value || copyingModelId.value } : {}),
    };
  }

  function endpointNodeId() {
    return settingsModel.locationScope === "control-plane" ? undefined : settingsModel.locationScope;
  }

  async function fetchModelOptions() {
    if (!canDiscoverModels.value || discoveringModels.value) return;
    discoveringModels.value = true;
    const loadingToast = showDelayedControlPlaneLoadingToast(t("settings.modelRegistry.discovering"));
    try {
      const result = await discoverModels(endpointDraft(), endpointNodeId());
      discoveredModels.value = result.models;
      loadingToast.dismiss();
      showControlPlaneToast(result.models.length
        ? t("settings.modelRegistry.discovered", { count: result.models.length, latency: result.latencyMs })
        : t("settings.modelRegistry.discoveredEmpty", { latency: result.latencyMs }), "success");
    } catch (error) {
      loadingToast.dismiss();
      showControlPlaneToast(translateError(error));
    } finally {
      loadingToast.dismiss();
      discoveringModels.value = false;
    }
  }

  async function checkModel() {
    if (!canTestModel.value || testingModel.value) return;
    testingModel.value = true;
    const loadingToast = showDelayedControlPlaneLoadingToast(t("settings.modelRegistry.testing"));
    try {
      const results = await Promise.all(settingsModel.protocols.map((protocol) => testModel({
        ...endpointDraft(),
        model: settingsModel.modelNames[0]?.name.trim() || "",
        protocol,
      }, endpointNodeId())));
      const latencyMs = Math.max(...results.map((result) => result.latencyMs));
      loadingToast.dismiss();
      showControlPlaneToast(t("settings.modelRegistry.testSucceeded", { latency: latencyMs }), "success");
    } catch (error) {
      loadingToast.dismiss();
      showControlPlaneToast(translateError(error));
    } finally {
      loadingToast.dismiss();
      testingModel.value = false;
    }
  }

  function resetModelForm() {
    editingModelId.value = "";
    copyingModelId.value = "";
    settingsModel.name = "";
    settingsModel.endpoint = "";
    settingsModel.key = "";
    settingsModel.model = "";
    settingsModel.modelNames = [{ name: "", order: 100 }];
    settingsModel.protocols = ["openai-responses"];
    settingsModel.app = "codex";
    settingsModel.enabled = true;
    settingsModel.locationScope = "control-plane";
    clearModelFeedback();
    initialDraft.value = serializeDraft();
  }

  function editModel(model: ModelConfig) {
    editingModelId.value = model.id;
    copyingModelId.value = "";
    settingsModel.name = model.name;
    settingsModel.endpoint = model.endpoint;
    settingsModel.key = "";
    settingsModel.model = model.model;
    settingsModel.modelNames = model.modelNames?.length ? model.modelNames.map((entry) => ({ ...entry })) : [{ name: model.model, order: 100 }];
    settingsModel.protocols = model.protocols?.length ? [...model.protocols] : legacyProtocols(model.app);
    settingsModel.app = model.app;
    settingsModel.enabled = model.enabled;
    const location = model.locations?.find((item) => item.type === "control-plane") || model.locations?.find((item) => item.type === "node");
    settingsModel.locationScope = location?.type === "node" ? location.nodeId : "control-plane";
    clearModelFeedback();
    initialDraft.value = serializeDraft();
  }

  function copyModelDraft(model: ModelConfig) {
    editingModelId.value = "";
    copyingModelId.value = model.id;
    settingsModel.name = t("settings.modelRegistry.copyName", { name: model.name });
    settingsModel.endpoint = model.endpoint;
    settingsModel.key = "";
    settingsModel.model = model.model;
    settingsModel.modelNames = model.modelNames?.length ? model.modelNames.map((entry) => ({ ...entry })) : [{ name: model.model, order: 100 }];
    settingsModel.protocols = model.protocols?.length ? [...model.protocols] : legacyProtocols(model.app);
    settingsModel.app = model.app;
    settingsModel.enabled = model.enabled;
    settingsModel.locationScope = "control-plane";
    clearModelFeedback();
    initialDraft.value = serializeDraft();
  }

  async function saveModel(): Promise<boolean> {
    if (!canSaveModel.value || savingModelId.value) {
      return false;
    }
    const busyId = formModelBusyId.value;
    savingModelId.value = busyId;
    clearModelFeedback();
    try {
      const payload = {
        name: settingsModel.name.trim(),
        endpoint: settingsModel.endpoint.trim(),
        model: settingsModel.modelNames[0]?.name.trim() || "",
        modelNames: settingsModel.modelNames.map((entry, index) => ({ name: entry.name.trim(), order: (index + 1) * 100 })),
        protocols: [...settingsModel.protocols],
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
        await refreshModels();
        refreshed = true;
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        saved = results.find((result): result is PromiseFulfilledResult<ModelConfig> => result.status === "fulfilled")!.value;
      } else if (copyingModelId.value) {
        saved = await copyModel(copyingModelId.value, payload);
      } else {
        saved = settingsModel.locationScope === "control-plane"
          ? await createModel({ ...payload, key: settingsModel.key.trim() })
          : await createNodeModel(settingsModel.locationScope, { ...payload, key: settingsModel.key.trim() });
      }
      resetModelForm();
      modelSaveSuccess.value = t("settings.modelRegistry.saved", { name: saved.name });
      if (!refreshed) await refreshModels();
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
    } finally {
      savingModelId.value = "";
    }
  }

  async function removeModel(model: ModelConfig, location: ModelLocation): Promise<boolean> {
    if (deletingModelId.value) {
      return false;
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
      await refreshModels();
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
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
      await refreshModels();
    } catch (error) {
      showControlPlaneToast(translateError(error));
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
    selectedNodeSupportsModelEndpointProbe,
    canDiscoverModels,
    canTestModel,
    checkModel,
    canMoveModel,
    clearModelFeedback,
    deletingModelId,
    discoveredModels,
    discoveringModels,
    copyingModelId,
    copyModelDraft,
    editModel,
    editingModelId,
    formModelBusyId,
    modelSaveSuccess,
    modelDraftDirty,
    moveModel,
    removeModel,
    resetModelForm,
    saveModel,
    savingModelId,
    settingsModel,
    testingModel,
    setProtocols,
    addModelName,
    removeModelName,
    moveModelName,
    fetchModelOptions,
  };
}
