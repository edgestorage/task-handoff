import crypto from "node:crypto";
import { ExpiringTokenStore } from "../tokens/expiring-token-store.ts";

const PENDING_DECISION_CALLBACK_PREFIX = "task_handoff:cp_p:v1:";
const PENDING_DECISION_FINGERPRINT_BYTES = 12;
const pendingDecisionCodes = {
  allow: "a",
  deny: "d",
  skip: "s",
} as const;

export type PendingDecisionCallbackReference = {
  routeFingerprint: string;
  decision: "allow" | "deny" | "skip";
};

export function pendingDecisionRouteFingerprint(routeId: string) {
  return crypto
    .createHash("sha256")
    .update(routeId)
    .digest("base64url")
    .slice(0, Math.ceil(PENDING_DECISION_FINGERPRINT_BYTES * 4 / 3));
}

export function parsePendingDecisionCallbackData(data: string): PendingDecisionCallbackReference | undefined {
  const match = data.match(/^task_handoff:cp_p:v1:([ads]):([A-Za-z0-9_-]{16})$/);
  if (!match) {
    return undefined;
  }
  const decision = Object.entries(pendingDecisionCodes).find(([, code]) => code === match[1])?.[0];
  if (decision !== "allow" && decision !== "deny" && decision !== "skip") {
    return undefined;
  }
  return { routeFingerprint: match[2], decision };
}

export type ChatActionToken = {
  token: string;
  type: "instance-app-menu" | "launch-app" | "pending-decision";
  instanceId?: string;
  appId?: string;
  routeId?: string;
  decision?: "allow" | "deny" | "skip";
  expiresAt: string;
};

export class ChatActionTokenService {
  private readonly tokens = new ExpiringTokenStore<ChatActionToken>({
    invalidMessage: "Chat action expired.",
    invalidCode: "CHAT_ACTION_TOKEN_INVALID",
    tokenBytes: 9,
    ttlMs: 10 * 60 * 1000,
  });

  create(input:
    | { type: "instance-app-menu" | "launch-app"; instanceId: string; appId?: string; ttlMs?: number }
    | { type: "pending-decision"; routeId: string; decision: "allow" | "deny" | "skip"; ttlMs?: number }
  ) {
    return this.tokens.create({
      type: input.type,
      instanceId: "instanceId" in input ? input.instanceId : undefined,
      appId: "appId" in input ? input.appId : undefined,
      routeId: "routeId" in input ? input.routeId : undefined,
      decision: "decision" in input ? input.decision : undefined,
      ttlMs: input.ttlMs,
    });
  }

  resolve(token: string, type?: ChatActionToken["type"]) {
    return this.tokens.resolve(token, (record) => !type || record.type === type);
  }

  pendingDecisionCallbackData(routeId: string, decision: "allow" | "deny" | "skip") {
    return `${PENDING_DECISION_CALLBACK_PREFIX}${pendingDecisionCodes[decision]}:${pendingDecisionRouteFingerprint(routeId)}`;
  }
}
