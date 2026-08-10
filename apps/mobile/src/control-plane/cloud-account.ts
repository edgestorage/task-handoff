import { OfficialMobileAccountClient as CloudMobileAccountClient, type MobileTokenResponse } from '@task-handoff/cloud-contracts/mobile';
import * as Crypto from 'expo-crypto';
import type { SecureValueStore } from '../platform/secure-storage';
import { isMobileCloudRelayEnabled, isMobileStagingMode, isMobileTestMode, mobileStagingCloudOrigin } from '../platform/build-variant';

export const CLOUD_PRODUCTION_ORIGIN = 'https://cloud.thandoff.com';
type TokenSet = Omit<MobileTokenResponse, 'tokenType'>;
type PendingEmailSecondFactor = { createdAt: number; email: string; password: string; redirectUri: string };
type LoginResult = { authorizationUrl?: string; code?: string; state?: string };

export class MobileCloudAccountSession {
  private tokenSet?: TokenSet;
  private refreshing?: Promise<string>;
  private readonly pending = new Map<string, { verifier: string; createdAt: number }>();
  private pendingEmailSecondFactor?: PendingEmailSecondFactor;
  readonly origin: string;
  readonly client: CloudMobileAccountClient;
  private restoration?: Promise<unknown>;

  constructor(private readonly secureStore: SecureValueStore, options: { origin?: string; request?: typeof fetch; allowNonProductionOrigin?: boolean; reference?: { id: string; secureCredentialKey: string } } = {}) {
    if (!isMobileCloudRelayEnabled) throw cloudError('CLOUD_RELAY_FEATURE_DISABLED');
    this.origin = new URL(options.origin ?? CLOUD_PRODUCTION_ORIGIN).origin;
    const trustedDevelopment = isMobileTestMode && options.allowNonProductionOrigin === true;
    const trustedStaging = isMobileStagingMode && Boolean(mobileStagingCloudOrigin) && this.origin === mobileStagingCloudOrigin;
    if (this.origin !== CLOUD_PRODUCTION_ORIGIN && !trustedDevelopment && !trustedStaging) throw cloudError('UNTRUSTED_CLOUD_SERVICE_ORIGIN');
    this.client = new CloudMobileAccountClient({ origin: this.origin, request: options.request, accessToken: () => this.accessToken() });
    if (options.reference) this.restoration = this.restore(options.reference);
  }

  register(input: { email: string; password: string; termsVersion: string; acceptTerms: true }) { return this.client.register(input); }
  verifyEmail(input: { capability: string }) { return this.client.verifyEmail(input); }

  async beginLogin(input: { providerId: 'email' | 'google' | 'github'; redirectUri: string; email?: string; password?: string; totpCode?: string; recoveryCode?: string }) {
    if (input.providerId === 'email' && !input.totpCode && !input.recoveryCode) this.pendingEmailSecondFactor = undefined;
    try {
      return await this.authorize(input);
    } catch (error) {
      if (input.providerId === 'email' && input.email && input.password && cloudErrorCode(error) === 'TOTP_REQUIRED') {
        this.pendingEmailSecondFactor = { createdAt: Date.now(), email: input.email, password: input.password, redirectUri: input.redirectUri };
      }
      throw error;
    }
  }

  hasPendingEmailSecondFactor() {
    return Boolean(this.currentEmailSecondFactor());
  }

  clearPendingEmailSecondFactor() {
    this.pendingEmailSecondFactor = undefined;
  }

  async continueEmailLogin(input: { totpCode?: string; recoveryCode?: string }): Promise<LoginResult> {
    const challenge = this.currentEmailSecondFactor();
    if (!challenge) throw cloudError('CLOUD_LOGIN_CHALLENGE_EXPIRED');
    try {
      const result = await this.authorize({
        providerId: 'email',
        redirectUri: challenge.redirectUri,
        email: challenge.email,
        password: challenge.password,
        ...input,
      });
      this.pendingEmailSecondFactor = undefined;
      return result as LoginResult;
    } catch (error) {
      if (!['TOTP_INVALID', 'RECOVERY_CODE_INVALID_OR_CONSUMED', 'TOTP_REQUIRED'].includes(cloudErrorCode(error))) this.pendingEmailSecondFactor = undefined;
      throw error;
    }
  }

