import type { ConfigSyncDirection } from "@task-handoff/protocol/config-sync";
import type { InstanceBoardItem } from "../../../api/types";
import type { InstanceAction } from "../useInstanceActions";

export type InstanceContextMenuCommand =
  | { type: "run-action"; action: InstanceAction }
  | { type: "open-config-sync"; direction: ConfigSyncDirection }
  | { type: "open-settings" }
  | { type: "open-window" }
  | { type: "save-template" }
  | { type: "close-all-sessions" };

export type InstanceContextMenuCommandEvent = {
  command: InstanceContextMenuCommand;
  instance: InstanceBoardItem;
};

export type InstanceActionMenuBindings = {
  activeActionLabel: (instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) => string;
  canExportConfig?: (instance: InstanceBoardItem) => boolean;
  isClosingAllSessions?: (instance: InstanceBoardItem) => boolean;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
};
