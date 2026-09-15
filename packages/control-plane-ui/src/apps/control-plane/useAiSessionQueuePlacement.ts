import { shallowRef } from "vue";

export type AiSessionQueuePlacement = "detail" | "composer";

const STORAGE_KEY = "task-handoff.control-plane.ai-session-queue-placement";
const queuePlacement = shallowRef<AiSessionQueuePlacement>("composer");
let initialized = false;

export function useAiSessionQueuePlacement() {
  if (!initialized) {
    initialized = true;
    queuePlacement.value = window.localStorage?.getItem(STORAGE_KEY) === "detail" ? "detail" : "composer";
  }

  function setQueuePlacement(value: unknown) {
    if (value !== "detail" && value !== "composer") return false;
    queuePlacement.value = value;
    window.localStorage?.setItem(STORAGE_KEY, value);
    return true;
  }

  return { queuePlacement, setQueuePlacement };
}
