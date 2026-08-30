export async function attemptRemoteMobileSessionRevocation(logoutMobile: () => Promise<unknown>) {
  try {
    await logoutMobile();
    return true;
  } catch (cause) {
    const status = cause && typeof cause === 'object' && 'status' in cause ? (cause as { status?: unknown }).status : undefined;
    return status === 401;
  }
}
