import { z } from "zod";
import {
  AccountPublicProfileSchema,
  DeviceSessionSchema,
  MobileAuthorizationResponseSchema,
  MobileTokenResponseSchema,
  TotpEnrollmentResponseSchema,
  type AccountPublicProfile,
  type DeviceSession,
  type MobileAuthorizationResponse,
  type MobileTokenResponse,
  type TotpEnrollmentResponse,
} from "./account.ts";
import { AccessTicketSchema, RelayAllocationSchema, type AccessTicket, type RelayAllocation } from "./relay.ts";
import { OfficialAccountClient, officialClientError } from "./client.ts";

export type OfficialApiInput = Readonly<Record<string, unknown>>;
export type OfficialProviderId = "email" | "google" | "github" | (string & {});

export class OfficialMobileAccountClient extends OfficialAccountClient {
  register(input: OfficialApiInput): Promise<unknown> { return this.publicCall("/api/v1/auth/register", input, z.unknown()); }
  login(input: OfficialApiInput): Promise<MobileAuthorizationResponse> { return this.publicCall("/api/v1/auth/authorize", input, MobileAuthorizationResponseSchema); }
  exchangeAuthorizationCode(input: OfficialApiInput): Promise<MobileTokenResponse> { return this.publicCall("/api/v1/auth/token", input, MobileTokenResponseSchema); }
  refresh(input: OfficialApiInput): Promise<MobileTokenResponse> { return this.publicCall("/api/v1/auth/refresh", input, MobileTokenResponseSchema); }
  verifyEmail(input: OfficialApiInput): Promise<unknown> { return this.publicCall("/api/v1/auth/verify-email", input, z.unknown()); }
  stepUp(input: OfficialApiInput): Promise<unknown> { return this.dataCall("/api/v1/auth/step-up", "POST", z.unknown(), input); }
  logout() { return this.call("/api/v1/auth/logout", { method: "POST", body: "{}" }); }
  profile(): Promise<AccountPublicProfile> { return this.dataCall("/api/v1/account", "GET", AccountPublicProfileSchema.strip()); }
  devices(): Promise<DeviceSession[]> { return this.dataCall("/api/v1/devices", "GET", z.array(DeviceSessionSchema.strip())); }
  providers(): Promise<unknown[]> { return this.dataCall("/api/v1/providers", "GET", z.array(z.unknown())); }
  revokeDevice(deviceSessionId: string): Promise<unknown> { return this.dataCall(`/api/v1/devices/${encodeURIComponent(deviceSessionId)}`, "DELETE", z.unknown()); }
  beginTotp(input: OfficialApiInput): Promise<TotpEnrollmentResponse> { return this.dataCall("/api/v1/account/totp/enroll", "POST", TotpEnrollmentResponseSchema.strip(), input); }
  confirmTotp(input: OfficialApiInput): Promise<unknown> { return this.dataCall("/api/v1/account/totp/confirm", "POST", z.unknown(), input); }
  disableTotp(input: OfficialApiInput): Promise<unknown> { return this.dataCall("/api/v1/account/totp", "DELETE", z.unknown(), input); }
  changePassword(input: OfficialApiInput): Promise<unknown> { return this.dataCall("/api/v1/account/password", "PATCH", z.unknown(), input); }
  changeEmail(input: OfficialApiInput): Promise<unknown> { return this.dataCall("/api/v1/account/email", "PATCH", z.unknown(), input); }
  linkProvider(providerId: OfficialProviderId, input: OfficialApiInput): Promise<unknown> { return this.dataCall(`/api/v1/providers/${encodeURIComponent(providerId)}/link`, "POST", z.unknown(), input); }
  unlinkProvider(providerId: OfficialProviderId, input: OfficialApiInput): Promise<unknown> { return this.dataCall(`/api/v1/providers/${encodeURIComponent(providerId)}/unlink`, "POST", z.unknown(), input); }
  issueAccessTicket(input: OfficialApiInput): Promise<AccessTicket> { return this.dataCall("/api/v1/access-tickets", "POST", AccessTicketSchema.strip(), input); }
  allocateRelay(input: OfficialApiInput): Promise<RelayAllocation> { return this.dataCall("/api/v1/relay-allocations", "POST", RelayAllocationSchema, input); }

  private async dataCall<T>(path: string, method: string, schema: z.ZodType<T>, input?: OfficialApiInput): Promise<T> {
    const body = await this.call<unknown>(path, { method, ...(input ? { body: JSON.stringify(input) } : method === "GET" ? {} : { body: "{}" }) });
    return responseData(schema, body);
  }

  private async publicCall<T>(path: string, input: OfficialApiInput, schema: z.ZodType<T>): Promise<T> {
    const response = await this.request(`${this.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-task-handoff-client": "mobile" }, body: JSON.stringify(input), credentials: "omit", redirect: "error" });
    const body: unknown = await response.json();
    if (!response.ok) throw officialClientError(body, response.status);
    return responseData(schema, body);
  }
}

function responseData<T>(schema: z.ZodType<T>, body: unknown): T {
  return z.object({ data: schema }).parse(body).data;
}
