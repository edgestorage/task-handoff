import { MobileCloudAccountSession } from '../src/control-plane/cloud-account';
import { clearCloudAccountReauthenticationRequired, cloudAccountReauthenticationRequired } from '../src/control-plane/account-reauthentication';
import type { SecureValueStore } from '../src/platform/secure-storage';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    platform: { ios: { buildNumber: "16" } },
    expoConfig: {
      version: "0.0.12",
      extra: {
        cloudEnvironment: {
          id: 'test',
          serviceOrigin: 'https://cloud.example.test',
          coordinatorHostSuffixes: ['example.test'],
          relayHostSuffixes: ['example.test'],
          allowInsecureRelay: false,
        },
      },
    },
  },
}));

let mockRandomSourceCounter = 0;
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
  digestStringAsync: async () => 'A'.repeat(43) + '=',
  getRandomValues: (value: Uint8Array) => { value.fill(++mockRandomSourceCounter); return value; },
}));

function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const value: SecureValueStore = {
    available: async () => true,
    get: async (key) => values.get(key),
    set: async (key, item) => { values.set(key, item); },
    remove: async (key) => { values.delete(key); },
  };
  return { value, values };
}

function response(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } } as Response;
}

const authorizationCode = 'c'.repeat(48);
const accessToken = 'a'.repeat(48);
const refreshCredential = 'r'.repeat(48);
const expiresAt = '2026-08-10T00:05:00.000Z';
const refreshToken = (round: number) => `tf_test.${String(round).padStart(43, '0')}`;

test('cloud mobile login uses one-time PKCE state and stores only the refresh credential', async () => {
  const storage = store();
  const requests: Array<[string, RequestInit]> = [];
  const request = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push([String(url), init ?? {}]);
    if (String(url).endsWith('/authorize')) { const body = JSON.parse(String(init?.body)); return response({ data: { code: authorizationCode, state: body.state, redirectUri: body.redirectUri, expiresAt } }); }
    return response({ data: { tokenType: 'Bearer', accessToken, accessExpiresAt: new Date(Date.now() + 300_000).toISOString(), refreshCredential, deviceSessionId: 'device_a', accountId: 'account_a' } });
  }) as unknown as typeof fetch;
  const session = new MobileCloudAccountSession(storage.value, { request });

  await session.beginLogin({ providerId: 'email', redirectUri: 'taskhandoff://cloud-auth/callback', email: 'user@example.test', password: 'correct password' });
  expect(requests[0][1].headers).toMatchObject({ 'x-task-handoff-client-version': '0.0.12', 'x-task-handoff-client-build': '16' });
  const authorization = JSON.parse(String(requests[0][1].body));
  expect(authorization).toMatchObject({ clientId: 'mobile', kind: 'mobile', redirectUri: 'taskhandoff://cloud-auth/callback', codeChallengeMethod: 'S256' });
  expect(authorization.state).toHaveLength(32);
  expect(authorization.codeChallenge).not.toContain('=');

  const reference = await session.completeLogin({ code: authorizationCode, state: authorization.state, redirectUri: 'taskhandoff://cloud-auth/callback' });
  expect(requests.map(([url]) => url)).toEqual([
    'https://cloud.example.test/api/v1/auth/authorize',
    'https://cloud.example.test/api/v1/auth/token',
  ]);
  await expect(session.completeLogin({ code: authorizationCode, state: authorization.state, redirectUri: 'taskhandoff://cloud-auth/callback' })).rejects.toMatchObject({ code: 'CLOUD_LOGIN_STATE_INVALID' });
  const persisted = storage.values.get(reference.secureCredentialKey)!;
  expect(persisted).toContain(refreshCredential);
  expect(persisted).not.toContain(accessToken);
  expect(persisted).not.toContain('correct password');
});

