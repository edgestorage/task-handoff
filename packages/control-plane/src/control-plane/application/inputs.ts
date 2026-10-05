import {
  CopyModelInputSchema,
  CreateModelInputSchema,
  CreateNodeControlPlaneConnectionInputSchema,
  CreateNodeInputSchema,
  CreateNodeJoinInviteInputSchema,
  ModelDiscoveryInputSchema,
  ModelTestInputSchema,
  NodeAuthInputSchema,
  UpdateModelInputSchema,
  UpdateNodeInputSchema,
  UpdateInstanceInputSchema,
} from "@task-handoff/protocol/control-plane";
import { z } from "zod";

export * from "../catalog/inputs.ts";
export * from "../chat/bridges/inputs.ts";
export * from "../triggers/inputs.ts";

// Management write inputs are owned by the protocol boundary now; re-export so
// the server keeps one authoritative definition shared with the panel and CLI.
export {
  CopyModelInputSchema,
  CreateModelInputSchema,
  CreateNodeControlPlaneConnectionInputSchema,
  CreateNodeInputSchema,
  CreateNodeJoinInviteInputSchema,
  ModelDiscoveryInputSchema,
  ModelTestInputSchema,
  NodeAuthInputSchema,
  UpdateModelInputSchema,
  UpdateNodeInputSchema,
  UpdateInstanceInputSchema,
};

export type CreateModelInput = z.infer<typeof CreateModelInputSchema>;
export type UpdateModelInput = z.infer<typeof UpdateModelInputSchema>;
export type ModelDiscoveryInput = z.infer<typeof ModelDiscoveryInputSchema>;
export type ModelTestInput = z.infer<typeof ModelTestInputSchema>;
export type CreateNodeInput = z.infer<typeof CreateNodeInputSchema>;
export type UpdateNodeInput = z.infer<typeof UpdateNodeInputSchema>;
export type CreateNodeControlPlaneConnectionInput = z.infer<typeof CreateNodeControlPlaneConnectionInputSchema>;
export type UpdateInstanceInput = z.infer<typeof UpdateInstanceInputSchema>;
