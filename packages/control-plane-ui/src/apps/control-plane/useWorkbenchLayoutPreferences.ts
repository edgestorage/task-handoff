import { shallowRef } from "vue";

export type HeaderDensity = "compact" | "normal";

const HEADER_DENSITY_STORAGE_KEY = "task-handoff.control-plane.header-density";
const headerDensity = shallowRef<HeaderDensity>("compact");
let initialized = false;

function isHeaderDensity(value: string | null): value is HeaderDensity {
  return value === "compact" || value === "normal";
}

function initializeHeaderDensity() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try {
    const stored = window.localStorage?.getItem(HEADER_DENSITY_STORAGE_KEY);
    if (isHeaderDensity(stored)) headerDensity.value = stored;
  } catch {
    // Storage can be unavailable in restricted browser contexts; keep the live default.
  }
  window.addEventListener("storage", (event) => {
    if (event.key === HEADER_DENSITY_STORAGE_KEY && isHeaderDensity(event.newValue)) {
      headerDensity.value = event.newValue;
    }
  });
}

export function useWorkbenchLayoutPreferences() {
  initializeHeaderDensity();

  function setHeaderDensity(value: HeaderDensity) {
    headerDensity.value = value;
    try {
      window.localStorage?.setItem(HEADER_DENSITY_STORAGE_KEY, value);
    } catch {
      // The current window can still apply the preference without persistence.
    }
  }

  return { headerDensity, setHeaderDensity };
}
