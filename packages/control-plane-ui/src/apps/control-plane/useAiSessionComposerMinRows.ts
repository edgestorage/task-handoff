import { shallowRef } from "vue";

export const AI_SESSION_COMPOSER_MIN_ROWS = 1;
export const AI_SESSION_COMPOSER_DEFAULT_ROWS = 2;
export const AI_SESSION_COMPOSER_MAX_ROWS = 4;
export const AI_SESSION_COMPOSER_MIN_ROWS_STORAGE_KEY = "task-handoff.control-plane.ai-session-composer-min-rows";

const composerMinRows = shallowRef(AI_SESSION_COMPOSER_DEFAULT_ROWS);
let initialized = false;
let storageListenerInstalled = false;

export function sanitizeAiSessionComposerMinRows(value: unknown) {
  if (value === null || value === undefined || value === "") return AI_SESSION_COMPOSER_DEFAULT_ROWS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return AI_SESSION_COMPOSER_DEFAULT_ROWS;
  return Math.min(AI_SESSION_COMPOSER_MAX_ROWS, Math.max(AI_SESSION_COMPOSER_MIN_ROWS, Math.round(parsed)));
}

function initializeComposerMinRows() {
  if (typeof window === "undefined") return;
  if (!initialized) {
    initialized = true;
    try {
      composerMinRows.value = sanitizeAiSessionComposerMinRows(window.localStorage?.getItem(AI_SESSION_COMPOSER_MIN_ROWS_STORAGE_KEY));
    } catch {
      // Restricted browser contexts can still use the in-memory preference.
    }
  }
  if (storageListenerInstalled) return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key === AI_SESSION_COMPOSER_MIN_ROWS_STORAGE_KEY) {
      composerMinRows.value = sanitizeAiSessionComposerMinRows(event.newValue);
    }
  });
}

export function useAiSessionComposerMinRows() {
  initializeComposerMinRows();

  function setComposerMinRows(value: unknown) {
    const next = sanitizeAiSessionComposerMinRows(value);
    if (next === composerMinRows.value) return false;
    composerMinRows.value = next;
    try {
      window.localStorage?.setItem(AI_SESSION_COMPOSER_MIN_ROWS_STORAGE_KEY, String(next));
    } catch {
      // The current window can still apply the preference without persistence.
    }
    return true;
  }

  return { composerMinRows, setComposerMinRows };
}
