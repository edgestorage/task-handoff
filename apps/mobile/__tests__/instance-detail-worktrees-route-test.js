const fs = require('node:fs');
const path = require('node:path');

const detail = fs.readFileSync(path.resolve(__dirname, '../src/instances/InstanceDetailScreen.tsx'), 'utf8');
const iosContent = fs.readFileSync(path.resolve(__dirname, '../src/instances/InstanceDetailContent.ios.tsx'), 'utf8');
const worktreesRoute = fs.readFileSync(path.resolve(__dirname, '../app/instances/[instanceId]/worktrees.tsx'), 'utf8');

test('instance detail delegates worktree management to a secondary route', () => {
  expect(detail).toContain("pathname: '/instances/[instanceId]/worktrees' as never");
  expect(detail).not.toContain('InstanceWorktreesSection');
  expect(worktreesRoute).toContain('InstanceWorktreesScreen');
});

test('instance detail uses a single native Expo UI list with native status controls', () => {
  expect(iosContent).toContain("from '@expo/ui/swift-ui'");
  expect(iosContent).toMatch(/<List[\s\S]*<LabeledContent[\s\S]*<Button/);
  expect(iosContent).toContain("t('repository.worktrees.sectionTitle')");
});
