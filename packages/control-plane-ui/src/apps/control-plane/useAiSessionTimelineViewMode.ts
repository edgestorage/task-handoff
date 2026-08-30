import { shallowRef } from "vue";

export type AiSessionTimelineViewMode = "compact" | "full";

const STORAGE_KEY = "task-handoff.control-plane.ai-session-timeline-view-mode";
const viewMode = shallowRef<AiSessionTimelineViewMode>("compact");
let initialized = false;

export function useAiSessionTimelineViewMode() {
  if (!initialized) {
    initialized = true;
    viewMode.value = window.localStorage?.getItem(STORAGE_KEY) === "full" ? "full" : "compact";
  }

  function setViewMode(value: unknown) {
    if (value !== "compact" && value !== "full") return false;
    viewMode.value = value;
    window.localStorage?.setItem(STORAGE_KEY, value);
    return true;
  }

  return { setViewMode, viewMode };
}
