export type SettingsSection = "basic" | "chat" | "images" | "environment-templates" | "projects" | "nodes" | "models" | "git-credentials" | "triggers" | "mobile-sessions" | "users" | "cloud-connectivity";

type SettingsSectionAccess = {
  manageSecrets: boolean;
  manageSettings: boolean;
  manageUsers: boolean;
};

type Translate = (key: string) => string;

export function buildSettingsSections(t: Translate, access: SettingsSectionAccess): Array<{ id: SettingsSection; label: string }> {
  return [
    { id: "nodes", label: t("settings.nodes") },
    { id: "images", label: t("settings.images") },
    { id: "environment-templates", label: t("settings.environmentTemplates") },
    { id: "projects", label: t("settings.projects") },
    { id: "models", label: t("settings.models") },
    ...(access.manageSecrets ? [{ id: "git-credentials" as const, label: t("settings.gitCredentials.navigation") }] : []),
    { id: "triggers", label: t("triggers.title") },
    { id: "chat", label: t("settings.chat") },
    { id: "mobile-sessions", label: t("settings.mobileSessions.navigation") },
    ...(access.manageUsers ? [{ id: "users" as const, label: t("settings.userAccess.navigation") }] : []),
    ...(access.manageSettings ? [{ id: "cloud-connectivity" as const, label: t("settings.cloud.navigation") }] : []),
    { id: "basic", label: t("settings.basic") },
  ];
}
