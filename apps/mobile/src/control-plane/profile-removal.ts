export async function requireRemoteMobileSessionRevocation(logoutMobile: () => Promise<unknown>) {
  try {
    await logoutMobile();
  } catch (cause) {
    const status = cause && typeof cause === 'object' && 'status' in cause ? (cause as { status?: unknown }).status : undefined;
    if (status !== 401) throw cause;
  }
}
