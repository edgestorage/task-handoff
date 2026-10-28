import { checkNode as checkNodeRequest, updateNode as updateNodeRequest } from "../../api/queries.ts";
import { createNodeConnectionActions, type NodeConnectionActionsOptions } from "./nodeConnectionActions.ts";

type UseNodeConnectionActionsOptions = Omit<NodeConnectionActionsOptions, "checkNode" | "updateNode"> & {
  checkNode?: typeof checkNodeRequest;
  updateNode?: typeof updateNodeRequest;
};

export function useNodeConnectionActions(options: UseNodeConnectionActionsOptions) {
  return createNodeConnectionActions({
    ...options,
    checkNode: options.checkNode ?? checkNodeRequest,
    updateNode: options.updateNode ?? updateNodeRequest,
  });
}

export type { NodeConnectionAction } from "./nodeConnectionActions.ts";