  private async authorize(input: { providerId: 'email' | 'google' | 'github'; redirectUri: string; email?: string; password?: string; totpCode?: string; recoveryCode?: string }) {
    const state = randomUrlSafe(24); const verifier = randomUrlSafe(48);
    const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
    this.prunePending(); this.pending.set(state, { verifier, createdAt: Date.now() });
    return this.client.login({ ...input, clientId: 'mobile', kind: 'mobile', scopes: ['account:read', 'relay:access'], state, codeChallenge: challenge.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''), codeChallengeMethod: 'S256' });
  }

  async completeLogin(input: { code: string; state: string; redirectUri: string }) {
    const pending = this.pending.get(input.state); this.pending.delete(input.state);
    if (!pending || pending.createdAt + 5 * 60_000 <= Date.now()) throw cloudError('CLOUD_LOGIN_STATE_INVALID');
    const result = await this.client.exchangeAuthorizationCode({ ...input, clientId: 'mobile', kind: 'mobile', deviceName: 'Task Handoff Mobile', codeVerifier: pending.verifier });
    await this.install(result); return this.reference();
  }

  async restore(reference: { id: string; secureCredentialKey: string }) {
    const raw = await this.secureStore.get(reference.secureCredentialKey);
    if (!raw) throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
    const stored = JSON.parse(raw) as Omit<TokenSet, 'accessToken' | 'accessExpiresAt'>;
    this.tokenSet = { ...stored, accessToken: '', accessExpiresAt: new Date(0).toISOString() };
    return this.reference();
  }

  async accessToken() {
    await this.restoration;
    if (!this.tokenSet) throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
    if (this.tokenSet.accessToken && Date.parse(this.tokenSet.accessExpiresAt) > Date.now() + 30_000) return this.tokenSet.accessToken;
    if (!this.refreshing) this.refreshing = this.refreshAccessToken().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async logout() {
    const reference = this.reference();
    try { await this.client.logout(); } finally { await this.secureStore.remove(reference.secureCredentialKey); this.tokenSet = undefined; }
  }

  reference() {
    if (!this.tokenSet) throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
    return { id: this.tokenSet.deviceSessionId, secureCredentialKey: credentialKey(this.tokenSet.deviceSessionId) };
  }

  private async install(tokens: TokenSet) {
    if (!tokens.refreshCredential || !tokens.deviceSessionId || !tokens.accountId) throw cloudError('CLOUD_TOKEN_RESPONSE_INVALID');
    this.tokenSet = tokens;
    await this.secureStore.set(credentialKey(tokens.deviceSessionId), JSON.stringify({ refreshCredential: tokens.refreshCredential, deviceSessionId: tokens.deviceSessionId, accountId: tokens.accountId }));
  }

  private async refreshAccessToken() {
    const current = this.tokenSet;
    if (!current) throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
    try {
      const refreshed = await this.client.refresh({ refreshCredential: current.refreshCredential, deviceSessionId: current.deviceSessionId });
      await this.install({ ...current, ...refreshed });
      return this.tokenSet!.accessToken;
    } catch (error) {
      if ((error as any)?.status === 401 || String((error as any)?.code ?? '').includes('REPLAY')) {
        await this.secureStore.remove(credentialKey(current.deviceSessionId));
        this.tokenSet = undefined;
        throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
      }
      throw error;
    }
  }

  private prunePending() { for (const [state, entry] of this.pending) if (entry.createdAt + 5 * 60_000 <= Date.now()) this.pending.delete(state); }
  private currentEmailSecondFactor() {
    const challenge = this.pendingEmailSecondFactor;
    if (!challenge) return undefined;
    if (challenge.createdAt + 5 * 60_000 > Date.now()) return challenge;
    this.pendingEmailSecondFactor = undefined;
    return undefined;
  }
}

function credentialKey(deviceSessionId: string) { return `cloud.account.${deviceSessionId}`; }
function randomUrlSafe(bytes: number) { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function cloudError(code: string) { return Object.assign(new Error('Thandoff account session is unavailable.'), { code }); }
function cloudErrorCode(error: unknown) { return typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''; }
