const CLOUD_FIXTURE = {
  TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: 'https://cloud.example.test',
  TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: 'example.test',
  TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: 'relay.example.test',
  TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY: '0',
  TASK_HANDOFF_CLOUD_DISCOVERY_RECORD: '_cloud.example.test',
  TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN: 'https://cloud.example.test',
} as const;

const CLOUD_DISCOVERY_FIXTURE = {
  record: '_cloud.example.test',
  fallbackOrigin: 'https://cloud.example.test',
  allowedHostSuffixes: ['example.test'],
} as const;

describe('mobile native feature variants', () => {
  const managedEnvironmentVariables = [
    'TASK_HANDOFF_MOBILE_VARIANT',
    'TASK_HANDOFF_CLOUD_ENV',
    'TASK_HANDOFF_CLOUD_SERVICE_ORIGIN',
    'TASK_HANDOFF_CLOUD_STAGING_ORIGIN',
    'TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES',
    'TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES',
    'TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY',
    'TASK_HANDOFF_CLOUD_DISCOVERY_RECORD',
    'TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN',
    'TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED',
    'TASK_HANDOFF_CLOUD_RELAY_ENABLED',
  ] as const;
  const originalEnvironment = Object.fromEntries(managedEnvironmentVariables.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    delete process.env.TASK_HANDOFF_CLOUD_ENV;
    delete process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN;
    for (const [name, value] of Object.entries(CLOUD_FIXTURE)) process.env[name] = value;
  });

  afterEach(() => {
    for (const name of managedEnvironmentVariables) {
      const value = originalEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test.each(['development', 'production'])('includes task status widgets in %s builds', (variant) => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = variant;
    const config = require('../app.config.js')();
    expect(config.extra.taskStatusWidgetsEnabled).toBe(true);
    expect(config.plugins).toContainEqual(expect.arrayContaining(['expo-widgets']));
  });

  test.each(['development', 'production'])('includes the native Browser config plugin in %s builds', (variant) => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = variant;
    const config = require('../app.config.js')();
    expect(config.plugins).toContain('./modules/task-handoff-browser/plugin/withTaskHandoffBrowser');
  });

  test('keeps the native splash visible while the initial profile route resolves', () => {
    const config = require('../app.config.js')();
    expect(config.plugins).toContainEqual([
      'expo-splash-screen',
      expect.objectContaining({
        backgroundColor: '#f2f2f7',
        dark: expect.objectContaining({ backgroundColor: '#000000', image: './assets/splash-icon-dark.png' }),
        image: './assets/splash-icon-light.png',
        imageWidth: 100,
      }),
    ]);
  });

  test('does not configure a CarPlay app in production builds', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    const config = require('../app.config.js')();
    expect(Object.keys(config.ios?.entitlements || {})).not.toContainEqual(expect.stringMatching(/carplay/i));
    expect(JSON.stringify(config.plugins)).not.toMatch(/carplay/i);
  });

  test('configures native production identifiers and Android release signing', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    const config = require('../app.config.js')();
    expect(config.name).toBe('TaskHandoff');
    expect(config.ios.bundleIdentifier).toBe('com.taskhandoff.mobile');
    expect(config.android.package).toBe('com.taskhandoff.mobile');
    expect(config.plugins).toContain('./plugins/with-task-handoff-android-release');
  });

  test('production ignores the staging override while staging uses the configured cloud identity', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN = 'https://ignored.example.test';
    expect(require('../app.config.js')().extra.cloudServiceOrigin).toBeUndefined();
    expect(require('../app.config.js')().extra.cloudEnvironment).toEqual(expect.objectContaining({
      id: 'production',
      serviceOrigin: CLOUD_FIXTURE.TASK_HANDOFF_CLOUD_SERVICE_ORIGIN,
    }));
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'staging';
    delete process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN;
    expect(require('../app.config.js')().extra.cloudServiceOrigin).toBe(CLOUD_FIXTURE.TASK_HANDOFF_CLOUD_SERVICE_ORIGIN);
    expect(require('../app.config.js')().extra.cloudEnvironment).toEqual(expect.objectContaining({
      id: 'staging',
      serviceOrigin: CLOUD_FIXTURE.TASK_HANDOFF_CLOUD_SERVICE_ORIGIN,
      allowInsecureRelay: false,
    }));
    process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN = 'https://staging.cloud.example.test/path';
    expect(require('../app.config.js')().extra.cloudServiceOrigin).toBe('https://staging.cloud.example.test');
    process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN = 'http://staging.cloud.example.test';
    expect(() => require('../app.config.js')()).toThrow(/must use HTTPS/);
  });

  test('bakes the configured TXT record and Coordinator suffix allowlist', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    expect(require('../app.config.js')().extra.cloudDiscovery).toEqual(CLOUD_DISCOVERY_FIXTURE);

    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'staging';
    delete process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN;
    expect(require('../app.config.js')().extra.cloudDiscovery).toEqual(CLOUD_DISCOVERY_FIXTURE);
  });

  test('uses the explicit discovery record for an ad-hoc cloud override', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'staging';
    process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN = 'https://staging.cloud.example.test';
    delete process.env.TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES;
    delete process.env.TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES;
    delete process.env.TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN;
    expect(require('../app.config.js')().extra.cloudDiscovery).toEqual({
      record: '_cloud.example.test',
      fallbackOrigin: 'https://staging.cloud.example.test',
      allowedHostSuffixes: ['staging.cloud.example.test'],
    });
  });

  test('bakes the production cloud domains and discovery record from environment variables', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    process.env.TASK_HANDOFF_CLOUD_ENV = 'production';
    const config = require('../app.config.js')();
    expect(config.extra.cloudEnvironment).toEqual({
      id: 'production',
      serviceOrigin: CLOUD_FIXTURE.TASK_HANDOFF_CLOUD_SERVICE_ORIGIN,
      coordinatorHostSuffixes: ['example.test'],
      relayHostSuffixes: ['relay.example.test'],
      allowInsecureRelay: false,
    });
    expect(config.extra.cloudDiscovery).toEqual(CLOUD_DISCOVERY_FIXTURE);
  });

  test('production builds fail closed without an explicit cloud environment', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    for (const name of Object.keys(CLOUD_FIXTURE)) delete process.env[name];
    expect(() => require('../app.config.js')()).toThrow(/TASK_HANDOFF_CLOUD_SERVICE_ORIGIN is required/);
  });

  test('official account is enabled by default without changing direct profiles', () => {
    delete process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED;
    delete process.env.TASK_HANDOFF_CLOUD_RELAY_ENABLED;
    expect(require('../app.config.js')().extra.featureFlags.officialAccount).toBe(true);
    process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED = '0';
    expect(require('../app.config.js')().extra.featureFlags.officialAccount).toBe(false);
  });

  test('official account uses the shared build-time flag and preserves the legacy extra', () => {
    process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED = '1';
    const enabled = require('../app.config.js')().extra;
    expect(enabled.featureFlags.officialAccount).toBe(true);
    expect(enabled.cloudRelayEnabled).toBe(true);
    process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED = '0';
    expect(require('../app.config.js')().extra.featureFlags.officialAccount).toBe(false);
  });

  test('official account accepts the v0.0.32 environment variable only when the canonical flag is absent', () => {
    delete process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED;
    process.env.TASK_HANDOFF_CLOUD_RELAY_ENABLED = '1';
    expect(require('../app.config.js')().extra.featureFlags.officialAccount).toBe(true);
    process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED = '0';
    expect(require('../app.config.js')().extra.featureFlags.officialAccount).toBe(false);
  });
});
