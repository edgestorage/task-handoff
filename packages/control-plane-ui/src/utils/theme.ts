import { readonly, ref } from "vue";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

const THEME_STORAGE_KEY = "task-handoff.theme";
const DEFAULT_THEME: ThemePreference = "system";
const appliedTheme = ref<ResolvedTheme>("dark");
let currentPreference: ThemePreference = DEFAULT_THEME;
let themeSyncInitialized = false;

// Renderers that bake colors into SVG/canvas must consume the same applied
// preference as CSS, including changes received from another window.
export function useThemePreference() {
  return readonly(appliedTheme);
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveThemePreference(theme: ThemePreference): ResolvedTheme {
  return theme === "system" ? getSystemTheme() : theme;
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
  currentPreference = theme;
  const resolvedTheme = resolveThemePreference(theme);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  appliedTheme.value = resolvedTheme;
  const desktopBridge = (window as Window & {
    taskHandoffDesktop?: { setWindowChromeTheme?: (theme: ThemePreference) => Promise<{ ok: boolean }> };
  }).taskHandoffDesktop;
  // The renderer needs the resolved colors, while Electron needs the source
  // preference so "system" can continue following OS changes in native chrome.
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
  if (themeSyncInitialized || typeof window === "undefined") return;
  themeSyncInitialized = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    if (event.newValue === null) {
      applyThemePreference(DEFAULT_THEME);
      return;
    }
    if (isThemePreference(event.newValue)) applyThemePreference(event.newValue);
  });
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (currentPreference === "system") applyThemePreference("system");
    });
  }
}
