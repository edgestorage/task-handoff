const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();
const mockSecureValues = new Map<string, string>();
const mockSetStringAsync = jest.fn(async (_value: string) => undefined);
const mockConstants = { expoConfig: { extra: { variant: 'production' as string | undefined } } };

jest.mock('expo-constants', () => ({ __esModule: true, default: mockConstants }));
jest.mock('expo-clipboard', () => ({ setStringAsync: (value: string) => mockSetStringAsync(value) }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureValues.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecureValues.set(key, value); }),
}));
jest.mock('expo-file-system', () => {
  function uriOf(parts: unknown[]) {
    return parts.map((part) => typeof part === 'string' ? part : (part as { uri: string }).uri).join('/');
  }

  class Directory {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = uriOf(parts); }
    get exists() { return mockDirectories.has(this.uri); }
    create() { mockDirectories.add(this.uri); }
  }

  class File {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = uriOf(parts); }
    get exists() { return mockFiles.has(this.uri); }
    get size() { return new TextEncoder().encode(mockFiles.get(this.uri) ?? '').length; }
    create() {
      mockDirectories.add(this.uri.slice(0, this.uri.lastIndexOf('/')));
      if (!mockFiles.has(this.uri)) mockFiles.set(this.uri, '');
    }
    write(content: string, options?: { append?: boolean }) {
      mockFiles.set(this.uri, options?.append ? `${mockFiles.get(this.uri) ?? ''}${content}` : content);
    }
    async text() {
      const value = mockFiles.get(this.uri);
      if (value === undefined) throw new Error('Missing file');
      return value;
    }
    delete() { mockFiles.delete(this.uri); }
    moveSync(destination: File) {
      const value = mockFiles.get(this.uri);
      if (value === undefined) throw new Error('Missing file');
      mockFiles.delete(this.uri);
      mockFiles.set(destination.uri, value);
      this.uri = destination.uri;
    }
  }

  return { Directory, File, Paths: { document: { uri: 'file:///documents' } } };
});

type DiagnosticLogsModule = typeof import('../src/observability/diagnostic-logs');

function loadLogs(): DiagnosticLogsModule {
  let loaded: DiagnosticLogsModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('../src/observability/diagnostic-logs') as DiagnosticLogsModule;
  });
  return loaded!;
}

function logText() {
  return [...mockFiles.entries()].filter(([uri]) => uri.endsWith('.log')).map(([, value]) => value).join('');
}

beforeEach(() => {
  mockFiles.clear();
  mockDirectories.clear();
  mockSecureValues.clear();
  mockSetStringAsync.mockClear();
  mockConstants.expoConfig.extra.variant = 'production';
});

test('enables diagnostics by default in staging builds and disables them in production', () => {
  mockConstants.expoConfig.extra.variant = 'staging';
  expect(loadLogs().getDiagnosticLogsEnabled()).toBe(true);

  mockConstants.expoConfig.extra.variant = 'production';
  expect(loadLogs().getDiagnosticLogsEnabled()).toBe(false);
});

test('does not create a log file while diagnostics are disabled', async () => {
  const logs = loadLogs();
  await logs.initializeDiagnosticLogs();
  logs.writeDiagnosticLog('info', 'relay.test', { attemptId: 'attempt_a' });
  expect(mockFiles.size).toBe(0);
});

test('persists the switch and writes redacted JSON lines', async () => {
  const logs = loadLogs();
  logs.setDiagnosticLogsEnabled(true);
  expect(JSON.parse(mockSecureValues.get('task-handoff.mobile.diagnostic-logs')!)).toEqual({ version: 1, enabled: true });
  await logs.clearDiagnosticLogs();
  logs.writeDiagnosticLog('warn', 'relay.attach.failed', {
    attemptId: 'attempt_a',
    durationMs: 42,
    relayId: 'relay_a',
    token: 'bearer-secret',
    credential: 'credential-secret',
    nested: { grant: 'grant-secret', proof: 'proof-secret', status: 502 },
  });

  const lines = logText().trim().split('\n');
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0]);
  expect(entry).toMatchObject({ level: 'warn', event: 'relay.attach.failed', source: 'mobile' });
  expect(entry.data).toMatchObject({ attemptId: 'attempt_a', durationMs: 42, relayId: 'relay_a', token: '[REDACTED]' });
  expect(entry.data.nested).toEqual({ grant: '[REDACTED]', proof: '[REDACTED]', status: 502 });
  expect(logText()).not.toMatch(/bearer-secret|credential-secret|grant-secret|proof-secret/);
});

test('restores an enabled switch from storage', async () => {
  mockSecureValues.set('task-handoff.mobile.diagnostic-logs', JSON.stringify({ version: 1, enabled: true }));
  const logs = loadLogs();
  await logs.initializeDiagnosticLogs();
  expect(logs.getDiagnosticLogsEnabled()).toBe(true);
  logs.writeDiagnosticLog('info', 'relay.resume.complete', { attemptId: 'attempt_b', durationMs: 12 });
  expect(logText()).toContain('"event":"relay.resume.complete"');
});

test('rotates bounded log files and copies only the recent tail', async () => {
  const logs = loadLogs();
  logs.setDiagnosticLogsEnabled(true);
  await logs.clearDiagnosticLogs();
  for (let index = 0; index < 1_100; index += 1) {
    logs.writeDiagnosticLog('info', 'relay.probe.candidate', { index, padding: 'x'.repeat(1_000) });
  }
  const files = [...mockFiles.entries()].filter(([uri]) => uri.endsWith('.log'));
  expect(files).toHaveLength(3);
  expect(files.every(([, value]) => new TextEncoder().encode(value).length <= 513 * 1024)).toBe(true);

  const copied = await logs.copyRecentDiagnosticLogs(2_000);
  expect(copied).toBeGreaterThan(0);
  expect(copied).toBeLessThanOrEqual(2_100);
  expect(mockSetStringAsync).toHaveBeenCalledWith(expect.stringContaining('"padding":"x'));
});

test('clears every rotated log file', async () => {
  const logs = loadLogs();
  logs.setDiagnosticLogsEnabled(true);
  logs.writeDiagnosticLog('info', 'relay.connect.start', { attemptId: 'attempt_c' });
  expect(mockFiles.size).toBeGreaterThan(0);
  await logs.clearDiagnosticLogs();
  expect(mockFiles.size).toBe(0);
});
