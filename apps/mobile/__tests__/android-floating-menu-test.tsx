import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FloatingMenu } from '../src/components/menu/FloatingMenu';
import { menuPageFromActions } from '../src/components/menu/menu-actions';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { bottom: 34, left: 0, right: 0, top: 47 } };

test('native menu actions flatten into a titled iOS style floating page', () => {
  const pressed: string[] = [];
  const page = menuPageFromActions([
    { attributes: { destructive: true }, id: 'delete', image: 'trash', title: 'Delete' },
    { attributes: { hidden: true }, id: 'hidden', title: 'Hidden' },
    { displayInline: true, id: 'group', subactions: [{ id: 'inline', title: 'Inline' }], title: 'Group' },
    { id: 'models', subactions: [{ id: 'model-a', title: 'Model A' }], title: 'Models' },
    { id: 'current', state: 'on', title: 'Current' },
  ], 'Options', (action) => pressed.push(action.id ?? action.title));

  expect(page).toMatchObject({
    blocks: [
      { key: 'title', label: 'Options', type: 'title' },
      { item: { destructive: true, icon: 'trash-outline', key: 'delete', label: 'Delete', selected: false }, key: 'delete', type: 'item' },
      { key: 'section:group', label: 'Group', type: 'section' },
      { item: { key: 'inline', label: 'Inline' }, key: 'inline', type: 'item' },
      { item: { key: 'models', label: 'Models', selected: false, submenu: { blocks: [{ item: { key: 'model-a', label: 'Model A' }, key: 'model-a', type: 'item' }], title: 'Models' } }, key: 'models', type: 'item' },
      { item: { key: 'current', label: 'Current', selected: true }, key: 'current', type: 'item' },
    ],
    title: 'Options',
  });

  const items = page.blocks.flatMap((block) => (block.type === 'item' ? [block.item] : []));
  items.forEach((item) => item.onPress?.());
  items.find((item) => item.key === 'models')?.submenu?.blocks.forEach((block) => { if (block.type === 'item') block.item.onPress?.(); });
  expect(pressed).toEqual(['delete', 'inline', 'models', 'current', 'model-a']);
});

test('a pressed floating menu row runs its action and dismisses the card', async () => {
  const onDismiss = jest.fn();
  const onPress = jest.fn();
  const page = menuPageFromActions([{ id: 'run', title: 'Run' }], 'Actions', (action) => { if (action.id === 'run') onPress(); });
  const screen = await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <FloatingMenu anchor={{ height: 30, width: 30, x: 100, y: 100 }} onDismiss={onDismiss} page={page} />
    </SafeAreaProvider>,
  );

  await fireEvent.press(screen.getByText('Run'));

  expect(onPress).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
});

test('floating menus keep disabled rows inert and open nested pages in place', async () => {
  const onDismiss = jest.fn();
  const onPress = jest.fn();
  const page = menuPageFromActions([
    { attributes: { disabled: true }, id: 'blocked', title: 'Blocked' },
    { id: 'models', subactions: [{ id: 'model-a', title: 'Model A' }], title: 'Models' },
  ], 'Actions', (action) => onPress(action.id));
  const screen = await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <FloatingMenu anchor={{ height: 30, width: 30, x: 100, y: 100 }} onDismiss={onDismiss} page={page} />
    </SafeAreaProvider>,
  );

  await fireEvent.press(screen.getByText('Blocked'));
  expect(onPress).not.toHaveBeenCalled();
  expect(onDismiss).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByText('Models'));
  expect(onPress).not.toHaveBeenCalled();
  screen.getByText('Model A');
});
