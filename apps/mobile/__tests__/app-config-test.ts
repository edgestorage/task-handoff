describe('mobile native feature variants', () => {
  const originalVariant = process.env.TASK_HANDOFF_MOBILE_VARIANT;

  afterEach(() => {
    if (originalVariant === undefined) delete process.env.TASK_HANDOFF_MOBILE_VARIANT;
    else process.env.TASK_HANDOFF_MOBILE_VARIANT = originalVariant;
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
});
