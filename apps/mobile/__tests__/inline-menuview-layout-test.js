const fs = require('node:fs');
const path = require('node:path');

test('iOS inline menu uses the UIKit host so list triggers keep their Yoga layout', () => {
  const iosMenu = fs.readFileSync(path.resolve(__dirname, '../src/components/InlineMenuView.ios.tsx'), 'utf8');
  const sharedMenu = fs.readFileSync(path.resolve(__dirname, '../src/components/InlineMenuView.tsx'), 'utf8');
  const actionsMenu = fs.readFileSync(path.resolve(__dirname, '../src/ai-sessions/AiSessionActionsMenu.tsx'), 'utf8');

  expect(iosMenu).toContain("export { MenuView } from '@react-native-menu/menu'");
  expect(sharedMenu).toContain("export { MenuView, type MenuAction } from './MenuView'");
  expect(actionsMenu).toContain("from '../components/InlineMenuView'");
});
