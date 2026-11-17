export const REMOTE_DESKTOP_GEOMETRY_CHANGED = "REMOTE_DESKTOP_GEOMETRY_CHANGED";

export type InputSuspensionNotice = {
  cause: string;
  recoverable: boolean;
  sessionRevision?: number;
};

export type InputRecoveryState = {
  inputRequested: boolean;
  isController: boolean;
  surfacePaused: boolean;
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
  state: InputRecoveryState & { documentFocused: boolean },
) {
  return notice.recoverable
    && notice.sessionRevision !== undefined
    && state.inputRequested
    && state.isController
    && !state.surfacePaused
    && state.documentFocused;
}

export function shouldResumeAfterInputError(
  recoverable: boolean,
  state: InputRecoveryState,
) {
  return recoverable
    && state.inputRequested
    && state.isController
    && !state.surfacePaused;
}

export function remoteDesktopSurfaceOwnsFocus(
  surface: Element | null | undefined,
  activeElement: Element | null | undefined,
  documentFocused: boolean,
) {
  return Boolean(
    documentFocused
    && surface
    && activeElement
    && (surface === activeElement || surface.contains(activeElement)),
  );
}
