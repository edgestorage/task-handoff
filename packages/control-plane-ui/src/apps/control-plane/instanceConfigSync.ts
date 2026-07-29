import type { InstanceBoardItem } from "../../api/types";

export function canExportInstanceConfig(instance: Pick<InstanceBoardItem, "source">) {
  return instance.source.type === "local-folder";
}
