const SOURCE_ENDED_ERRORS = new Set([
  // A window source becomes unavailable when it is closed or minimized. The
  // component retries short WindowServer/AX races first, so this terminal code
  // means the viewer must choose a different capture source.
  "REMOTE_DESKTOP_WINDOW_UNAVAILABLE",
]);

export function isRemoteDesktopSourceEndedError(code: unknown) {
  return typeof code === "string" && SOURCE_ENDED_ERRORS.has(code);
}
