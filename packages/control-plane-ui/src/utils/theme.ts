export type ThemePreference = "light" | "dark";

const THEME_STORAGE_KEY = "task-handoff.theme";
const DEFAULT_THEME: ThemePreference = "dark";
let themeStorageSyncInitialized = false;

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark";
}

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return DEFAULT_THEME;
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyThemePreference(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  const desktopBridge = (window as Window & {
    taskHandoffDesktop?: { setWindowChromeTheme?: (theme: ThemePreference) => Promise<{ ok: boolean }> };
  }).taskHandoffDesktop;
  void desktopBridge?.setWindowChromeTheme?.(theme);
}

export function saveThemePreference(theme: ThemePreference) {
  applyThemePreference(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable in restricted browser contexts; the live theme still applies.
  }
}

export function initializeThemePreference() {
  applyThemePreference(getThemePreference());
  if (themeStorageSyncInitialized || typeof window === "undefined") return;
  themeStorageSyncInitialized = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY || !isThemePreference(event.newValue)) return;
    applyThemePreference(event.newValue);
  });
}
