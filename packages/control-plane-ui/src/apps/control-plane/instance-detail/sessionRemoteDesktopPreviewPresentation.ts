import { shallowRef } from "vue";

export type SessionRemoteDesktopPreviewPresentation = "floating" | "expanded";

const STORAGE_KEY = "task-handoff.control-plane.session-remote-desktop-preview-presentation";
const presentation = shallowRef<SessionRemoteDesktopPreviewPresentation>("floating");
let initialized = false;

export function sanitizeSessionRemoteDesktopPreviewPresentation(value: unknown): SessionRemoteDesktopPreviewPresentation {
  return value === "expanded" ? "expanded" : "floating";
}

export function useSessionRemoteDesktopPreviewPresentation() {
  if (!initialized) {
    initialized = true;
    try {
      presentation.value = sanitizeSessionRemoteDesktopPreviewPresentation(window.localStorage?.getItem(STORAGE_KEY));
    } catch {
      presentation.value = "floating";
    }
  }

  function setSessionRemoteDesktopPreviewPresentation(value: unknown) {
    if (value !== "floating" && value !== "expanded") return false;
    presentation.value = value;
    try {
      window.localStorage?.setItem(STORAGE_KEY, value);
    } catch {
      // Local storage is optional; keep the in-memory preference active.
    }
    return true;
  }

  return { presentation, setSessionRemoteDesktopPreviewPresentation };
}
