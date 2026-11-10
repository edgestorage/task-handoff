export const REMOTE_DESKTOP_GEOMETRY_CHANGED = "REMOTE_DESKTOP_GEOMETRY_CHANGED";

export type InputSuspensionNotice = {
  cause: string;
  recoverable: boolean;
  sessionRevision?: number;
};

export function parseInputSuspension(value: unknown): InputSuspensionNotice {
  const payload = value && typeof value === "object" && "payload" in value
    ? (value as { payload?: unknown }).payload
    : undefined;
  const item = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return {
    cause: typeof item.cause === "string" ? item.cause : "",
    recoverable: item.recoverable === true,
    sessionRevision: Number.isSafeInteger(item.sessionRevision) && (item.sessionRevision as number) >= 0
      ? item.sessionRevision as number
      : undefined,
  };
}

export function shouldResumeAfterInputSuspension(
  notice: InputSuspensionNotice,
  state: {
    inputRequested: boolean;
    isController: boolean;
    surfacePaused: boolean;
    documentFocused: boolean;
  },
) {
  return notice.recoverable
    && notice.cause === REMOTE_DESKTOP_GEOMETRY_CHANGED
    && notice.sessionRevision !== undefined
    && state.inputRequested
    && state.isController
    && !state.surfacePaused
    && state.documentFocused;
}
