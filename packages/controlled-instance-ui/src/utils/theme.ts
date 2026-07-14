export type ThemePreference = "light" | "dark";

const THEME_STORAGE_KEY = "task-handoff.theme";
const DEFAULT_THEME: ThemePreference = "dark";

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return DEFAULT_THEME;
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyThemePreference(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function initializeThemePreference() {
  applyThemePreference(getThemePreference());
}
