export interface NativeAppleAuthentication {
  bundleId: string;
  signIn(challenge: { state: string; nonce: string }): Promise<{ state: string | null; identityToken: string | null } | undefined>;
}

export async function nativeAppleAuthentication(): Promise<NativeAppleAuthentication | undefined> {
  return undefined;
}
