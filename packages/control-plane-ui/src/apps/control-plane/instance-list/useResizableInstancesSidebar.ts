import { computed, onBeforeUnmount, ref, type CSSProperties } from "vue";

const INSTANCE_WIDTH_STORAGE_KEY = "task-handoff.control-plane.instances-width";
const INSTANCE_COLLAPSED_STORAGE_KEY = "task-handoff.control-plane.instances-collapsed";
const INSTANCE_WIDTH_DEFAULT = 292;
const INSTANCE_WIDTH_MIN = 220;
const INSTANCE_WIDTH_MAX = 440;
const INSTANCE_COLLAPSE_THRESHOLD = 180;

function storedInstanceWidth() {
  const stored = window.localStorage?.getItem(INSTANCE_WIDTH_STORAGE_KEY);
  const value = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(value) ? clampInstanceWidth(value) : INSTANCE_WIDTH_DEFAULT;
}

function storedInstancesCollapsed() {
  return window.localStorage?.getItem(INSTANCE_COLLAPSED_STORAGE_KEY) === "true";
}

function clampInstanceWidth(value: number) {
  return Math.min(INSTANCE_WIDTH_MAX, Math.max(INSTANCE_WIDTH_MIN, Math.round(value)));
}

export function useResizableInstancesSidebar() {
  const instancesCollapsed = ref(storedInstancesCollapsed());
  const instancesWidth = ref(storedInstanceWidth());
  let instanceResizeCleanup: (() => void) | undefined;

  const workbenchStyle = computed(
    () =>
      ({
        "--instances-width": `${instancesWidth.value}px`,
      }) as CSSProperties,
  );

  function persistInstancesWidth() {
    window.localStorage?.setItem(INSTANCE_WIDTH_STORAGE_KEY, String(instancesWidth.value));
  }

  function persistInstancesCollapsed() {
    window.localStorage?.setItem(INSTANCE_COLLAPSED_STORAGE_KEY, String(instancesCollapsed.value));
  }

  function collapseInstances() {
    instancesCollapsed.value = true;
    persistInstancesCollapsed();
  }

  function expandInstances() {
    if (instancesWidth.value < INSTANCE_WIDTH_MIN) {
      instancesWidth.value = INSTANCE_WIDTH_DEFAULT;
    }
    instancesCollapsed.value = false;
    persistInstancesCollapsed();
  }

  function stopInstanceResize() {
    instanceResizeCleanup?.();
    instanceResizeCleanup = undefined;
    document.body.classList.remove("instances-resizing");
  }

  function startInstanceResize(event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    stopInstanceResize();
    const startX = event.clientX;
    const startWidth = instancesWidth.value;
    document.body.classList.add("instances-resizing");
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      if (nextWidth < INSTANCE_COLLAPSE_THRESHOLD) {
        instancesCollapsed.value = true;
        return;
      }
      instancesCollapsed.value = false;
      instancesWidth.value = clampInstanceWidth(nextWidth);
    };
    const handlePointerUp = () => {
      persistInstancesWidth();
      persistInstancesCollapsed();
      stopInstanceResize();
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
    instanceResizeCleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }

  onBeforeUnmount(stopInstanceResize);

  return {
    collapseInstances,
    expandInstances,
    instancesCollapsed,
    startInstanceResize,
    stopInstanceResize,
    workbenchStyle,
  };
}
