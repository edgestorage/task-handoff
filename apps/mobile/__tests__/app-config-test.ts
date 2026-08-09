describe('mobile native feature variants', () => {
  const originalVariant = process.env.TASK_HANDOFF_MOBILE_VARIANT;
  const originalExpoProjectId = process.env.EXPO_PROJECT_ID;

  afterEach(() => {
    if (originalVariant === undefined) delete process.env.TASK_HANDOFF_MOBILE_VARIANT;
    else process.env.TASK_HANDOFF_MOBILE_VARIANT = originalVariant;
    if (originalExpoProjectId === undefined) delete process.env.EXPO_PROJECT_ID;
    else process.env.EXPO_PROJECT_ID = originalExpoProjectId;
  });

  test.each(['development', 'production'])('includes task status widgets in %s builds', (variant) => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = variant;
    const config = require('../app.config.js')();
    expect(config.extra.taskStatusWidgetsEnabled).toBe(true);
    expect(config.plugins).toContainEqual(expect.arrayContaining(['expo-widgets']));
  });

  test('does not configure a CarPlay app in production builds', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    const config = require('../app.config.js')();
    expect(Object.keys(config.ios?.entitlements || {})).not.toContainEqual(expect.stringMatching(/carplay/i));
    expect(JSON.stringify(config.plugins)).not.toMatch(/carplay/i);
  });

  test('binds CI production builds to the configured EAS project', () => {
    process.env.TASK_HANDOFF_MOBILE_VARIANT = 'production';
    process.env.EXPO_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
    const config = require('../app.config.js')();
    expect(config.name).toBe('TaskHandoff');
    expect(config.ios.bundleIdentifier).toBe('com.taskhandoff.mobile');
    expect(config.android.package).toBe('com.taskhandoff.mobile');
    expect(config.extra.eas.projectId).toBe(process.env.EXPO_PROJECT_ID);
  });
});
