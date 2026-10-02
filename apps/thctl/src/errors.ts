export const CLI_EXIT_CODES = {
  ok: 0,
  usage: 2,
  notImplemented: 3,
  confirmationRequired: 4,
  notAuthenticated: 5,
  forbidden: 6,
  notFound: 7,
  conflict: 8,
  rateLimited: 9,
  network: 10,
  protocol: 11,
  server: 12,
  identity: 13,
  capability: 14,
  cancelled: 15,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export class ThctlError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    exitCode: number = CLI_EXIT_CODES.server,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ThctlError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usageError(code: string, message: string, details?: Record<string, unknown>) {
  return new ThctlError(code, message, CLI_EXIT_CODES.usage, details);
}

export function notImplementedError(commandId: string, stage: string) {
  return new ThctlError(
    "CLI_COMMAND_NOT_IMPLEMENTED",
    `\`${commandId}\` is declared but not implemented yet (planned stage ${stage}).`,
    CLI_EXIT_CODES.notImplemented,
    { command: commandId, stage },
  );
}

/**
 * capability 缺失只关闭对应功能域：命令与所需能力写进 details，退出码固定 14。
 * 旧服务端未注册的新路由也归一到这里（见 routeMissingError）。
 */
export function capabilityMissingError(commandId: string, capability: string, details?: Record<string, unknown>) {
  return new ThctlError(
    "CLI_CAPABILITY_MISSING",
    `\`${commandId}\` requires capability \`${capability}\`, which the connected Control Plane or node does not declare. Upgrade it or pick a supported command.`,
    CLI_EXIT_CODES.capability,
    { command: commandId, capability, ...details },
  );
}

/**
 * 未注册路由（无结构化错误信封的 404/405/501）说明服务端版本早于该命令；
 * 在 executeLeaf 中会带上 command 归一为 CLI_CAPABILITY_MISSING。
 */
export function routeMissingError(status: number, method: string, path: string) {
  return new ThctlError(
    "CLI_ROUTE_MISSING",
    `The Control Plane does not expose \`${method} ${path}\` (HTTP ${status}); this server version predates the command.`,
    CLI_EXIT_CODES.capability,
    { path, status, method },
  );
}

export function protocolError(message: string, details?: Record<string, unknown>) {
  return new ThctlError("CLI_PROTOCOL_ERROR", message, CLI_EXIT_CODES.protocol, details);
}

export function networkError(message: string, details?: Record<string, unknown>) {
  return new ThctlError("CLI_NETWORK_ERROR", message, CLI_EXIT_CODES.network, details);
}

const HTTP_STATUS_EXIT_CODES: Record<number, number> = {
  400: CLI_EXIT_CODES.usage,
  401: CLI_EXIT_CODES.notAuthenticated,
  403: CLI_EXIT_CODES.forbidden,
  404: CLI_EXIT_CODES.notFound,
  409: CLI_EXIT_CODES.conflict,
  410: CLI_EXIT_CODES.notFound,
  429: CLI_EXIT_CODES.rateLimited,
};

const AUTHENTICATION_ERROR_CODES = new Set([
  "CONTROL_PLANE_AUTH_REQUIRED",
  "AUTH_PASSWORD_CHANGE_REQUIRED",
  "CLI_AUTHORIZATION_PENDING",
  "CLI_AUTHORIZATION_SLOW_DOWN",
  "CLI_AUTHORIZATION_DENIED",
  "CLI_AUTHORIZATION_EXPIRED",
  "CLI_AUTHORIZATION_INVALID_GRANT",
  "CLI_AUTHORIZATION_FAILED",
  "CLI_AUTHORIZATION_REQUEST_UNKNOWN",
]);

/** 服务端错误按状态码和错误码映射到稳定退出码；未知组合统一落到 server。 */
export function serverError(status: number, code: string, message: string, details?: Record<string, unknown>) {
  const exitCode = AUTHENTICATION_ERROR_CODES.has(code)
    ? CLI_EXIT_CODES.notAuthenticated
    : HTTP_STATUS_EXIT_CODES[status] ?? CLI_EXIT_CODES.server;
  return new ThctlError(code, message, exitCode, details);
}

export function toThctlError(error: unknown) {
  if (error instanceof ThctlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ThctlError("CLI_INTERNAL_ERROR", message, CLI_EXIT_CODES.server);
}
