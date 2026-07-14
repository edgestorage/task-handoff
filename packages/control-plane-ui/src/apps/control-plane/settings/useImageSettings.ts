import { computed, ref, type Ref } from "vue";
import { createImage, deleteImage } from "../../../api/queries";
import type { ImageProfile, LocalDockerImage } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";

type UseImageSettingsInput = {
  errorText: (error: unknown) => string;
  imageInUse: (imageId: string) => boolean;
  images: Ref<ImageProfile[] | undefined>;
  localDockerImages: Ref<LocalDockerImage[] | undefined>;
  onImageDeleted: (imageId: string) => void;
  refresh: () => Promise<void>;
};

export function useImageSettings({ errorText, imageInUse, images, localDockerImages, onImageDeleted, refresh }: UseImageSettingsInput) {
  const localImageFilter = ref("");
  const addingLocalImageRef = ref("");
  const deletingImageId = ref("");
  const localImageCreateSuccess = ref("");

  const registeredImageRefs = computed(() => new Set((images.value || []).map((image) => image.image)));
  const localDockerImageRefs = computed(() => new Set((localDockerImages.value || []).map((image) => image.reference)));
  const filteredLocalDockerImages = computed(() => {
    const term = localImageFilter.value.trim().toLowerCase();
    const items = localDockerImages.value || [];
    if (!term) {
      return items;
    }
    return items.filter((image) => [image.reference, image.repository, image.tag, image.id].join(" ").toLowerCase().includes(term));
  });

  function clearImageFeedback() {
    localImageCreateSuccess.value = "";
  }

  function isLocalImageRegistered(image: LocalDockerImage) {
    return registeredImageRefs.value.has(image.reference);
  }

  function imageLocalStatus(image: { image: string; registry: string }) {
    if (image.registry !== "local") {
      return `registry: ${image.registry}`;
    }
    if (!localDockerImages.value) {
      return "local image not checked";
    }
    return localDockerImageRefs.value.has(image.image) ? "local image available" : "local image missing";
  }

  async function addLocalImage(image: LocalDockerImage) {
    if (isLocalImageRegistered(image) || addingLocalImageRef.value) {
      return;
    }
    addingLocalImageRef.value = image.reference;
    clearImageFeedback();
    try {
      await createImage({
        name: image.reference,
        image: image.reference,
        registry: "local",
        capabilities: ["browser", "terminal", "gui-terminal", "codex", "claude"],
        optionalApps: ["chromium", "terminal-tty", "gui-terminal", "vscode-web"],
        defaultEnv: {},
        labels: {
          "task-handoff.image.source": "node-runtime-docker",
          "task-handoff.image.local-id": image.id,
        },
      });
      localImageCreateSuccess.value = `${image.reference} added.`;
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      addingLocalImageRef.value = "";
    }
  }

  async function removeImageProfile(image: { id: string; name: string }) {
    if (imageInUse(image.id) || deletingImageId.value) {
      return;
    }
    if (!window.confirm(`Delete image profile ${image.name}?`)) {
      return;
    }
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
    addLocalImage,
    addingLocalImageRef,
    clearImageFeedback,
    deletingImageId,
    filteredLocalDockerImages,
    imageLocalStatus,
    isLocalImageRegistered,
    localImageCreateSuccess,
    localImageFilter,
    removeImageProfile,
  };
}
