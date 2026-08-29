import { browserCapabilities } from '../modules/task-handoff-browser/src';

test('builds without the native Browser module degrade to unsupported', async () => {
  await expect(browserCapabilities()).resolves.toEqual({
    supported: false,
    platform: 'unsupported',
    proxyOverride: false,
    isolatedProfile: false,
    reason: 'NATIVE_BROWSER_REQUIRED',
  });
});
