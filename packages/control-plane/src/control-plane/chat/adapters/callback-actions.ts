export type ChatGatewayCallbackAction =
  | { type: "ai-session"; index: number }
  | { type: "instance-app-menu"; instanceId: string }
  | { type: "launch-app"; instanceId: string; appId: string }
  | { type: "pending-decision"; routeId: string; decision: "allow" | "deny" | "skip" };

export type ChatGatewayTokenResolver = (
  token: string,
  expectedType: "instance-app-menu" | "launch-app" | "pending-decision",
) => { instanceId?: string; appId?: string; routeId?: string; decision?: unknown };

export function parseChatGatewayCallbackAction(data: string, resolveToken: ChatGatewayTokenResolver): ChatGatewayCallbackAction | undefined {
  const sessionMatch = data.match(/^task_handoff:cp_session:(\d+)$/);
  if (sessionMatch) {
    return {
      type: "ai-session",
      index: Number(sessionMatch[1]),
    };
  }
  const instanceAppsMatch = data.match(/^task_handoff:cp_i:([^:]+)$/) || data.match(/^task_handoff:cp_instance_apps:([^:]+)$/);
  if (instanceAppsMatch) {
    if (instanceAppsMatch[0].startsWith("task_handoff:cp_i:")) {
      const action = resolveToken(instanceAppsMatch[1], "instance-app-menu");
      return {
        type: "instance-app-menu",
        instanceId: requireTokenField(action.instanceId, "instanceId"),
      };
    }
    return {
      type: "instance-app-menu",
      instanceId: decodeChatCallbackPart(instanceAppsMatch[1]),
    };
  }
  const launchAppMatch = data.match(/^task_handoff:cp_a:([^:]+)$/) || data.match(/^task_handoff:cp_launch_app:([^:]+):([^:]+)$/);
  if (launchAppMatch) {
    if (launchAppMatch[0].startsWith("task_handoff:cp_a:")) {
      const action = resolveToken(launchAppMatch[1], "launch-app");
      return {
        type: "launch-app",
        instanceId: requireTokenField(action.instanceId, "instanceId"),
        appId: requireTokenField(action.appId, "appId"),
      };
    }
    return {
      type: "launch-app",
      instanceId: decodeChatCallbackPart(launchAppMatch[1]),
      appId: decodeChatCallbackPart(launchAppMatch[2]),
    };
  }
  const approvalTokenMatch = data.match(/^task_handoff:cp_p:([^:]+)$/);
  if (approvalTokenMatch) {
    const action = resolveToken(approvalTokenMatch[1], "pending-decision");
    return {
      type: "pending-decision",
      routeId: requireTokenField(action.routeId, "routeId"),
      decision: requireTokenDecision(action.decision),
    };
  }
  const approvalMatch = data.match(/^task_handoff:approval:([^:]+:ai:[^:]+):(allow|deny|skip)$/);
  if (approvalMatch) {
    return {
      type: "pending-decision",
      routeId: approvalMatch[1],
      decision: approvalMatch[2] as "allow" | "deny" | "skip",
    };
  }
  return undefined;
}

function requireTokenField(value: unknown, fieldName: string) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throwInvalidChatActionToken(`Chat action token is missing ${fieldName}.`);
}

function requireTokenDecision(value: unknown): "allow" | "deny" | "skip" {
  if (value === "allow" || value === "deny" || value === "skip") {
    return value;
  }
  throwInvalidChatActionToken("Chat action token has an invalid decision.");
}

function throwInvalidChatActionToken(message: string): never {
  const error = new Error(message);
  Object.assign(error, { statusCode: 400, code: "CHAT_ACTION_TOKEN_INVALID" });
  throw error;
}

function decodeChatCallbackPart(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}
