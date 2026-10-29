import { shouldDismissInstanceDrawer } from '../src/instance-scope/use-instance-drawer-lifecycle';

test('dismisses the instance drawer when the app enters the background', () => {
  expect(shouldDismissInstanceDrawer('active', 'inactive')).toBe(false);
  expect(shouldDismissInstanceDrawer('inactive', 'background')).toBe(true);
});

test('reconciles an open instance drawer when iOS resumes from the background', () => {
  expect(shouldDismissInstanceDrawer('background', 'active')).toBe(true);
});

test('does not dismiss the instance drawer for transient interruptions', () => {
  expect(shouldDismissInstanceDrawer('inactive', 'active')).toBe(false);
});
