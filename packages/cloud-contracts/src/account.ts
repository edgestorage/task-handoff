import { z } from "zod";
import { DateTimeSchema, IdSchema, LocaleTextSchema, OpaqueSecretSchema } from "./common.ts";
import { MOBILE_REFRESH_RECOVERY_PROTOCOL_VERSION, OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION, OfficialAudience } from "./versions.ts";

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

// Control Planes sign in to the account as their own device session, so the public
// device list carries a third kind next to browser and mobile sessions.
export const DeviceSessionKindSchema = z.enum(["browser", "mobile", "control-plane"]);

export const DeviceSessionSchema = z.strictObject({
  id: IdSchema,
  kind: DeviceSessionKindSchema,
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


// Native Apple authorization is opt-in and uses the same account/PKCE boundary.
// Only the server-issued nonce and single-use state cross the native SDK boundary.
export const AppleNativeChallengeRequestSchema = z.strictObject({
  bundleId: z.string().min(1).max(255),
  redirectUri: z.url(),
  clientId: z.literal("mobile"),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  codeChallengeMethod: z.literal("S256"),
  scopes: z.array(z.string()).optional(),
  state: z.string().min(1).max(4096),
});
export const AppleNativeChallengeResponseSchema = z.object({
  state: OpaqueSecretSchema,
  nonce: z.string().min(16).max(256),
  expiresAt: DateTimeSchema,
});
export const AppleNativeCompleteRequestSchema = z.strictObject({
  state: OpaqueSecretSchema,
  identityToken: z.string().min(1).max(16 * 1024),
});
export const ProviderAccountConfirmationRequestSchema = z.strictObject({
  flow: OpaqueSecretSchema,
  acceptTerms: z.literal(true),
  termsVersion: z.string().min(1).max(80),
});
export const AppleNativeAuthorizationResponseSchema = z.union([
  z.object({ code: OpaqueSecretSchema, state: z.string().min(1), redirectUri: z.url(), expiresAt: DateTimeSchema }),
  z.object({ confirmationRequired: z.literal(true), flow: OpaqueSecretSchema, termsVersion: z.string().min(1), expiresAt: DateTimeSchema }),
]);
export type AppleNativeChallengeRequest = z.infer<typeof AppleNativeChallengeRequestSchema>;
export type AppleNativeChallengeResponse = z.infer<typeof AppleNativeChallengeResponseSchema>;
export type AppleNativeCompleteRequest = z.infer<typeof AppleNativeCompleteRequestSchema>;
export type AppleNativeAuthorizationResponse = z.infer<typeof AppleNativeAuthorizationResponseSchema>;
export type ProviderAccountConfirmationRequest = z.infer<typeof ProviderAccountConfirmationRequestSchema>;

export const MobileTokenResponseSchema = z.object({
  tokenType: z.literal("Bearer"),
  accessToken: OpaqueSecretSchema,
  accessExpiresAt: DateTimeSchema,
  refreshCredential: OpaqueSecretSchema,
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  // Sliding account-session expiry; every rotation inside the window pushes it forward.
  sessionExpiresAt: DateTimeSchema.optional(),
});

export const MobileRefreshRotationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * Mobile refresh recovery is a small extension of the account boundary. The client persists
 * the proposed next credential and rotation id before sending this request. A retry with the
 * same tuple lets the Coordinator distinguish a lost response from an actual credential replay.
 * Legacy mobile clients keep using `/api/v1/auth/refresh` unchanged.
 */
export const MobileRefreshRecoveryRequestSchema = z.strictObject({
  protocolVersion: z.literal(MOBILE_REFRESH_RECOVERY_PROTOCOL_VERSION),
  refreshCredential: OpaqueSecretSchema,
  nextRefreshCredential: OpaqueSecretSchema,
  rotationId: MobileRefreshRotationIdSchema,
  deviceSessionId: IdSchema,
  scopes: z.array(z.string()).optional(),
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
export type MobileRefreshRecoveryRequest = z.infer<typeof MobileRefreshRecoveryRequestSchema>;
export type TotpEnrollmentResponse = z.infer<typeof TotpEnrollmentResponseSchema>;
