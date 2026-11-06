import { MOBILE_REFRESH_RECOVERY_PROTOCOL_VERSION, OfficialMobileAccountClient as CloudMobileAccountClient, type MobileTokenResponse } from '@task-handoff/cloud-contracts/mobile';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import type { SecureValueStore } from '../platform/secure-storage';
import { isMobileTestMode, isTrustedMobileCloudServiceOrigin, mobileCloudEnvironment } from '../platform/build-variant';
import { markCloudAccountReauthenticationRequired } from './account-reauthentication';
import type { CloudEndpointResolver } from '../cloud-discovery/resolver';
import type { NativeAppleAuthentication } from '../platform/apple-authentication';

type PendingRefresh = Readonly<{ previousRefreshCredential: string; nextRefreshCredential: string; rotationId: string }>;
type TokenSet = Omit<MobileTokenResponse, 'tokenType'> & { pendingRefresh?: PendingRefresh };
type PendingEmailSecondFactor = { createdAt: number; email: string; password: string; redirectUri: string };
type LoginResult = { authorizationUrl?: string; code?: string; state?: string };

// Refresh credentials rotate on every use and replaying a rotated credential revokes the
// whole device session. Several components can hold a cloud account session for the same
// secure store (the account session plus relay transports), so concurrent refreshes must
// share one rotation instead of racing each other.
const refreshFlights = new WeakMap<SecureValueStore, Map<string, Promise<TokenSet>>>();

export class MobileCloudAccountSession {
  private tokenSet?: TokenSet;
  private refreshing?: Promise<string>;
  private readonly pending = new Map<string, { verifier: string; expiresAt: number }>();
  private pendingEmailSecondFactor?: PendingEmailSecondFactor;
  private pendingProviderConfirmation?: { flow: string; termsVersion: string; state: string; redirectUri: string; expiresAt: string };
  private readonly baseOrigin: string;
  private readonly endpointResolver?: CloudEndpointResolver;
  readonly client: CloudMobileAccountClient;
  private restoration?: Promise<unknown>;

  constructor(private readonly secureStore: SecureValueStore, options: { origin?: string; request?: typeof fetch; allowNonProductionOrigin?: boolean; endpointResolver?: CloudEndpointResolver; reference?: { id: string; secureCredentialKey: string } } = {}) {
    this.baseOrigin = new URL(options.origin ?? mobileCloudEnvironment.serviceOrigin).origin;
    this.endpointResolver = options.endpointResolver;
    const trustedDevelopment = isMobileTestMode && options.allowNonProductionOrigin === true;
    const trustedEnvironment = isTrustedMobileCloudServiceOrigin(this.baseOrigin);
    const trustedDiscovery = options.endpointResolver?.isTrustedOrigin(this.baseOrigin) ?? false;
    if (this.baseOrigin !== mobileCloudEnvironment.serviceOrigin && !trustedDevelopment && !trustedEnvironment && !trustedDiscovery) throw cloudError('UNTRUSTED_CLOUD_SERVICE_ORIGIN');
    this.client = new CloudMobileAccountClient({
      origin: this.baseOrigin,
      clientVersion: Constants.expoConfig?.version,
      clientBuild: Constants.platform?.ios?.buildNumber
        ?? (Constants.platform?.android?.versionCode !== undefined ? String(Constants.platform.android.versionCode) : undefined)
        ?? Constants.expoConfig?.ios?.buildNumber
        ?? (Constants.expoConfig?.android?.versionCode !== undefined ? String(Constants.expoConfig.android.versionCode) : undefined),
      request: options.request ?? (options.endpointResolver?.enabled ? options.endpointResolver.request : undefined),
      accessToken: () => this.accessToken(),
    });
    if (options.reference) this.restoration = this.restore(options.reference);
  }

  get origin() {
    return this.endpointResolver?.enabled ? this.endpointResolver.activeOrigin : this.baseOrigin;
  }

  register(input: { email: string; password: string; termsVersion: string; acceptTerms: true }) { return this.client.register(input); }
  verifyEmail(input: { email: string; code: string } | { capability: string }) { return this.client.verifyEmail(input); }

  async beginLogin(input: { providerId: string; redirectUri: string; email?: string; password?: string; totpCode?: string; recoveryCode?: string }) {
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

  private async authorize(input: { providerId: string; redirectUri: string; email?: string; password?: string; totpCode?: string; recoveryCode?: string }) {
    return this.client.login({ ...input, ...await this.authorizationRequest(input.redirectUri), kind: 'mobile' });
  }

  private async authorizationRequest(redirectUri: string) {
    const state = randomUrlSafe(24); const verifier = randomUrlSafe(48);
    const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
    this.prunePending(); this.pending.set(state, { verifier, expiresAt: Date.now() + 5 * 60_000 });
    return { redirectUri, clientId: 'mobile' as const, scopes: ['account:read', 'relay:access'], state, codeChallenge: challenge.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''), codeChallengeMethod: 'S256' as const };
  }

