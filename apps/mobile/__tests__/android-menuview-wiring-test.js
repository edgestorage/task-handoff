const fs = require('node:fs');
const path = require('node:path');

const menuView = fs.readFileSync(path.resolve(__dirname, '../src/components/MenuView.tsx'), 'utf8');

test('the Android MenuView reports pressed actions through onPressAction', () => {
  expect(menuView).toContain('onPressAction');
  expect(menuView).toMatch(/menuPageFromActions\(actions, title, \(action\) => onPressAction\?\.\(\{ nativeEvent: \{ event: action\.id \?\? action\.title \} \}\)\)/);
});
