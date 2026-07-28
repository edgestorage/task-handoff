import { computed, reactive, ref } from "vue";
import { createProject, deleteProject } from "../../../api/queries";
import type { Project } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import type { Translate } from "../../../i18n/status.ts";
import { translateApiError } from "../../../i18n/apiError.ts";

const DEFAULT_SELECT_VALUE = "__default__";

type UseProjectSettingsInput = {
  errorText: (error: unknown) => string;
  onProjectDeleted: (projectId: string) => void;
  projectInUse: (projectId: string) => boolean;
  refresh: () => Promise<void>;
  translate: Translate;
};

export function useProjectSettings({ errorText, onProjectDeleted, projectInUse, refresh, translate: t }: UseProjectSettingsInput) {
  const translateError = (error: unknown) => translateApiError(error, t, errorText(error));
  const creatingSettingsProject = ref(false);
  const deletingProjectId = ref("");
  const settingsProjectSuccess = ref("");
  const settingsProject = reactive({
    name: "",
    url: "",
    defaultImageSelection: undefined as { imageId: string; tag?: string } | undefined,
    defaultRuntimeId: "",
  });

  const settingsDefaultImageSelectValue = computed({
    get: () => settingsProject.defaultImageSelection?.imageId || DEFAULT_SELECT_VALUE,
    set: (value: string) => {
      settingsProject.defaultImageSelection = value === DEFAULT_SELECT_VALUE ? undefined : { imageId: value };
    },
  });
  const settingsDefaultRuntimeSelectValue = computed({
    get: () => settingsProject.defaultRuntimeId || DEFAULT_SELECT_VALUE,
    set: (value: string) => {
      settingsProject.defaultRuntimeId = value === DEFAULT_SELECT_VALUE ? "" : value;
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

  function clearDefaultImage(imageId: string) {
    if (settingsProject.defaultImageSelection?.imageId === imageId) {
      settingsProject.defaultImageSelection = undefined;
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
        ...(settingsProject.defaultImageSelection ? { defaultImageSelection: settingsProject.defaultImageSelection } : {}),
        ...(settingsProject.defaultRuntimeId ? { defaultRuntimeId: settingsProject.defaultRuntimeId } : {}),
      });
      settingsProjectSuccess.value = t("settings.projectRegistry.created", { name: project.name });
      settingsProject.name = "";
      settingsProject.url = "";
      settingsProject.defaultImageSelection = undefined;
      settingsProject.defaultRuntimeId = "";
      await refresh();
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      creatingSettingsProject.value = false;
    }
  }

  async function removeProject(project: { id: string; name: string }) {
    if (projectInUse(project.id) || deletingProjectId.value) {
      return;
    }
    if (!window.confirm(t("settings.projectRegistry.deleteConfirm", { name: project.name }))) {
      return;
    }
    deletingProjectId.value = project.id;
    try {
      await deleteProject(project.id);
      onProjectDeleted(project.id);
      await refresh();
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      deletingProjectId.value = "";
    }
  }

  function projectSourceLabel(project: { source: { type: string; path?: string; url?: string } }) {
    return project.source.type === "local-folder" ? project.source.path || t("settings.projectRegistry.localFolder") : project.source.url || project.source.type;
  }

  return {
    canCreateSettingsProject,
    clearDefaultImage,
    clearDefaultRuntime,
    clearProjectFeedback,
    createSettingsProject,
    creatingSettingsProject,
    deletingProjectId,
    projectSourceLabel,
    removeProject,
    settingsDefaultImageSelectValue,
    settingsDefaultRuntimeSelectValue,
    settingsProject,
    settingsProjectSuccess,
  };
}