  async loginWithApple(native: NativeAppleAuthentication, redirectUri: string): Promise<'unavailable' | 'cancelled' | 'completed' | 'confirmation-required'> {
    this.cancelProviderConfirmation();
    const request = await this.authorizationRequest(redirectUri);
    try {
      let challenge;
      try {
        challenge = await this.client.beginAppleNative({ ...request, bundleId: native.bundleId });
      } catch (error) {
        // Compatibility for cloud v0.1.13: only an absent route or an explicitly
        // unconfigured native audience can use the existing web authorization.
        if (Number((error as { status?: number })?.status) === 404 || cloudErrorCode(error) === 'APPLE_NATIVE_CLIENT_UNAVAILABLE') return 'unavailable';
        throw error;
      }
      const credential = await native.signIn(challenge);
      if (!credential) return 'cancelled';
      if (credential.state !== challenge.state || !credential.identityToken) throw cloudError('CLOUD_LOGIN_STATE_INVALID');
      const result = await this.client.completeAppleNative({ state: challenge.state, identityToken: credential.identityToken });
      if ('confirmationRequired' in result) {
        const pending = this.pending.get(request.state)!;
        pending.expiresAt = Date.parse(result.expiresAt);
        this.pendingProviderConfirmation = { ...result, state: request.state, redirectUri };
        return 'confirmation-required';
      }
      if (result.state !== request.state || result.redirectUri !== redirectUri) throw cloudError('CLOUD_LOGIN_STATE_INVALID');
      await this.completeLogin({ code: result.code, state: result.state, redirectUri });
      return 'completed';
    } finally {
      if (this.pendingProviderConfirmation?.state !== request.state) this.pending.delete(request.state);
    }
  }

  async confirmProviderAccount() {
    const pending = this.pendingProviderConfirmation;
    if (!pending || Date.parse(pending.expiresAt) <= Date.now()) {
      this.cancelProviderConfirmation();
      throw cloudError('CLOUD_LOGIN_CHALLENGE_EXPIRED');
    }
    const result = await this.client.confirmProviderAccount({ flow: pending.flow, termsVersion: pending.termsVersion, acceptTerms: true });
    if ('confirmationRequired' in result || result.state !== pending.state || result.redirectUri !== pending.redirectUri) throw cloudError('CLOUD_LOGIN_STATE_INVALID');
    this.pendingProviderConfirmation = undefined;
    return this.completeLogin({ code: result.code, state: result.state, redirectUri: pending.redirectUri });
  }

  cancelProviderConfirmation() {
    if (this.pendingProviderConfirmation) this.pending.delete(this.pendingProviderConfirmation.state);
    this.pendingProviderConfirmation = undefined;
  }

  async completeLogin(input: { code: string; state: string; redirectUri: string }) {
    const pending = this.pending.get(input.state); this.pending.delete(input.state);
    if (!pending || pending.expiresAt <= Date.now()) throw cloudError('CLOUD_LOGIN_STATE_INVALID');
    const result = await this.client.exchangeAuthorizationCode({ ...input, clientId: 'mobile', kind: 'mobile', deviceName: 'TaskHandoff Mobile', codeVerifier: pending.verifier });
    await this.install(result); return this.reference();
  }

  async restore(reference: { id: string; secureCredentialKey: string }) {
    const raw = await this.secureStore.get(reference.secureCredentialKey);
    if (!raw) throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
    const stored = parseStoredCredential(raw);
    if (!stored || stored.deviceSessionId !== reference.id) throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
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
    await this.secureStore.set(credentialKey(tokens.deviceSessionId), JSON.stringify({
      refreshCredential: tokens.refreshCredential,
      deviceSessionId: tokens.deviceSessionId,
      accountId: tokens.accountId,
      ...(validPendingRefresh(tokens.pendingRefresh) ? { pendingRefresh: tokens.pendingRefresh } : {}),
    }));
  }

  private async refreshAccessToken() {
    const cached = this.tokenSet;
    if (!cached) throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
    // Sessions for one device session each cache their own token set (the account session plus
    // one per relay transport), but rotation is global: only the persisted credential is still
    // current. Refresh from whatever the last rotation wrote to the store, because presenting a
    // previously rotated credential revokes the whole device session.
    const flights = refreshFlights.get(this.secureStore) ?? new Map<string, Promise<TokenSet>>();
    refreshFlights.set(this.secureStore, flights);
    const inFlight = flights.get(cached.deviceSessionId);
    if (inFlight) {
      const rotated = await inFlight;
      await this.install({ ...cached, ...rotated, pendingRefresh: undefined });
      return this.tokenSet!.accessToken;
    }
    // Register the shared flight before the first asynchronous read. A session that starts with
    // an older cached token must join this flight even if its Keychain read returns after another
    // rotation has completed; otherwise it can present the stale credential as a replay.
    const flight = this.rotateFreshest(cached);
    flights.set(cached.deviceSessionId, flight);
    try {
      await flight;
      return this.tokenSet!.accessToken;
    } catch (error) {
      const status = Number((error as any)?.status);
      const code = String((error as any)?.code ?? '');
      if (status === 401 || status === 403 || /REPLAY|REFRESH_INVALID|DEVICE_SESSION_REVOKED|SESSION_REVOKED/.test(code)) {
        await this.secureStore.remove(credentialKey(cached.deviceSessionId));
        this.tokenSet = undefined;
        markCloudAccountReauthenticationRequired();
        throw cloudError('CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED');
      }
      throw error;
    } finally { flights.delete(cached.deviceSessionId); }
  }

