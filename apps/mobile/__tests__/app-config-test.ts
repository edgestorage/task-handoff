describe('mobile native feature variants', () => {
  const originalVariant = process.env.TASK_HANDOFF_MOBILE_VARIANT;
  const originalStagingOrigin = process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN;
  const originalOfficialAccountEnabled = process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED;
  const originalCloudRelayEnabled = process.env.TASK_HANDOFF_CLOUD_RELAY_ENABLED;

  afterEach(() => {
    if (originalVariant === undefined) delete process.env.TASK_HANDOFF_MOBILE_VARIANT;
    else process.env.TASK_HANDOFF_MOBILE_VARIANT = originalVariant;
    if (originalStagingOrigin === undefined) delete process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN;
    else process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN = originalStagingOrigin;
    if (originalOfficialAccountEnabled === undefined) delete process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED;
    else process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED = originalOfficialAccountEnabled;
    if (originalCloudRelayEnabled === undefined) delete process.env.TASK_HANDOFF_CLOUD_RELAY_ENABLED;
    else process.env.TASK_HANDOFF_CLOUD_RELAY_ENABLED = originalCloudRelayEnabled;
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
        image: './assets/icon.png',
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

  test('production does not expose an override while staging pins an explicit HTTPS origin', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN = 'https://ignored.example.test';
    expect(require('../app.config.js')().extra.cloudServiceOrigin).toBeUndefined();
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'staging';
    process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN = 'https://staging.cloud.example.test/path';
    expect(require('../app.config.js')().extra.cloudServiceOrigin).toBe('https://staging.cloud.example.test');
    process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN = 'http://staging.cloud.example.test';
    expect(() => require('../app.config.js')()).toThrow(/must use HTTPS/);
  });

  test('official account is disabled by default without changing direct profiles', () => {
    delete process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED;
    delete process.env.TASK_HANDOFF_CLOUD_RELAY_ENABLED;
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