test('TOTP login continuation keeps password only in memory and retries through a fresh PKCE authorization', async () => {
  const storage = store();
  const bodies: any[] = [];
  const request = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (!body.totpCode) return response({ error: { code: 'TOTP_REQUIRED', message: 'second factor required' } }, 401);
    return response({ data: { code: authorizationCode, state: body.state, redirectUri: body.redirectUri, expiresAt } });
  }) as unknown as typeof fetch;
  const session = new MobileCloudAccountSession(storage.value, { request });

  await expect(session.beginLogin({ providerId: 'email', redirectUri: 'taskhandoff://cloud-auth/callback', email: 'user@example.test', password: 'correct password' })).rejects.toMatchObject({ code: 'TOTP_REQUIRED' });
  expect(session.hasPendingEmailSecondFactor()).toBe(true);

  await expect(session.continueEmailLogin({ totpCode: '123456' })).resolves.toMatchObject({ code: authorizationCode });
  expect(bodies[1]).toMatchObject({ email: 'user@example.test', password: 'correct password', totpCode: '123456' });
  expect(bodies[1].state).not.toBe(bodies[0].state);
  expect(session.hasPendingEmailSecondFactor()).toBe(false);
  expect([...storage.values.values()].join('')).not.toContain('correct password');
});

test('restored account refresh is single-flight and explicit logout removes the secure credential', async () => {
  const key = 'cloud.account.device_a';
  const storage = store({ [key]: JSON.stringify({ refreshCredential: refreshToken(0), deviceSessionId: 'device_a', accountId: 'account_a' }) });
  let refreshCalls = 0;
  const request = jest.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/refresh-recovery') || String(url).endsWith('/refresh')) {
      refreshCalls += 1;
      await Promise.resolve();
      return response({ data: { tokenType: 'Bearer', accessToken, accessExpiresAt: new Date(Date.now() + 300_000).toISOString(), refreshCredential, deviceSessionId: 'device_a', accountId: 'account_a' } });
    }
    return response({ data: { revoked: true } });
  }) as unknown as typeof fetch;
  const session = new MobileCloudAccountSession(storage.value, { request, reference: { id: 'device_a', secureCredentialKey: key } });

  await expect(Promise.all([session.accessToken(), session.accessToken(), session.accessToken()])).resolves.toEqual([accessToken, accessToken, accessToken]);
  expect(refreshCalls).toBe(1);
  expect(storage.values.get(key)).toContain(refreshCredential);
  await session.logout();
  expect(storage.values.has(key)).toBe(false);
});

test('a session refreshing after another session rotated presents the persisted credential', async () => {
  const key = 'cloud.account.device_a';
  const credential = refreshToken;
  const storage = store({ [key]: JSON.stringify({ refreshCredential: credential(1), deviceSessionId: 'device_a', accountId: 'account_a' }) });
  const presented: string[] = [];
  let currentCredential = credential(1);
  const request = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith('/refresh-recovery') && !String(url).endsWith('/refresh')) return response({ data: {} });
    const body = JSON.parse(String(init?.body)) as { refreshCredential: string };
    presented.push(body.refreshCredential);
    if (body.refreshCredential !== currentCredential) return response({ error: { code: 'REFRESH_REPLAYED', message: 'Refresh credential replay revoked this device session.' } }, 401);
    currentCredential = credential(presented.length + 1);
    return response({ data: { tokenType: 'Bearer', accessToken, accessExpiresAt: new Date(Date.now() + 300_000).toISOString(), refreshCredential: currentCredential, deviceSessionId: 'device_a', accountId: 'account_a' } });
  }) as unknown as typeof fetch;
  const options = { request, reference: { id: 'device_a', secureCredentialKey: key } };
  const first = new MobileCloudAccountSession(storage.value, options);
  const second = new MobileCloudAccountSession(storage.value, options);

  await first.accessToken();
  await expect(second.accessToken()).resolves.toBe(accessToken);
  expect(presented).toEqual([credential(1), credential(2)]);
  expect(storage.values.get(key)).toContain(credential(3));
});

