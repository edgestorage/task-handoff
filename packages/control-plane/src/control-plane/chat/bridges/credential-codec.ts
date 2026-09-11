import { z } from "zod";
import { ChatBridgeConfigSchema, type ChatBridgeConfig } from "@task-handoff/protocol/control-plane";

const OptionalSecretSchema = z.string().trim().min(1).max(8192).optional();
const CommonCredentialSchema = z.object({ token: OptionalSecretSchema }).strict();

const channelSettings = {
  web: {
    public: z.object({}).strict(),
    secret: z.object({}).strict(),
  },
  telegram: {
    public: z.object({ telegramLastUpdateId: z.number().int().nonnegative().optional() }).strict(),
    secret: z.object({}).strict(),
  },
  wechat: {
    public: z.object({ baseUrl: z.string().trim().url().max(2048).optional(), updatesBuf: z.string().max(8192).optional() }).strict(),
    secret: z.object({ contextToken: OptionalSecretSchema }).strict(),
  },
  dingding: {
    public: z.object({
      robotCode: z.string().trim().min(1).max(512).optional(),
      corpId: z.string().trim().min(1).max(512).optional(),
      senderId: z.string().trim().min(1).max(512).optional(),
      cardUserIdType: z.number().int().positive().max(100).optional(),
    }).strict(),
    secret: z.object({ clientSecret: OptionalSecretSchema, sessionWebhook: OptionalSecretSchema }).strict(),
  },
  lark: {
    public: z.object({ domain: z.enum(["feishu", "lark"]).optional() }).strict(),
    secret: z.object({ appSecret: OptionalSecretSchema }).strict(),
  },
} as const;

export type ChatBridgeCredential = {
  token?: string;
  settings: Record<string, string>;
};

export function splitChatBridgeCredential(input: ChatBridgeConfig) {
  const bridge = ChatBridgeConfigSchema.parse(input);
  const schemas = channelSettings[bridge.channel];
  const publicKeys = new Set(Object.keys(schemas.public.shape));
  const secretKeys = new Set(Object.keys(schemas.secret.shape));
  const unknown = Object.keys(bridge.settings).filter((key) => !publicKeys.has(key) && !secretKeys.has(key));
  if (unknown.length) {
    throw Object.assign(new Error(`Chat bridge settings contain unsupported fields: ${unknown.sort().join(", ")}.`), {
      code: "CHAT_BRIDGE_SETTINGS_UNSUPPORTED",
      statusCode: 400,
      details: { channel: bridge.channel, fields: unknown.sort() },
    });
  }
  const publicSettings = schemas.public.parse(Object.fromEntries(Object.entries(bridge.settings).filter(([key]) => publicKeys.has(key))));
  const secretSettings = schemas.secret.parse(Object.fromEntries(Object.entries(bridge.settings).filter(([key]) => secretKeys.has(key))));
  const credential = CommonCredentialSchema.extend({ settings: schemas.secret }).parse({ token: bridge.token, settings: secretSettings });
  return {
    publicSettings,
    credential: credential.token || Object.keys(credential.settings).length ? credential as ChatBridgeCredential : undefined,
  };
}

export function joinChatBridgeCredential(
  channel: ChatBridgeConfig["channel"],
  publicSettings: Record<string, unknown>,
  credential: ChatBridgeCredential | undefined,
) {
  const schemas = channelSettings[channel];
  const safePublic = schemas.public.parse(publicSettings);
  const safeCredential = CommonCredentialSchema.extend({ settings: schemas.secret }).parse(credential || { settings: {} });
  return {
    ...(safeCredential.token ? { token: safeCredential.token } : {}),
    settings: { ...safePublic, ...safeCredential.settings },
  };
}

export const ChatBridgeCredentialSchema = z.object({
  token: OptionalSecretSchema,
  settings: z.record(z.string(), z.string()),
}).strict();
