import { z } from "zod";

const ProfileNameSchema = z.string().trim().min(1).max(60);

/**
 * Stable default-language placeholder the instance writes into `name` for the
 * profile it creates on its own. The wire value must stay byte-identical
 * across versions (older consumers require a non-empty name), so it is a
 * fixed string rather than a localized one: consumers may render a localized
 * label while the stored name still equals this placeholder, and a renamed
 * profile simply stops matching it.
 */
export const DEFAULT_APP_PROFILE_NAME = "Default";

/**
 * Browser profile projection shared by the controlled instance and the
 * control plane. The directory of a profile is instance-private state and is
 * never projected onto this wire model.
 */
export const AppProfileSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    name: ProfileNameSchema,
    isDefault: z.boolean(),
    runningSessionId: z.string().trim().min(1).max(160).optional(),
    diskUsageBytes: z.number().int().nonnegative().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AppProfileListSchema = z
  .object({
    appId: z.string().trim().min(1).max(120),
    defaultProfileId: z.string().trim().min(1).max(120),
    profiles: z.array(AppProfileSchema).max(200),
    observedAt: z.string().datetime(),
  })
  .strict();

export const AppProfileCreateInputSchema = z.object({ name: ProfileNameSchema }).strict();
export const AppProfileRenameInputSchema = z.object({ name: ProfileNameSchema }).strict();

export type AppProfile = z.infer<typeof AppProfileSchema>;
export type AppProfileList = z.infer<typeof AppProfileListSchema>;