test('a delayed credential read cannot replay a rotation owned by another session', async () => {
  const key = 'cloud.account.device_a';
  const credential = refreshToken;
  const storage = store({ [key]: JSON.stringify({ refreshCredential: credential(1), deviceSessionId: 'device_a', accountId: 'account_a' }) });
  const presented: string[] = [];
  let currentCredential = credential(1);
  const request = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith('/refresh-recovery') && !String(url).endsWith('/refresh')) return response({ data: {} });
    const body = JSON.parse(String(init?.body)) as { refreshCredential: string };
    presented.push(body.refreshCredential);
    if (body.refreshCredential !== currentCredential) return response({ error: { code: 'REFRESH_REPLAYED', message: 'Refresh credential replay revoked this device session.' } }, 401);
    currentCredential = credential(presented.length + 1);
    return response({ data: { tokenType: 'Bearer', accessToken, accessExpiresAt: new Date(Date.now() + 300_000).toISOString(), refreshCredential: currentCredential, deviceSessionId: 'device_a', accountId: 'account_a' } });
  }) as unknown as typeof fetch;
  const options = { request };
  const first = new MobileCloudAccountSession(storage.value, options);
  const second = new MobileCloudAccountSession(storage.value, options);
  const reference = { id: 'device_a', secureCredentialKey: key };
  await first.restore(reference);
  await second.restore(reference);

  let delayNextRead = true;
  let releaseDelayedRead: (() => void) | undefined;
  let delayedReadStarted: (() => void) | undefined;
  const delayedRead = new Promise<void>((resolve) => { delayedReadStarted = resolve; });
  storage.value.get = async (name) => {
    const snapshot = storage.values.get(name);
    if (!delayNextRead) return snapshot;
    delayNextRead = false;
    delayedReadStarted?.();
    await new Promise<void>((resolve) => { releaseDelayedRead = resolve; });
    return snapshot;
  };

  const secondRefresh = second.accessToken();
  await delayedRead;
  const firstRefresh = first.accessToken();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseDelayedRead?.();

  await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([accessToken, accessToken]);
  expect(presented).toEqual([credential(1)]);
  expect(storage.values.get(key)).toContain(credential(2));
});

test('a transient shared refresh failure stays retryable instead of requiring reauthentication', async () => {
  clearCloudAccountReauthenticationRequired();
  const key = 'cloud.account.device_a';
  const storage = store({ [key]: JSON.stringify({ refreshCredential: refreshToken(0), deviceSessionId: 'device_a', accountId: 'account_a' }) });
  let failRequest: ((error: Error) => void) | undefined;
  const request = jest.fn(() => new Promise<Response>((_resolve, reject) => { failRequest = reject; })) as unknown as typeof fetch;
  const reference = { id: 'device_a', secureCredentialKey: key };
  const first = new MobileCloudAccountSession(storage.value, { request, reference });
  const second = new MobileCloudAccountSession(storage.value, { request, reference });
  await Promise.all([first.restore(reference), second.restore(reference)]);

  const refreshes = [first.accessToken(), second.accessToken()];
  await new Promise<void>((resolve) => setImmediate(resolve));
  failRequest?.(new Error('network unavailable'));
  const results = await Promise.allSettled(refreshes);

  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(storage.values.has(key)).toBe(true);
  expect(cloudAccountReauthenticationRequired()).toBe(false);
});

test('a committed rotation whose response is lost recovers after an app restart', async () => {
  const key = 'cloud.account.device_a';
  const storage = store({ [key]: JSON.stringify({ refreshCredential: refreshToken(0), deviceSessionId: 'device_a', accountId: 'account_a' }) });
  let serverCurrent = refreshToken(0);
  let committed: { previous: string; next: string; rotationId: string } | undefined;
  let replayRevoked = false;
  let persistedBeforeRequest: any;
  const request = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toContain('/refresh-recovery');
    const body = JSON.parse(String(init?.body)) as { refreshCredential: string; nextRefreshCredential: string; rotationId: string };
    persistedBeforeRequest = JSON.parse(storage.values.get(key)!);
    if (committed && body.refreshCredential === committed.previous && body.nextRefreshCredential === committed.next && body.rotationId === committed.rotationId) {
      return response({ data: { tokenType: 'Bearer', accessToken, accessExpiresAt: new Date(Date.now() + 300_000).toISOString(), refreshCredential: body.nextRefreshCredential, deviceSessionId: 'device_a', accountId: 'account_a' } });
    }
    if (body.refreshCredential !== serverCurrent) {
      replayRevoked = true;
      return response({ error: { code: 'REFRESH_REPLAYED', message: 'revoked' } }, 401);
    }
    committed = { previous: body.refreshCredential, next: body.nextRefreshCredential, rotationId: body.rotationId };
    serverCurrent = body.nextRefreshCredential;
    throw new Error('response lost while app was suspended');
  }) as unknown as typeof fetch;
  const reference = { id: 'device_a', secureCredentialKey: key };

  const first = new MobileCloudAccountSession(storage.value, { request, reference });
  await expect(first.accessToken()).rejects.toThrow('response lost while app was suspended');
  expect(persistedBeforeRequest.pendingRefresh).toMatchObject({
    previousRefreshCredential: refreshToken(0),
    nextRefreshCredential: committed!.next,
    rotationId: committed!.rotationId,
  });

  const resumed = new MobileCloudAccountSession(storage.value, { request, reference });
  await expect(resumed.accessToken()).resolves.toBe(accessToken);
  expect(replayRevoked).toBe(false);
  const persisted = JSON.parse(storage.values.get(key)!);
  expect(persisted.refreshCredential).toBe(committed!.next);
  expect(persisted).not.toHaveProperty('pendingRefresh');
});

