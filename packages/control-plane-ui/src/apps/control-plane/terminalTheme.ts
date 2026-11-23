import type { ITheme, Terminal } from "@xterm/xterm";
import { watch } from "vue";
import { useThemePreference } from "../../utils/theme";

const FALLBACK_TERMINAL_THEME: ITheme = {
  background: "#151619",
  foreground: "#f3f3f6",
  cursor: "#2dd4bf",
  selectionBackground: "#2e3036",
};

export function terminalTheme(): ITheme {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim() || FALLBACK_TERMINAL_THEME.background,
    foreground: styles.getPropertyValue("--terminal-text").trim() || FALLBACK_TERMINAL_THEME.foreground,
    cursor: styles.getPropertyValue("--status-success").trim() || FALLBACK_TERMINAL_THEME.cursor,
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim() || FALLBACK_TERMINAL_THEME.selectionBackground,
  };
}

export function applyTerminalTheme(terminal: Terminal) {
  terminal.options.theme = terminalTheme();
  if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
}

export function watchTerminalTheme(refresh: () => void) {
  return watch(useThemePreference(), refresh, { flush: "post" });
}
