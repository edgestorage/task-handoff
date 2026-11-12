import { floatingSessionMenuActions, nativeSessionMenuItems, type SessionMenuAction, type SessionMenuItem } from '../src/ai-sessions/session-menu-model';

const noop = () => {};
const items: SessionMenuItem[] = [
  { type: 'group', group: {
    id: 'view',
    label: 'Session view',
    actions: [
      { id: 'compact', label: 'Compact', selected: true, symbol: 'rectangle.stack', onPress: noop },
    ],
  } },
  { type: 'action', action: { id: 'remote-desktop', label: 'Remote desktop', symbol: 'display', onPress: noop } },
  { type: 'group', group: {
    id: 'session-actions',
    label: 'Session actions',
    actions: [{ id: 'rename', label: 'Rename session', symbol: 'pencil', onPress: noop }],
  } },
  { type: 'group', group: { id: 'empty', label: 'Empty', actions: [] } },
];
const close: SessionMenuAction = { destructive: true, id: 'close', label: 'Close session', symbol: 'xmark.circle', onPress: noop };

test('native session menu renders grouped and standalone actions with SF Symbol icons', () => {
  expect(nativeSessionMenuItems(items, [close])).toEqual([
    {
      type: 'submenu',
      label: 'Session view',
      inline: true,
      multiselectable: true,
      items: [
        { type: 'action', label: 'Compact', icon: { name: 'rectangle.stack', type: 'sfSymbol' }, onPress: noop, state: 'on' },
      ],
    },
    { type: 'action', label: 'Remote desktop', icon: { name: 'display', type: 'sfSymbol' }, onPress: noop },
    {
      type: 'submenu',
      label: 'Session actions',
      inline: true,
      multiselectable: true,
      items: [{ type: 'action', label: 'Rename session', icon: { name: 'pencil', type: 'sfSymbol' }, onPress: noop }],
    },
    { type: 'action', label: 'Close session', icon: { name: 'xmark.circle', type: 'sfSymbol' }, onPress: noop, destructive: true },
  ]);
});

test('floating session menu preserves the same groups, standalone action, icons, and dangerous footer action', () => {
  expect(floatingSessionMenuActions(items, [close])).toEqual([
    {
      id: 'view',
      title: 'Session view',
      displayInline: true,
      subactions: [
        { id: 'compact', title: 'Compact', image: 'rectangle.stack', attributes: undefined, state: 'on' },
      ],
    },
    { id: 'remote-desktop', title: 'Remote desktop', image: 'display', attributes: undefined, state: 'off' },
    {
      id: 'session-actions',
      title: 'Session actions',
      displayInline: true,
      subactions: [{ id: 'rename', title: 'Rename session', image: 'pencil', attributes: undefined, state: 'off' }],
    },
    { id: 'close', title: 'Close session', image: 'xmark.circle', attributes: { destructive: true, disabled: undefined }, state: 'off' },
  ]);
});
