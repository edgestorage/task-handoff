import { computed, reactive, ref, watch } from "vue";
import { MODEL_REQUEST_MAPPING_PRESETS } from "@task-handoff/protocol/control-plane";
import { copyModel, createModel, createNodeModel, deleteModel, deleteNodeModel, discoverModels, mergeModel as mergeModelRequest, reorderModels, syncModel as syncModelRequest, testModel, updateModel } from "../../../api/queries";
import type { DiscoveredModel, ModelApp, ModelConfig, ModelLocation, ModelProtocol, ModelRequestMapping, Node } from "../../../api/types";
import { nodeSupportsModelRequestMappings } from "../../../api/nodeCapabilities";
import { showControlPlaneToast, showDelayedControlPlaneLoadingToast } from "../useControlPlaneToasts";
import type { Translate } from "../../../i18n/status.ts";
import { translateApiError } from "../../../i18n/apiError.ts";

const REQUEST_MAPPING_LIMIT = 64;

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
  const syncingModelId = ref("");
  const mergingModelId = ref("");
  const modelSaveSuccess = ref("");
  const discoveredModels = ref<DiscoveredModel[]>([]);
  const discoveringModels = ref(false);
  const testingModel = ref(false);
  const settingsModel = reactive({
    name: "",
    endpoint: "",
    key: "",
    model: "",
    modelNames: [] as Array<{ name: string; upstreamName?: string; order: number }>,
    mappings: [] as ModelRequestMapping[],
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
  /**
   * Request mappings are stored per model entity. Control-plane records stay
   * editable and degrade visibly per node on sync; a node owned record is
   * editable only while its node declares the capability.
   */
  const mappingsEditable = computed(() => settingsModel.locationScope === "control-plane"
    || nodeSupportsModelRequestMappings(nodes().find((item) => item.id === settingsModel.locationScope)));
  const mappingTargetDefault = () => {
    const primary = settingsModel.modelNames[0];
    return primary?.upstreamName?.trim() || primary?.name.trim() || "";
  };
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
    if (settingsModel.mappings.length > REQUEST_MAPPING_LIMIT) return false;
    if (settingsModel.mappings.some((entry) => !entry.name.trim() || !entry.upstreamName.trim())) return false;
    const mappingNames = new Set<string>();
    if (settingsModel.mappings.some((entry) => {
      const name = entry.name.trim();
      if (mappingNames.has(name)) return true;
      mappingNames.add(name);
      return false;
    })) return false;
    if (!mappingsEditable.value && settingsModel.mappings.length) return false;
    return settingsModel.protocols.length > 0;
  });


  function clearModelFeedback() {
    modelSaveSuccess.value = "";
  }

  function syncPrimaryModelName() { settingsModel.model = settingsModel.modelNames[0]?.name.trim() || ""; }
  function addModelName() { settingsModel.modelNames.push({ name: "", upstreamName: "", order: (settingsModel.modelNames.length + 1) * 100 }); }
  function removeModelName(index: number) { if (settingsModel.modelNames.length > 1) { settingsModel.modelNames.splice(index, 1); syncPrimaryModelName(); } }
  function renumberMappings() { settingsModel.mappings.forEach((entry, index) => { entry.order = (index + 1) * 100; }); }
  function addMapping() {
    if (!mappingsEditable.value || settingsModel.mappings.length >= REQUEST_MAPPING_LIMIT) return;
    settingsModel.mappings.push({ name: "", upstreamName: mappingTargetDefault(), order: (settingsModel.mappings.length + 1) * 100 });
  }
  function removeMapping(index: number) {
    settingsModel.mappings.splice(index, 1);
    renumberMappings();
  }
  function reorderMapping(source: number, target: number) {
    if (source < 0 || target < 0 || source >= settingsModel.mappings.length || target >= settingsModel.mappings.length || source === target) return;
    const [entry] = settingsModel.mappings.splice(source, 1);
    settingsModel.mappings.splice(target, 0, entry);
    renumberMappings();
  }
  function moveMapping(index: number, direction: -1 | 1) {
    reorderMapping(index, index + direction);
  }
  /** Inserts a preset's request names; existing rows and the target stay untouched. */
  function applyMappingPreset(presetId: string) {
    if (!mappingsEditable.value) return;
    const preset = MODEL_REQUEST_MAPPING_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const target = mappingTargetDefault();
    let added = 0;
    for (const name of preset.names) {
      if (settingsModel.mappings.length >= REQUEST_MAPPING_LIMIT) break;
      if (settingsModel.mappings.some((entry) => entry.name.trim() === name)) continue;
      settingsModel.mappings.push({ name, upstreamName: target, order: (settingsModel.mappings.length + 1) * 100 });
      added += 1;
    }
    if (added) showControlPlaneToast(t("settings.modelRegistry.mappingPresetApplied", { count: added }), "success");
    return added;
  }
  /** True when the model name list already resolves this request name. */
  function requestMappingInactive(entry: { name: string }) {
    const name = entry.name.trim();
    return Boolean(name) && settingsModel.modelNames.some((item) => item.name.trim() === name);
  }
  function reorderModelName(source: number, target: number) {
    if (source < 0 || target < 0 || source >= settingsModel.modelNames.length || target >= settingsModel.modelNames.length || source === target) return;
    const [entry] = settingsModel.modelNames.splice(source, 1);
    settingsModel.modelNames.splice(target, 0, entry);
    settingsModel.modelNames.forEach((item, itemIndex) => { item.order = (itemIndex + 1) * 100; });
    syncPrimaryModelName();
  }
  function moveModelName(index: number, direction: -1 | 1) {
    reorderModelName(index, index + direction);
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
      // Probes must address the upstream model, not the external name.
      const probeModel = settingsModel.modelNames[0]?.upstreamName?.trim() || settingsModel.modelNames[0]?.name.trim() || "";
      const results = await Promise.all(settingsModel.protocols.map((protocol) => testModel({
        ...endpointDraft(),
        model: probeModel,
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
    settingsModel.modelNames = [{ name: "", upstreamName: "", order: 100 }];
    settingsModel.mappings = [];
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
    settingsModel.modelNames = model.modelNames?.length
      ? model.modelNames.map((entry) => ({
          name: entry.name,
          upstreamName: entry.upstreamName || entry.name,
          order: entry.order,
        }))
      : [{ name: model.model, upstreamName: model.model, order: 100 }];
    settingsModel.mappings = (model.mappings || []).map((entry) => ({
      name: entry.name,
      upstreamName: entry.upstreamName,
      order: entry.order,
    }));
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
    settingsModel.modelNames = model.modelNames?.length
      ? model.modelNames.map((entry) => ({
          name: entry.name,
          upstreamName: entry.upstreamName || entry.name,
          order: entry.order,
        }))
      : [{ name: model.model, upstreamName: model.model, order: 100 }];
    settingsModel.mappings = (model.mappings || []).map((entry) => ({
      name: entry.name,
      upstreamName: entry.upstreamName,
      order: entry.order,
    }));
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
        modelNames: settingsModel.modelNames.map((entry, index) => ({
          name: entry.name.trim(),
          upstreamName: entry.upstreamName?.trim() || entry.name.trim(),
          order: (index + 1) * 100,
        })),
        mappings: settingsModel.mappings.map((entry, index) => ({
          name: entry.name.trim(),
          upstreamName: entry.upstreamName.trim(),
          order: (index + 1) * 100,
        })),
        protocols: [...settingsModel.protocols],
        app: settingsModel.app,
        enabled: settingsModel.enabled,
        ...(settingsModel.key.trim() ? { key: settingsModel.key.trim() } : {}),
      };
      const editing = models().find((model) => model.id === editingModelId.value);
      let saved: ModelConfig;
      let refreshed = false;
      let syncNotice = "";
      if (editingModelId.value && editing) {
        // One authoritative edit: the control plane keeps the entity id stable
        // and converges the same content onto every node that holds a replica.
        const result = await updateModel(editingModelId.value, payload);
        await refreshModels();
        refreshed = true;
        saved = { ...editing, ...result.model };
        const deferred = result.locations.filter((location) => location.state !== "synced");
        // Surface the actionable per-location reason (for example a node that
        // must be updated first) instead of only a count.
        if (deferred.length) syncNotice = deferred[0].message || t("settings.modelRegistry.syncIncomplete", { count: deferred.length });
      } else if (copyingModelId.value) {
        saved = await copyModel(copyingModelId.value, payload);
      } else {
        saved = settingsModel.locationScope === "control-plane"
          ? await createModel({ ...payload, key: settingsModel.key.trim() })
          : await createNodeModel(settingsModel.locationScope, { ...payload, key: settingsModel.key.trim() });
      }
      resetModelForm();
      if (syncNotice) {
        showControlPlaneToast(syncNotice, "info");
      } else {
        modelSaveSuccess.value = t("settings.modelRegistry.saved", { name: saved.name });
      }
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

  /** Node replicas whose stored content revision differs from the entity's. */
  function staleLocations(model: ModelConfig) {
    return (model.locations || []).filter((location) => location.type === "node"
      && Boolean(location.revision && model.revision && location.revision !== model.revision));
  }

  /**
   * Entities that look like a superseded copy of this one: same app and name.
   * The endpoint may differ because editing it is a normal content change.
   */
  function mergeCandidates(model: ModelConfig) {
    return models().filter((candidate) => candidate.id !== model.id
      && candidate.app === model.app
      && candidate.name === model.name);
  }

  async function syncModelLocations(model: ModelConfig): Promise<boolean> {
    if (syncingModelId.value) return false;
    syncingModelId.value = model.id;
    clearModelFeedback();
    try {
      const result = await syncModelRequest(model.id);
      await refreshModels();
      const failed = result.locations.filter((location) => location.state !== "synced");
      if (failed.length) {
        showControlPlaneToast(failed[0].message || t("settings.modelRegistry.syncFailed"), "error");
        return false;
      }
      showControlPlaneToast(t("settings.modelRegistry.synced"), "success");
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
    } finally {
      syncingModelId.value = "";
    }
  }

  async function mergeModelInto(model: ModelConfig, targetModelId: string): Promise<boolean> {
    if (mergingModelId.value) return false;
    mergingModelId.value = model.id;
    clearModelFeedback();
    try {
      const result = await mergeModelRequest(model.id, targetModelId);
      await refreshModels();
      if (!result.merged) {
        const failure = result.locations.find((location) => !location.merged);
        showControlPlaneToast(failure?.message || t("settings.modelRegistry.syncFailed"), "error");
        return false;
      }
      const reassigned = result.locations.reduce((count, location) => count + location.reassignedInstances.length, 0);
      showControlPlaneToast(t("settings.modelRegistry.merged", { count: reassigned }), "success");
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
    } finally {
      mergingModelId.value = "";
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
    mergeCandidates,
    mergeModelInto,
    mergingModelId,
    modelSaveSuccess,
    modelDraftDirty,
    moveModel,
    removeModel,
    resetModelForm,
    saveModel,
    savingModelId,
    settingsModel,
    staleLocations,
    syncModelLocations,
    syncingModelId,
    testingModel,
    setProtocols,
    addModelName,
    removeModelName,
    moveModelName,
    reorderModelName,
    addMapping,
    applyMappingPreset,
    mappingsEditable,
    moveMapping,
    reorderMapping,
    removeMapping,
    requestMappingInactive,
    fetchModelOptions,
  };
}