test('a client safely falls back when the Coordinator predates refresh recovery', async () => {
  const key = 'cloud.account.device_a';
  const storage = store({ [key]: JSON.stringify({ refreshCredential: refreshToken(0), deviceSessionId: 'device_a', accountId: 'account_a' }) });
  const urls: string[] = [];
  const request = jest.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith('/refresh-recovery')) return response({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    return response({ data: { tokenType: 'Bearer', accessToken, accessExpiresAt: new Date(Date.now() + 300_000).toISOString(), refreshCredential: refreshToken(1), deviceSessionId: 'device_a', accountId: 'account_a' } });
  }) as unknown as typeof fetch;
  const session = new MobileCloudAccountSession(storage.value, { request, reference: { id: 'device_a', secureCredentialKey: key } });

  await expect(session.accessToken()).resolves.toBe(accessToken);
  expect(urls).toEqual([
    'https://cloud.example.test/api/v1/auth/refresh-recovery',
    'https://cloud.example.test/api/v1/auth/refresh',
  ]);
  expect(JSON.parse(storage.values.get(key)!)).not.toHaveProperty('pendingRefresh');
});

test('refresh replay or unauthorized rotation clears device credentials and requires reauthentication', async () => {
  clearCloudAccountReauthenticationRequired();
  const key = 'cloud.account.device_a';
  const storage = store({ [key]: JSON.stringify({ refreshCredential: refreshToken(0), deviceSessionId: 'device_a', accountId: 'account_a' }) });
  const request = jest.fn(async () => response({ error: { code: 'REFRESH_TOKEN_REPLAYED', message: 'revoked' } }, 401)) as unknown as typeof fetch;
  const session = new MobileCloudAccountSession(storage.value, { request, reference: { id: 'device_a', secureCredentialKey: key } });

  await expect(session.accessToken()).rejects.toMatchObject({ code: 'CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED' });
  expect(storage.values.has(key)).toBe(false);
  expect(cloudAccountReauthenticationRequired()).toBe(true);
});

test('native Apple exchanges a nonce-bound assertion using the original PKCE state and persists only refresh credentials', async () => {
  const storage = store();
  const session = new MobileCloudAccountSession(storage.value);
  let request: any;
  jest.spyOn(session.client, 'beginAppleNative').mockImplementation(async (input) => {
    request = input;
    return { state: 'apple-server-state', nonce: 'server-nonce', expiresAt: new Date(Date.now() + 300_000).toISOString() };
  });
  const assertion = jest.spyOn(session.client, 'completeAppleNative').mockImplementation(async () => ({ code: authorizationCode, state: request.state, redirectUri: request.redirectUri, expiresAt }));
  const exchange = jest.spyOn(session.client, 'exchangeAuthorizationCode').mockResolvedValue({ tokenType: 'Bearer', accessToken, accessExpiresAt: expiresAt, refreshCredential, deviceSessionId: 'native_device', accountId: 'account_a' });
  const signIn = jest.fn(async () => ({ state: 'apple-server-state', identityToken: 'apple-signed-token' }));
  await expect(session.loginWithApple({ bundleId: 'com.taskhandoff.mobile', signIn }, 'taskhandoff://official-auth/callback')).resolves.toBe('completed');
  expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ state: 'apple-server-state', nonce: 'server-nonce' }));
  expect(assertion).toHaveBeenCalledWith({ state: 'apple-server-state', identityToken: 'apple-signed-token' });
  expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ state: request.state, codeVerifier: expect.any(String) }));
  const saved = [...storage.values.values()].join('');
  expect(saved).toContain(refreshCredential);
  expect(saved).not.toContain('apple-signed-token');
  expect(saved).not.toContain('server-nonce');
  expect(saved).not.toContain(accessToken);
});

