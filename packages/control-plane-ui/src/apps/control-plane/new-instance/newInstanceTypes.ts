export type WizardStep = "source" | "runtime";
export type SourceMode = "project" | "local-folder";
export type ProjectFolderSelection = string | { path: string; ownerNodeId?: string };

export type SourceDraft = {
  mode: SourceMode;
  projectId: string;
  localNodeId: string;
  localFolderId: string;
  localPath: string;
};

export type RuntimeDraft = {
  nodeId: string;
  runtimeId: string;
  imageId: string;
};

export type InstanceDraft = {
  name: string;
  autoImportAgentConfigs: boolean;
  codexModelHash: string;
  claudeModelHash: string;
};

export type NewProjectDraft = {
  name: string;
  url: string;
};

export type NewImageDraft = {
  name: string;
  image: string;
};
