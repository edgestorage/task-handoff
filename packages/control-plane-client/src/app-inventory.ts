export type AvailableInstanceApp = {
  id: string;
  name: string;
  kind: "tty" | "gui" | "web";
  source: "builtin" | "custom";
  availability: "available" | "missing-dependency";
  capabilities: {
    automation?: "cdp";
    supportsCwdSelection: boolean;
  };
  diagnosticCode?: "APP_EXECUTABLE_NOT_FOUND";
};

type InstanceWithAppInventory = {
  connectionStatus: string;
  appInventory?: { items: AvailableInstanceApp[] };
};

export function availableInstanceApps(instance: InstanceWithAppInventory): AvailableInstanceApp[] {
  if (instance.connectionStatus !== "online") return [];
  return (instance.appInventory?.items ?? []).filter((app) => app.availability === "available");
}

export function availableInstanceAgents(instance: InstanceWithAppInventory): AvailableInstanceApp[] {
  return availableInstanceApps(instance).filter((app) => app.id === "codex" || app.id === "claude");
}
