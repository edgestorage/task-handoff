import { STORY_RESOURCE_SIDEBAR_MIN_WIDTH, normalizeStoryResourceSidebarWidth } from "./useStoryResourceSidebar.ts";

export const STORY_RESOURCE_INLINE_MIN_WIDTH = 920;
export const STORY_RESOURCE_MAIN_MIN_WIDTH = 520;
export const STORY_RESOURCE_SIDEBAR_RESIZE_DELTA_RATIO = 0.8;
export const STORY_RESOURCE_KEYBOARD_STEP = 24;

export function storyResourceSidebarMode(containerWidth: number) {
  return containerWidth > 0 && containerWidth < STORY_RESOURCE_INLINE_MIN_WIDTH ? "overlay" : "inline";
}

export function storyResourceSidebarMaxWidth(containerWidth: number) {
  return Math.max(
    STORY_RESOURCE_SIDEBAR_MIN_WIDTH,
    containerWidth - STORY_RESOURCE_MAIN_MIN_WIDTH,
  );
}

export function storyResourceSidebarProportionalWidth(
  currentWidth: number,
  previousContainerWidth: number,
  containerWidth: number,
) {
  const maxWidth = storyResourceSidebarMaxWidth(containerWidth);
  if (previousContainerWidth <= 0 || containerWidth <= 0) {
    return Math.min(maxWidth, normalizeStoryResourceSidebarWidth(currentWidth));
  }
  return Math.min(
    maxWidth,
    normalizeStoryResourceSidebarWidth(
      Math.round(currentWidth + (containerWidth - previousContainerWidth) * STORY_RESOURCE_SIDEBAR_RESIZE_DELTA_RATIO),
    ),
  );
}

export function storyResourceSidebarKeyboardWidth(current: number, key: string, maxWidth: number) {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return current;
  const delta = key === "ArrowLeft" ? STORY_RESOURCE_KEYBOARD_STEP : -STORY_RESOURCE_KEYBOARD_STEP;
  return Math.min(maxWidth, normalizeStoryResourceSidebarWidth(current + delta));
}
