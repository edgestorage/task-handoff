import { computed, reactive, ref, type Ref } from "vue";
import { createImage, deleteImage } from "../../../api/queries";
import type { ImageProfile } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";

type UseImageSettingsInput = {
  errorText: (error: unknown) => string;
  images: Ref<ImageProfile[] | undefined>;
  onImageDeleted: (imageId: string) => void;
  refresh: () => Promise<void>;
};

export function useImageSettings({ errorText, images, onImageDeleted, refresh }: UseImageSettingsInput) {
  const deletingImageId = ref("");
  const savingImage = ref(false);
  const imageCreateSuccess = ref("");
  const settingsImage = reactive({ name: "", reference: "" });
  const canCreateImage = computed(() => Boolean(settingsImage.name.trim() && settingsImage.reference.trim()));

  function clearImageFeedback() {
    imageCreateSuccess.value = "";
  }

  async function createRegistryImage() {
    if (!canCreateImage.value || savingImage.value) return;
    savingImage.value = true;
    clearImageFeedback();
    try {
      const image = await createImage({
        name: settingsImage.name.trim(),
        reference: settingsImage.reference.trim(),
        pullPolicy: "if-not-present",
        capabilities: ["browser", "terminal", "gui-terminal", "codex", "claude"],
        optionalApps: ["chromium", "terminal-tty", "gui-terminal", "vscode-web"],
        defaultEnv: {},
        labels: { "task-handoff.image.source": "registry-catalog" },
      });
      settingsImage.name = "";
      settingsImage.reference = "";
      imageCreateSuccess.value = `${image.name} added.`;
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      savingImage.value = false;
    }
  }

  async function removeImageProfile(image: { id: string; name: string }) {
    if (deletingImageId.value || !images.value?.some((item) => item.id === image.id)) return;
    if (!window.confirm(`Delete image profile ${image.name}?`)) return;
    deletingImageId.value = image.id;
    try {
      await deleteImage(image.id);
      onImageDeleted(image.id);
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      deletingImageId.value = "";
    }
  }

  return {
    canCreateImage,
    clearImageFeedback,
    createRegistryImage,
    deletingImageId,
    imageCreateSuccess,
    removeImageProfile,
    savingImage,
    settingsImage,
  };
}
