import {
  ControlPlaneSettingsSchema,
  CreateImageInputSchema,
  CreateProjectInputSchema,
  UpdateControlPlaneSettingsSchema,
  UpdateImageInputSchema,
  UpdateProjectInputSchema,
} from "@task-handoff/protocol/control-plane";
import type { z } from "zod";

// The management write inputs moved to `@task-handoff/protocol/control-plane` so
// the panel and `thctl` share one authoritative wire contract. Re-export keeps
// existing server imports working while the definitions live at the boundary.
export {
  CommandTriggerSchema,
  ControlPlaneSettingsSchema,
  CreateImageInputSchema,
  CreateProjectInputSchema,
  DEFAULT_COMMAND_TRIGGER,
  DEFAULT_MENTION_TRIGGER,
  isValidCommandTrigger,
  isValidMentionTrigger,
  MentionTriggerSchema,
  sanitizeStoredControlPlaneSettings,
  UpdateControlPlaneSettingsSchema,
  UpdateImageInputSchema,
  UpdateProjectInputSchema,
} from "@task-handoff/protocol/control-plane";

export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;
export type CreateImageInput = z.infer<typeof CreateImageInputSchema>;
export type UpdateImageInput = z.infer<typeof UpdateImageInputSchema>;
export type ControlPlaneSettings = z.infer<typeof ControlPlaneSettingsSchema>;
export type UpdateControlPlaneSettingsInput = z.infer<typeof UpdateControlPlaneSettingsSchema>;