  private async rotateFreshest(cached: TokenSet) {
    const current = await this.freshestCredential(cached);
    return current.pendingRefresh ? this.completePendingRefresh(current) : this.rotate(current);
  }

  private async rotate(current: TokenSet) {
    const pendingRefresh: PendingRefresh = {
      previousRefreshCredential: current.refreshCredential,
      nextRefreshCredential: nextRefreshCredential(current.refreshCredential),
      rotationId: randomUrlSafe(32),
    };
    return this.completeRotation(current, pendingRefresh);
  }

  private completePendingRefresh(current: TokenSet) {
    return this.completeRotation(current, current.pendingRefresh!);
  }

  private async completeRotation(current: TokenSet, pendingRefresh: PendingRefresh) {
    // Persist the intent before the request. If iOS suspends the app after the Coordinator
    // commits but before the response reaches Keychain, the next launch retries this exact
    // rotation instead of presenting the already-rotated credential as a replay.
    await this.install({ ...current, pendingRefresh });
    let refreshed: TokenSet;
    try {
      refreshed = await this.client.refreshWithRecovery({
        protocolVersion: MOBILE_REFRESH_RECOVERY_PROTOCOL_VERSION,
        refreshCredential: pendingRefresh.previousRefreshCredential,
        nextRefreshCredential: pendingRefresh.nextRefreshCredential,
        rotationId: pendingRefresh.rotationId,
        deviceSessionId: current.deviceSessionId,
      }) as TokenSet;
    } catch (error) {
      // A Coordinator from before this protocol has no recovery route. The 404 happens before
      // any mutation, so falling back to the legacy endpoint is safe during a rolling upgrade.
      if (Number((error as any)?.status) !== 404) throw error;
      refreshed = await this.client.refresh({
        refreshCredential: pendingRefresh.previousRefreshCredential,
        deviceSessionId: current.deviceSessionId,
      }) as TokenSet;
    }
    const completed: TokenSet = { ...current, ...refreshed, pendingRefresh: undefined };
    await this.install(completed);
    return completed;
  }

  private async freshestCredential(cached: TokenSet) {
    const raw = await this.secureStore.get(credentialKey(cached.deviceSessionId));
    if (!raw) return cached;
    const stored = parseStoredCredential(raw);
    if (!stored || stored.deviceSessionId !== cached.deviceSessionId) return cached;
    return { ...cached, refreshCredential: stored.refreshCredential, pendingRefresh: stored.pendingRefresh };
  }

  private prunePending() { for (const [state, entry] of this.pending) if (entry.expiresAt <= Date.now()) this.pending.delete(state); }
  private currentEmailSecondFactor() {
    const challenge = this.pendingEmailSecondFactor;
    if (!challenge) return undefined;
    if (challenge.createdAt + 5 * 60_000 > Date.now()) return challenge;
    this.pendingEmailSecondFactor = undefined;
    return undefined;
  }
}

function credentialKey(deviceSessionId: string) { return `cloud.account.${deviceSessionId}`; }
function nextRefreshCredential(current: string) {
  const separator = current.indexOf('.');
  if (separator <= 0 || separator === current.length - 1) throw cloudError('CLOUD_TOKEN_RESPONSE_INVALID');
  return `${current.slice(0, separator)}.${randomUrlSafe(32)}`;
}
function validPendingRefresh(value: unknown): value is PendingRefresh {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingRefresh>;
  return typeof pending.previousRefreshCredential === 'string' && Boolean(pending.previousRefreshCredential)
    && typeof pending.nextRefreshCredential === 'string' && Boolean(pending.nextRefreshCredential)
    && typeof pending.rotationId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(pending.rotationId);
}
function parseStoredCredential(raw: string): Omit<TokenSet, 'accessToken' | 'accessExpiresAt'> | undefined {
  try {
    const value = JSON.parse(raw) as { refreshCredential?: unknown; deviceSessionId?: unknown; accountId?: unknown; pendingRefresh?: unknown };
    if (typeof value.refreshCredential !== 'string' || !value.refreshCredential
      || typeof value.deviceSessionId !== 'string' || !value.deviceSessionId
      || typeof value.accountId !== 'string' || !value.accountId) return undefined;
    return {
      refreshCredential: value.refreshCredential,
      deviceSessionId: value.deviceSessionId,
      accountId: value.accountId,
      ...(validPendingRefresh(value.pendingRefresh) ? { pendingRefresh: value.pendingRefresh } : {}),
    };
  } catch {
    return undefined;
  }
}
function randomUrlSafe(bytes: number) { const value = Crypto.getRandomValues(new Uint8Array(bytes)); return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function cloudError(code: string) { return Object.assign(new Error('Thandoff account session is unavailable.'), { code }); }
function cloudErrorCode(error: unknown) { return typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''; }
