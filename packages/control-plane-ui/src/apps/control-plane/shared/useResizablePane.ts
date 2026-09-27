import { computed, onBeforeUnmount, ref, watch } from "vue";

export type ResizablePaneOptions = {
  /** localStorage 键：记住用户拖出的列表栏宽度。 */
  widthStorageKey: string;
  /** localStorage 键：记住折叠状态。 */
  collapseStorageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** 低于该断点时禁用拖拽，与窄屏下抽屉式列表保持一致。 */
  resizeDisabledQuery?: string;
  collapsedWidth?: string;
  animationMs?: number;
  overlayCloseDelayMs?: number;
};

/**
 * 「列表栏 + 内容区」两栏工作区的共用交互：拖拽改宽、点击折叠、折叠后悬停浮出。
 * 列表栏始终位于工作区左侧，宽度按指针相对工作区左边缘的位置计算。
 */
export function useResizablePane(options: ResizablePaneOptions) {
  const { widthStorageKey, collapseStorageKey, defaultWidth, minWidth, maxWidth } = options;
  const resizeDisabledQuery = options.resizeDisabledQuery ?? "(max-width: 800px)";
  const collapsedWidth = options.collapsedWidth ?? "11px";
  const animationMs = options.animationMs ?? 200;
  const overlayCloseDelayMs = options.overlayCloseDelayMs ?? 150;

  function storedWidth() {
    try {
      const value = Number(window.localStorage?.getItem(widthStorageKey));
      return Number.isFinite(value) ? Math.min(maxWidth, Math.max(minWidth, value)) : defaultWidth;
    } catch { return defaultWidth; }
  }
  function storedCollapsed() {
    try { return window.localStorage?.getItem(collapseStorageKey) === "collapsed"; } catch { return false; }
  }

  const paneEl = ref<HTMLElement>();
  const paneWidth = ref(storedWidth());
  const paneCollapsed = ref(storedCollapsed());
  const paneLayoutWidth = computed(() => (paneCollapsed.value ? collapsedWidth : `${paneWidth.value}px`));
  const paneResizing = ref(false);
  const paneOverlayOpen = ref(false);
  const paneLayoutAnimating = ref(false);

  let resizingPointerId: number | undefined;
  let resizeMoved = false;
  let overlayCloseTimer: number | undefined;
  let layoutAnimationTimer: number | undefined;

  function resizePane(event: PointerEvent) {
    if (!paneResizing.value || event.pointerId !== resizingPointerId || !paneEl.value) return;
    resizeMoved = true;
    paneWidth.value = Math.min(maxWidth, Math.max(minWidth, event.clientX - paneEl.value.getBoundingClientRect().left));
  }
  function stopResize(event?: PointerEvent) {
    if (event && resizingPointerId !== undefined && event.pointerId !== resizingPointerId) return;
    paneResizing.value = false;
    resizingPointerId = undefined;
    window.removeEventListener("pointermove", resizePane);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
  }
  function startResize(event: PointerEvent) {
    if (window.matchMedia(resizeDisabledQuery).matches || !paneEl.value) return;
    paneResizing.value = true;
    resizeMoved = false;
    resizingPointerId = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", resizePane);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }
  /** 折叠/展开列表栏；刚刚拖拽过时不切换，避免拖到底误触折叠。 */
  function toggleCollapsed() {
    if (resizeMoved) { resizeMoved = false; return; }
    paneCollapsed.value = !paneCollapsed.value;
    try { window.localStorage?.setItem(collapseStorageKey, paneCollapsed.value ? "collapsed" : "expanded"); } catch { /* Local storage is optional. */ }
    if (!paneCollapsed.value) paneOverlayOpen.value = false;
  }
  function openOverlay() {
    if (!paneCollapsed.value) return;
    if (overlayCloseTimer !== undefined) window.clearTimeout(overlayCloseTimer);
    overlayCloseTimer = undefined;
    paneOverlayOpen.value = true;
  }
  function scheduleOverlayClose() {
    if (!paneCollapsed.value) return;
    if (overlayCloseTimer !== undefined) window.clearTimeout(overlayCloseTimer);
    overlayCloseTimer = window.setTimeout(() => {
      paneOverlayOpen.value = false;
      overlayCloseTimer = undefined;
    }, overlayCloseDelayMs);
  }
  function playLayoutAnimation() {
    if (layoutAnimationTimer !== undefined) window.clearTimeout(layoutAnimationTimer);
    paneLayoutAnimating.value = true;
    layoutAnimationTimer = window.setTimeout(() => {
      layoutAnimationTimer = undefined;
      paneLayoutAnimating.value = false;
    }, animationMs);
  }

  watch(paneWidth, (width) => { try { window.localStorage?.setItem(widthStorageKey, String(width)); } catch { /* Local storage may be unavailable in restricted browser contexts. */ } });
  watch(paneCollapsed, playLayoutAnimation, { flush: "sync" });

  onBeforeUnmount(() => {
    stopResize();
    if (overlayCloseTimer !== undefined) window.clearTimeout(overlayCloseTimer);
    if (layoutAnimationTimer !== undefined) window.clearTimeout(layoutAnimationTimer);
  });

  return {
    paneEl,
    paneWidth,
    paneCollapsed,
    paneLayoutWidth,
    paneResizing,
    paneOverlayOpen,
    paneLayoutAnimating,
    startResize,
    toggleCollapsed,
    openOverlay,
    scheduleOverlayClose,
  };
}
