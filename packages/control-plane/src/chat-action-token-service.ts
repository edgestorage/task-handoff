import { ExpiringTokenStore } from "./expiring-token-store.ts";

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
    return `task_handoff:cp_p:${this.create({ type: "pending-decision", routeId, decision }).token}`;
  }
}
