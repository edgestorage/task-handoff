import { readonly, shallowRef } from "vue";

type AiSessionConversationWidth = "full" | "bounded";

const STORAGE_KEY = "task-handoff.control-plane.ai-session-conversation-width";
const conversationWidth = shallowRef<AiSessionConversationWidth>("full");
const preferredWidth = readonly(conversationWidth);
let initialized = false;

export function useAiSessionConversationWidth() {
  if (!initialized && typeof window !== "undefined") {
    initialized = true;
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "bounded") conversationWidth.value = "bounded";
    } catch {
      conversationWidth.value = "full";
    }
  }

  function setConversationWidth(value: unknown) {
    if (value !== "full" && value !== "bounded") return;
    conversationWidth.value = value;
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      return;
    }
  }

  return { conversationWidth: preferredWidth, setConversationWidth };
}
