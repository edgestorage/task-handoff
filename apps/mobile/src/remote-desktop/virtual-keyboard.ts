export type RemoteDesktopKeyboardMode = 'system' | 'virtual';
export type RemoteDesktopVirtualKeyboardPage = 'fn' | 'abc' | 'num';
export type RemoteDesktopModifier = 'shift' | 'ctrl' | 'alt' | 'meta';
export type RemoteDesktopModifierStateValue = 'off' | 'armed' | 'locked';
export type RemoteDesktopModifierState = Record<RemoteDesktopModifier, RemoteDesktopModifierStateValue>;

export type RemoteDesktopVirtualKey = {
  code: string;
  label: string;
  accessibilityLabel?: string;
  flex?: number;
  modifier?: RemoteDesktopModifier;
};

export type RemoteDesktopVirtualKeyboardPageDefinition = {
  id: RemoteDesktopVirtualKeyboardPage;
  label: string;
  rows: readonly (readonly RemoteDesktopVirtualKey[])[];
};

export const REMOTE_DESKTOP_MODIFIER_KEYS: Record<RemoteDesktopModifier, { code: string; bit: number }> = {
  shift: { code: 'ShiftLeft', bit: 4 },
  ctrl: { code: 'ControlLeft', bit: 1 },
  alt: { code: 'AltLeft', bit: 2 },
  meta: { code: 'MetaLeft', bit: 8 },
};

export const EMPTY_REMOTE_DESKTOP_MODIFIER_STATE: RemoteDesktopModifierState = {
  shift: 'off',
  ctrl: 'off',
  alt: 'off',
  meta: 'off',
};

const modifierOrder: RemoteDesktopModifier[] = ['shift', 'ctrl', 'alt', 'meta'];

export function remoteDesktopModifierKeys(): RemoteDesktopVirtualKey[] {
  return [
    { code: 'Escape', label: 'Esc' },
    { code: 'Tab', label: 'Tab' },
    { code: REMOTE_DESKTOP_MODIFIER_KEYS.shift.code, label: 'Shift', modifier: 'shift' },
    { code: REMOTE_DESKTOP_MODIFIER_KEYS.ctrl.code, label: 'Ctrl', modifier: 'ctrl' },
    { code: REMOTE_DESKTOP_MODIFIER_KEYS.alt.code, label: 'Alt', modifier: 'alt' },
    { code: REMOTE_DESKTOP_MODIFIER_KEYS.meta.code, label: 'Meta', modifier: 'meta' },
    { code: 'Backspace', label: '⌫', accessibilityLabel: 'Backspace' },
    { code: 'Delete', label: 'Del' },
  ];
}

const functionKeys = (start: number, end: number): RemoteDesktopVirtualKey[] => (
  Array.from({ length: end - start + 1 }, (_, index) => {
    const value = start + index;
    return { code: `F${value}`, label: `F${value}` };
  })
);

export const REMOTE_DESKTOP_VIRTUAL_KEYBOARD_PAGES: readonly RemoteDesktopVirtualKeyboardPageDefinition[] = [
  {
    id: 'fn',
    label: 'Fn',
    rows: [
      functionKeys(1, 6),
      functionKeys(7, 12),
      [
        { code: 'Insert', label: 'Ins' },
        { code: 'Home', label: 'Home' },
        { code: 'PrintScreen', label: 'PrtSc' },
        { code: 'PageUp', label: 'PgUp' },
        { code: 'PageDown', label: 'PgDn' },
        { code: 'End', label: 'End' },
      ],
      [
        { code: 'ContextMenu', label: 'Menu' },
        { code: 'ArrowLeft', label: '←', accessibilityLabel: 'Left arrow' },
        { code: 'ArrowUp', label: '↑', accessibilityLabel: 'Up arrow' },
        { code: 'ArrowDown', label: '↓', accessibilityLabel: 'Down arrow' },
        { code: 'ArrowRight', label: '→', accessibilityLabel: 'Right arrow' },
      ],
    ],
  },
  {
    id: 'abc',
    label: 'ABC',
    rows: [
      ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'].map((code) => ({ code, label: code.slice(-1) })),
      ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'].map((code) => ({ code, label: code.slice(-1) })),
      ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'].map((code) => ({ code, label: code.slice(-1) })),
      ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'].map((code) => ({
        code,
        label: code === 'Comma' ? ',' : code === 'Period' ? '.' : code === 'Slash' ? '/' : code.slice(-1),
      })),
      [
        { code: 'Backspace', label: '⌫', accessibilityLabel: 'Backspace', flex: 1.4 },
        { code: 'Space', label: 'Space', flex: 4 },
        { code: 'Enter', label: 'Enter', flex: 1.4 },
      ],
    ],
  },
  {
    id: 'num',
    label: 'Num',
    rows: [
      [
        { code: 'NumLock', label: 'Num' },
        { code: 'NumpadDivide', label: '/' },
        { code: 'NumpadMultiply', label: '×' },
        { code: 'NumpadSubtract', label: '−' },
      ],
      [
        { code: 'Numpad7', label: '7' },
        { code: 'Numpad8', label: '8' },
        { code: 'Numpad9', label: '9' },
        { code: 'NumpadAdd', label: '+' },
      ],
      [
        { code: 'Numpad4', label: '4' },
        { code: 'Numpad5', label: '5' },
        { code: 'Numpad6', label: '6' },
        { code: 'NumpadEnter', label: 'Enter' },
      ],
      [
        { code: 'Numpad1', label: '1' },
        { code: 'Numpad2', label: '2' },
        { code: 'Numpad3', label: '3' },
        { code: 'NumpadEqual', label: '=' },
      ],
      [
        { code: 'Numpad0', label: '0', flex: 2 },
        { code: 'NumpadDecimal', label: '.', flex: 1 },
        { code: 'Backspace', label: '⌫', accessibilityLabel: 'Backspace', flex: 1 },
      ],
    ],
  },
];

export function remoteDesktopModifierBitMask(state: RemoteDesktopModifierState) {
  return modifierOrder.reduce((mask, modifier) => mask | (state[modifier] === 'off' ? 0 : REMOTE_DESKTOP_MODIFIER_KEYS[modifier].bit), 0);
}

export function activeRemoteDesktopModifiers(state: RemoteDesktopModifierState) {
  return modifierOrder.filter((modifier) => state[modifier] !== 'off');
}

export function tapRemoteDesktopModifier(state: RemoteDesktopModifierState, modifier: RemoteDesktopModifier) {
  const active = state[modifier] !== 'off';
  return {
    down: !active,
    state: { ...state, [modifier]: active ? 'off' as const : 'armed' as const },
  };
}

export function lockRemoteDesktopModifier(state: RemoteDesktopModifierState, modifier: RemoteDesktopModifier) {
  if (state[modifier] === 'locked') return { down: false, state };
  return {
    down: state[modifier] === 'off',
    state: { ...state, [modifier]: 'locked' as const },
  };
}

export function releaseArmedRemoteDesktopModifiers(state: RemoteDesktopModifierState) {
  const released = modifierOrder.filter((modifier) => state[modifier] === 'armed');
  if (!released.length) return { released, state };
  const next = { ...state };
  for (const modifier of released) next[modifier] = 'off';
  return { released, state: next };
}
