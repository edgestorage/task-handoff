import { MobileCloudAccountSession } from '../src/control-plane/cloud-account';
import type { SecureValueStore } from '../src/platform/secure-storage';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
  digestStringAsync: async () => 'cGtjZS1jaGFsbGVuZ2U=',
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
  const authorization = JSON.parse(String(requests[0][1].body));
  expect(authorization).toMatchObject({ clientId: 'mobile', kind: 'mobile', redirectUri: 'taskhandoff://cloud-auth/callback', codeChallengeMethod: 'S256' });
  expect(authorization.state).toHaveLength(32);
  expect(authorization.codeChallenge).not.toContain('=');

  const reference = await session.completeLogin({ code: authorizationCode, state: authorization.state, redirectUri: 'taskhandoff://cloud-auth/callback' });
  expect(requests.map(([url]) => url)).toEqual([
    'https://cloud.thandoff.com/api/v1/auth/authorize',
    'https://cloud.thandoff.com/api/v1/auth/token',
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
  const storage = store({ [key]: JSON.stringify({ refreshCredential: 'refresh-old', deviceSessionId: 'device_a', accountId: 'account_a' }) });
  let refreshCalls = 0;
  const request = jest.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/refresh')) {
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

test('refresh replay or unauthorized rotation clears device credentials and requires reauthentication', async () => {
  const key = 'cloud.account.device_a';
  const storage = store({ [key]: JSON.stringify({ refreshCredential: 'replayed', deviceSessionId: 'device_a', accountId: 'account_a' }) });
  const request = jest.fn(async () => response({ error: { code: 'REFRESH_TOKEN_REPLAYED', message: 'revoked' } }, 401)) as unknown as typeof fetch;
  const session = new MobileCloudAccountSession(storage.value, { request, reference: { id: 'device_a', secureCredentialKey: key } });

  await expect(session.accessToken()).rejects.toMatchObject({ code: 'CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED' });
  expect(storage.values.has(key)).toBe(false);
});
