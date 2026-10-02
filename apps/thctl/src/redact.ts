/**
 * 密钥脱敏的唯一实现。字段名匹配敏感键时整体替换为占位符；
 * 另外登记本进程出现过的密钥明文，确保服务端把它回显到 message 时也能擦除。
 */
export const REDACTED_SECRET = "***";

const SENSITIVE_KEY_SUFFIX = /(token|secret|password|passwd|credential|credentials|apikey|privatekey)$/i;
const SENSITIVE_KEY_EXACT = new Set(["key", "token", "secret", "password", "credentials", "credential"]);

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY_EXACT.has(key.toLowerCase()) || SENSITIVE_KEY_SUFFIX.test(key);
}

const registeredSecrets = new Set<string>();

/** 登记密钥明文；过短的字符串不登记，避免把常见子串误伤成大范围替换。 */
export function registerSecret(value: unknown) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length >= 4) registeredSecrets.add(trimmed);
}

export function redactText(text: string) {
  let output = text;
  for (const secret of registeredSecrets) output = output.split(secret).join(REDACTED_SECRET);
  return output;
}

export function redactSecrets(value: unknown): unknown {
  return walk(value);
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED_SECRET : walk(entry);
  }
  return output;
}

/** 从写请求体登记所有敏感字段明文，供后续错误/日志擦除。 */
export function registerSecretsFromValue(value: unknown) {
  if (Array.isArray(value)) {
    for (const entry of value) registerSecretsFromValue(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) registerSecret(entry);
    else registerSecretsFromValue(entry);
  }
}
