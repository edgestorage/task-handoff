import { isFeatureEnabled } from "../../../lib/featureFlags";

export type SettingsSection = "basic" | "chat" | "images" | "environment-templates" | "projects" | "nodes" | "instances" | "models" | "git-credentials" | "triggers" | "mobile-sessions" | "users" | "cloud-connectivity" | "remote-desktop";

type SettingsSectionAccess = {
  manageSecrets: boolean;
  manageSettings: boolean;
  manageUsers: boolean;
};

type Translate = (key: string) => string;

type SettingsSectionItem = {
  id: SettingsSection;
  label: string;
  children?: Array<{ id: SettingsSection; label: string }>;
};

export function findSettingsSectionGroup(sections: SettingsSectionItem[], section: SettingsSection): SettingsSectionItem | undefined {
  return sections.find((item) => item.id === section || item.children?.some((child) => child.id === section));
}

export function buildSettingsSections(t: Translate, access: SettingsSectionAccess): SettingsSectionItem[] {
  return [
    { id: "nodes", label: t("settings.nodes") },
    { id: "instances", label: t("settings.instances") },
    {
      id: "images", label: t("settings.environment"),
      children: [
        { id: "images", label: t("settings.images") },
        { id: "environment-templates", label: t("settings.environmentTemplates") },
      ],
    },
    { id: "models", label: t("settings.models") },
    {
      id: "projects", label: t("settings.git.navigation"),
      children: [
        { id: "projects", label: t("settings.git.projects") },
        ...(access.manageSecrets ? [{ id: "git-credentials" as const, label: t("settings.git.credentials") }] : []),
      ],
    },
    { id: "triggers", label: t("triggers.title") },
    { id: "chat", label: t("settings.chat") },
    { id: "mobile-sessions", label: t("settings.mobileSessions.navigation") },
    ...(access.manageUsers ? [{ id: "users" as const, label: t("settings.userAccess.navigation") }] : []),
    ...(access.manageSettings && isFeatureEnabled("officialAccount") ? [{ id: "cloud-connectivity" as const, label: t("settings.cloud.navigation") }] : []),
    ...(access.manageSettings ? [{ id: "remote-desktop" as const, label: t("settings.desktopTurn.navigation") }] : []),
    { id: "basic", label: t("settings.basic") },
  ];
}