test('native Apple cancellation and state mismatch cannot issue a device session', async () => {
  const session = new MobileCloudAccountSession(store().value);
  jest.spyOn(session.client, 'beginAppleNative').mockResolvedValue({ state: 'server-state', nonce: 'nonce', expiresAt });
  const complete = jest.spyOn(session.client, 'completeAppleNative');
  const exchange = jest.spyOn(session.client, 'exchangeAuthorizationCode');
  await expect(session.loginWithApple({ bundleId: 'app', signIn: async () => undefined }, 'taskhandoff://official-auth/callback')).resolves.toBe('cancelled');
  await expect(session.loginWithApple({ bundleId: 'app', signIn: async () => ({ state: 'wrong', identityToken: 'token' }) }, 'taskhandoff://official-auth/callback')).rejects.toMatchObject({ code: 'CLOUD_LOGIN_STATE_INVALID' });
  expect(complete).not.toHaveBeenCalled();
  expect(exchange).not.toHaveBeenCalled();
});

test('cloud v0.1.13 missing native route can use web login, while verification failures stay visible', async () => {
  const session = new MobileCloudAccountSession(store().value);
  const begin = jest.spyOn(session.client, 'beginAppleNative');
  const signIn = jest.fn();
  begin.mockRejectedValueOnce(Object.assign(new Error('missing route'), { status: 404 }));
  await expect(session.loginWithApple({ bundleId: 'app', signIn }, 'taskhandoff://official-auth/callback')).resolves.toBe('unavailable');
  expect(signIn).not.toHaveBeenCalled();
  begin.mockRejectedValueOnce(Object.assign(new Error('temporarily unavailable'), { status: 503 }));
  await expect(session.loginWithApple({ bundleId: 'app', signIn }, 'taskhandoff://official-auth/callback')).rejects.toMatchObject({ status: 503 });
});

test('native account confirmation keeps the original PKCE grant in memory until explicit acceptance or cancellation', async () => {
  const storage = store();
  const session = new MobileCloudAccountSession(storage.value);
  let request: any;
  const confirmExpiry = new Date(Date.now() + 600_000).toISOString();
  jest.spyOn(session.client, 'beginAppleNative').mockImplementation(async (input) => { request = input; return { state: 'native-state', nonce: 'nonce', expiresAt }; });
  jest.spyOn(session.client, 'completeAppleNative').mockResolvedValue({ confirmationRequired: true, flow: 'flow-secret', termsVersion: '2026-08', expiresAt: confirmExpiry });
  const confirm = jest.spyOn(session.client, 'confirmProviderAccount').mockImplementation(async () => ({ code: authorizationCode, state: request.state, redirectUri: request.redirectUri, expiresAt }));
  jest.spyOn(session.client, 'exchangeAuthorizationCode').mockResolvedValue({ tokenType: 'Bearer', accessToken, accessExpiresAt: expiresAt, refreshCredential, deviceSessionId: 'native_device', accountId: 'account_a' });
  const native = { bundleId: 'app', signIn: async () => ({ state: 'native-state', identityToken: 'apple-token' }) };
  await expect(session.loginWithApple(native, 'taskhandoff://official-auth/callback')).resolves.toBe('confirmation-required');
  expect(confirm).not.toHaveBeenCalled();
  expect(storage.values.size).toBe(0);
  await session.confirmProviderAccount();
  expect(confirm).toHaveBeenCalledWith({ flow: 'flow-secret', termsVersion: '2026-08', acceptTerms: true });
  expect([...storage.values.values()].join('')).not.toContain('flow-secret');
  await session.loginWithApple(native, 'taskhandoff://official-auth/callback');
  session.cancelProviderConfirmation();
  await expect(session.confirmProviderAccount()).rejects.toMatchObject({ code: 'CLOUD_LOGIN_CHALLENGE_EXPIRED' });
});
