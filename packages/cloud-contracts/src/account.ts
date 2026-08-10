import { z } from "zod";
import { DateTimeSchema, IdSchema, LocaleTextSchema, OpaqueSecretSchema } from "./common.ts";
import { OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION, OfficialAudience } from "./versions.ts";

export const AccountApiContextSchema = z.strictObject({
  protocolVersion: z.literal(OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION),
  audience: z.literal(OfficialAudience.AccountApi),
});

export const NormalizedEmailSchema = z.string().email().max(320).transform((value) => value.trim().toLowerCase());
export const AccountStatusSchema = z.enum(["pending-verification", "active", "disabled", "pending-deletion"]);

export const AccountPublicProfileSchema = z.strictObject({
  id: IdSchema,
  email: NormalizedEmailSchema,
  emailVerified: z.boolean(),
  hasPassword: z.boolean().optional(),
  totpEnabled: z.boolean().optional(),
  displayName: LocaleTextSchema.optional(),
  status: AccountStatusSchema,
  createdAt: DateTimeSchema,
});

export const DeviceSessionSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(["browser", "mobile"]),
  deviceName: z.string().trim().min(1).max(160),
  platform: z.string().trim().min(1).max(80).optional(),
  createdAt: DateTimeSchema,
  lastSeenAt: DateTimeSchema.optional(),
  expiresAt: DateTimeSchema,
  revokedAt: DateTimeSchema.optional(),
});

export const MobileAuthorizationResponseSchema = z.union([
  z.object({
    code: OpaqueSecretSchema,
    state: z.string().min(1).max(4096).optional(),
    redirectUri: z.string().url(),
    expiresAt: DateTimeSchema,
  }),
  z.object({
    authorizationUrl: z.string().url(),
    expiresAt: DateTimeSchema,
  }),
]);

export const MobileTokenResponseSchema = z.object({
  tokenType: z.literal("Bearer"),
  accessToken: OpaqueSecretSchema,
  accessExpiresAt: DateTimeSchema,
  refreshCredential: OpaqueSecretSchema,
  accountId: IdSchema,
  deviceSessionId: IdSchema,
});

export const TotpEnrollmentResponseSchema = z.strictObject({
  enrollmentToken: OpaqueSecretSchema,
  secret: OpaqueSecretSchema,
  algorithm: z.literal("SHA1"),
  digits: z.literal(6),
  periodSeconds: z.literal(30),
  otpauthUri: z.string().url().startsWith("otpauth://totp/"),
  expiresAt: DateTimeSchema,
});

export type AccountPublicProfile = z.infer<typeof AccountPublicProfileSchema>;
export type DeviceSession = z.infer<typeof DeviceSessionSchema>;
export type MobileAuthorizationResponse = z.infer<typeof MobileAuthorizationResponseSchema>;
export type MobileTokenResponse = z.infer<typeof MobileTokenResponseSchema>;
export type TotpEnrollmentResponse = z.infer<typeof TotpEnrollmentResponseSchema>;
