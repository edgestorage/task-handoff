const CONTROL_PLANE_HEADER = "x-task-handoff-control-plane-id";
const USER_HEADER = "x-task-handoff-user-id";

function forwardedHeader(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name];
  const normalized = (Array.isArray(value) ? value[0] : value)?.trim();
  return normalized ? normalized : undefined;
}

export function browserControlIdentityHeaders(headers: Record<string, string | string[] | undefined>) {
  const controlPlaneId = forwardedHeader(headers, CONTROL_PLANE_HEADER);
  const userId = forwardedHeader(headers, USER_HEADER);
  if (!controlPlaneId || !userId) {
    throw Object.assign(new Error("Verified Control Plane identity headers are required for browser control."), {
      code: "BROWSER_CHANNEL_IDENTITY_MISSING",
    });
  }
  return {
    [CONTROL_PLANE_HEADER]: controlPlaneId,
    [USER_HEADER]: userId,
  };
}
