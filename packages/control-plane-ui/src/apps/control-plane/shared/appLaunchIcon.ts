import { EMBEDDED_BROWSER_APP_ID } from "../useInstanceSessions.ts";

export type AppLaunchIconIdentity = {
  id: string;
  kind?: "tty" | "gui" | "web";
  automation?: "cdp";
  agent?: boolean;
};

export type AppLaunchIconKind = "agent" | "terminal" | "browser" | "web" | "desktop" | "generic";

export const AI_AGENT_APP_IDS = ["codex", "claude", "opencode"] as const;

export function appLaunchIconKind(app: AppLaunchIconIdentity): AppLaunchIconKind {
  if (app.agent === true || AI_AGENT_APP_IDS.some((id) => id === app.id)) return "agent";
  if (app.id === EMBEDDED_BROWSER_APP_ID) return "browser";
  if (app.kind === "tty") return "terminal";
  if (app.kind === "web") return "web";
  if (app.kind === "gui") return app.automation === "cdp" ? "browser" : "desktop";
  return "generic";
}
