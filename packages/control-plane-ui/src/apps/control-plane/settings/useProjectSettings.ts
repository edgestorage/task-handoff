import { computed, reactive, ref } from "vue";
import { createProject, deleteProject, updateProject } from "../../../api/queries";
import type { Project } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const DEFAULT_SELECT_VALUE = "__default__";

type UseProjectSettingsInput = {
  errorText: (error: unknown) => string;
  onProjectDeleted: (projectId: string) => void;
  projectInUse: (projectId: string) => boolean;
  refresh: () => Promise<void>;
};

export function useProjectSettings({ errorText, onProjectDeleted, projectInUse, refresh }: UseProjectSettingsInput) {
  const creatingSettingsProject = ref(false);
  const deletingProjectId = ref("");
  const savingProjectModelId = ref("");
  const settingsProjectSuccess = ref("");
  const settingsProject = reactive({
    name: "",
    url: "",
    defaultImageId: "",
    defaultRuntimeId: "",
    codexModelId: "",
    claudeModelId: "",
  });

  const settingsDefaultImageSelectValue = computed({
    get: () => settingsProject.defaultImageId || DEFAULT_SELECT_VALUE,
    set: (value: string) => {
      settingsProject.defaultImageId = value === DEFAULT_SELECT_VALUE ? "" : value;
    },
  });
  const settingsDefaultRuntimeSelectValue = computed({
    get: () => settingsProject.defaultRuntimeId || DEFAULT_SELECT_VALUE,
    set: (value: string) => {
      settingsProject.defaultRuntimeId = value === DEFAULT_SELECT_VALUE ? "" : value;
    },
  });
  const settingsCodexModelSelectValue = computed({
    get: () => settingsProject.codexModelId || DEFAULT_SELECT_VALUE,
    set: (value: string) => {
      settingsProject.codexModelId = value === DEFAULT_SELECT_VALUE ? "" : value;
    },
  });
  const settingsClaudeModelSelectValue = computed({
    get: () => settingsProject.claudeModelId || DEFAULT_SELECT_VALUE,
    set: (value: string) => {
      settingsProject.claudeModelId = value === DEFAULT_SELECT_VALUE ? "" : value;
    },
  });
  const canCreateSettingsProject = computed(() => {
    if (!settingsProject.name.trim()) {
      return false;
    }
    return Boolean(settingsProject.url.trim());
  });

  function clearProjectFeedback() {
    settingsProjectSuccess.value = "";
  }

  function removeModelSelection(modelId: string) {
    if (settingsProject.codexModelId === modelId) {
      settingsProject.codexModelId = "";
    }
    if (settingsProject.claudeModelId === modelId) {
      settingsProject.claudeModelId = "";
    }
  }

  function clearDefaultImage(imageId: string) {
    if (settingsProject.defaultImageId === imageId) {
      settingsProject.defaultImageId = "";
    }
  }

  function clearDefaultRuntime(runtimeId: string) {
    if (settingsProject.defaultRuntimeId === runtimeId) {
      settingsProject.defaultRuntimeId = "";
    }
  }

  async function createSettingsProject() {
    if (!canCreateSettingsProject.value || creatingSettingsProject.value) {
      return;
    }
    creatingSettingsProject.value = true;
    clearProjectFeedback();
    try {
      const project = await createProject({
        name: settingsProject.name.trim(),
        source: {
          type: "git-repository",
          url: settingsProject.url.trim(),
          ref: { type: "branch", name: "main" },
          auth: { type: "none" },
          clone: { submodules: false, lfs: false, subdirectory: "" },
        },
        ...(settingsProject.defaultImageId ? { defaultImageId: settingsProject.defaultImageId } : {}),
        ...(settingsProject.defaultRuntimeId ? { defaultRuntimeId: settingsProject.defaultRuntimeId } : {}),
        modelSelection: {
          ...(settingsProject.codexModelId ? { codexModelId: settingsProject.codexModelId } : {}),
          ...(settingsProject.claudeModelId ? { claudeModelId: settingsProject.claudeModelId } : {}),
        },
      });
      settingsProjectSuccess.value = `${project.name} created.`;
      settingsProject.name = "";
      settingsProject.url = "";
      settingsProject.defaultImageId = "";
      settingsProject.defaultRuntimeId = "";
      settingsProject.codexModelId = "";
      settingsProject.claudeModelId = "";
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      creatingSettingsProject.value = false;
    }
  }

  function projectModelValue(project: Project, app: "codex" | "claude") {
    return app === "codex" ? project.modelSelection.codexModelId || DEFAULT_SELECT_VALUE : project.modelSelection.claudeModelId || DEFAULT_SELECT_VALUE;
  }

  async function setProjectModel(project: Project, app: "codex" | "claude", value: string) {
    if (savingProjectModelId.value) {
      return;
    }
    const modelId = value === DEFAULT_SELECT_VALUE ? "" : value;
    const modelSelection = {
      ...project.modelSelection,
      ...(app === "codex" ? { codexModelId: modelId || undefined } : { claudeModelId: modelId || undefined }),
    };
    savingProjectModelId.value = project.id;
    clearProjectFeedback();
    try {
      const updated = await updateProject(project.id, { modelSelection });
      settingsProjectSuccess.value = `${updated.name} models updated.`;
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      savingProjectModelId.value = "";
    }
  }

  async function removeProject(project: { id: string; name: string }) {
    if (projectInUse(project.id) || deletingProjectId.value) {
      return;
    }
    if (!window.confirm(`Delete project ${project.name}?`)) {
      return;
    }
    deletingProjectId.value = project.id;
    try {
      await deleteProject(project.id);
      onProjectDeleted(project.id);
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      deletingProjectId.value = "";
    }
  }

  function projectSourceLabel(project: { source: { type: string; path?: string; url?: string } }) {
    return project.source.type === "local-folder" ? project.source.path || "local folder" : project.source.url || project.source.type;
  }

  return {
    canCreateSettingsProject,
    clearDefaultImage,
    clearDefaultRuntime,
    clearProjectFeedback,
    createSettingsProject,
    creatingSettingsProject,
    deletingProjectId,
    projectModelValue,
    projectSourceLabel,
    removeModelSelection,
    removeProject,
    savingProjectModelId,
    settingsClaudeModelSelectValue,
    settingsCodexModelSelectValue,
    settingsDefaultImageSelectValue,
    settingsDefaultRuntimeSelectValue,
    settingsProject,
    settingsProjectSuccess,
    setProjectModel,
  };
}
