export const CONTROL_PLANE_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie"]);

export function isControlPlaneCredentialHeader(name: string) {
  return CONTROL_PLANE_CREDENTIAL_HEADERS.has(name.toLowerCase());
}
