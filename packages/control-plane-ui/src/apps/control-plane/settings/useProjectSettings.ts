import { computed, reactive, ref, type ComputedRef } from "vue";
import { createProject, deleteProject, updateProject } from "../../../api/queries";
import type { Project } from "../../../api/types";
import type { GitCredentialPublic } from "@task-handoff/protocol/managed-git-credentials";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import type { Translate } from "../../../i18n/status.ts";
import { translateApiError } from "../../../i18n/apiError.ts";

export const DEFAULT_SELECT_VALUE = "__default__";
export const NO_GIT_CREDENTIAL_VALUE = "__none__";

type UseProjectSettingsInput = {
  errorText: (error: unknown) => string;
  onProjectDeleted: (projectId: string) => void;
  projectInUse: (projectId: string) => boolean;
  refreshProjects: () => Promise<void>;
  gitCredentials: ComputedRef<GitCredentialPublic[]>;
  translate: Translate;
};

export function useProjectSettings({ errorText, gitCredentials, onProjectDeleted, projectInUse, refreshProjects, translate: t }: UseProjectSettingsInput) {
  const translateError = (error: unknown) => translateApiError(error, t, errorText(error));
  const creatingSettingsProject = ref(false);
  const deletingProjectId = ref("");
  const updatingProjectCredentialId = ref("");
  const settingsProject = reactive({
    name: "",
    url: "",
    gitCredentialId: NO_GIT_CREDENTIAL_VALUE,
    defaultImageSelection: undefined as { imageId: string; tag?: string } | undefined,
  });

  const settingsDefaultImageSelectValue = computed({
    get: () => settingsProject.defaultImageSelection?.imageId || DEFAULT_SELECT_VALUE,
    set: (value: string) => {
      settingsProject.defaultImageSelection = value === DEFAULT_SELECT_VALUE ? undefined : { imageId: value };
    },
  });
  const canCreateSettingsProject = computed(() => {
    if (!settingsProject.name.trim()) {
      return false;
    }
    return Boolean(settingsProject.url.trim());
  });
  const settingsGitCredentialValue = computed({
    get: () => settingsProject.gitCredentialId,
    set: (value: string) => { settingsProject.gitCredentialId = value; },
  });

  function resetProjectForm() {
    settingsProject.name = "";
    settingsProject.url = "";
    settingsProject.gitCredentialId = NO_GIT_CREDENTIAL_VALUE;
    settingsProject.defaultImageSelection = undefined;
  }

  function clearDefaultImage(imageId: string) {
    if (settingsProject.defaultImageSelection?.imageId === imageId) {
      settingsProject.defaultImageSelection = undefined;
    }
  }

  async function createSettingsProject(): Promise<boolean> {
    if (!canCreateSettingsProject.value || creatingSettingsProject.value) {
      return false;
    }
    creatingSettingsProject.value = true;
    try {
      const credential = gitCredentials.value.find((item) => item.id === settingsProject.gitCredentialId && item.status === "enabled");
      const project = await createProject({
        name: settingsProject.name.trim(),
        source: {
          type: "git-repository",
          url: settingsProject.url.trim(),
          ref: { type: "branch", name: "main" },
          auth: credential ? { type: credential.kind, secretId: credential.id } : { type: "none" },
          clone: { submodules: false, lfs: false, subdirectory: "" },
        },
        ...(settingsProject.defaultImageSelection ? { defaultImageSelection: settingsProject.defaultImageSelection } : {}),
      });
      showControlPlaneToast(t("settings.projectRegistry.created", { name: project.name }), "success");
      resetProjectForm();
      await refreshProjects();
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
    } finally {
      creatingSettingsProject.value = false;
    }
  }

  async function removeProject(project: { id: string; name: string }): Promise<boolean> {
    if (projectInUse(project.id) || deletingProjectId.value) {
      return false;
    }
    deletingProjectId.value = project.id;
    try {
      await deleteProject(project.id);
      onProjectDeleted(project.id);
      await refreshProjects();
      showControlPlaneToast(t("settings.projectRegistry.deleted", { name: project.name }), "success");
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
    } finally {
      deletingProjectId.value = "";
    }
  }

  async function updateProjectCredential(project: Project, credentialId: string) {
    if (updatingProjectCredentialId.value || project.source.type === "local-folder") return;
    const credential = gitCredentials.value.find((item) => item.id === credentialId && item.status === "enabled");
    const auth = credential ? { type: credential.kind, secretId: credential.id } as const : { type: "none" as const };
    if ((project.source.auth?.secretId || NO_GIT_CREDENTIAL_VALUE) === (credential?.id || NO_GIT_CREDENTIAL_VALUE)) return;
    updatingProjectCredentialId.value = project.id;
    try {
      await updateProject(project.id, { source: { ...project.source, auth } });
      await refreshProjects();
      showControlPlaneToast(t("settings.projectRegistry.credentialUpdated"), "success");
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      updatingProjectCredentialId.value = "";
    }
  }

  function projectSourceLabel(project: { source: { type: string; path?: string; url?: string } }) {
    return project.source.type === "local-folder" ? project.source.path || t("settings.projectRegistry.localFolder") : project.source.url || project.source.type;
  }

  function projectCredentialLabel(project: Project) {
    const credentialId = project.source.type === "git-repository" ? project.source.auth?.secretId : undefined;
    if (!credentialId) return t("settings.projectRegistry.noCredential");
    return gitCredentials.value.find((credential) => credential.id === credentialId)?.name || credentialId;
  }

  return {
    canCreateSettingsProject,
    clearDefaultImage,
    createSettingsProject,
    creatingSettingsProject,
    deletingProjectId,
    projectSourceLabel,
    projectCredentialLabel,
    resetProjectForm,
    removeProject,
    updateProjectCredential,
    updatingProjectCredentialId,
    settingsDefaultImageSelectValue,
    settingsGitCredentialValue,
    settingsProject,
  };
}
