/**
 * Stable relay error codes. Only these cross the relay boundary; upstream
 * messages, endpoints and credentials must never be embedded in responses.
 */
export const MODEL_RELAY_ERROR_CODES = {
  unauthorized: "MODEL_RELAY_UNAUTHORIZED",
  routeNotFound: "MODEL_RELAY_ROUTE_NOT_FOUND",
  disabled: "MODEL_RELAY_DISABLED",
  shuttingDown: "MODEL_RELAY_SHUTTING_DOWN",
  busy: "MODEL_RELAY_BUSY",
  unsupported: "MODEL_RELAY_UNSUPPORTED",
  entityDisabled: "MODEL_RELAY_ENTITY_DISABLED",
  operationNotAllowed: "MODEL_RELAY_OPERATION_NOT_ALLOWED",
  unknownModelName: "MODEL_RELAY_UNKNOWN_MODEL_NAME",
  ambiguousModelName: "MODEL_RELAY_AMBIGUOUS_MODEL_NAME",
  invalidRequestModel: "MODEL_RELAY_INVALID_REQUEST_MODEL",
  requestHeadersTooLarge: "MODEL_RELAY_REQUEST_HEADERS_TOO_LARGE",
  requestTooLarge: "MODEL_RELAY_REQUEST_PROLOGUE_TOO_LARGE",
  upstreamUnavailable: "MODEL_RELAY_UPSTREAM_UNAVAILABLE",
  upstreamRedirect: "MODEL_RELAY_UPSTREAM_REDIRECT",
  upstreamTimeout: "MODEL_RELAY_UPSTREAM_TIMEOUT",
  upstreamAborted: "MODEL_RELAY_UPSTREAM_ABORTED",
  upstreamStreamError: "MODEL_RELAY_UPSTREAM_STREAM_ERROR",
} as const;

export type ModelRelayErrorCode = typeof MODEL_RELAY_ERROR_CODES[keyof typeof MODEL_RELAY_ERROR_CODES];

export function modelRelayError(
  statusCode: number,
  code: ModelRelayErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return Object.assign(new Error(message), {
    statusCode,
    code,
    ...(details ? { details } : {}),
  });
}
