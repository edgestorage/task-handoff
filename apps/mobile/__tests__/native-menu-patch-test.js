const fs = require('node:fs');
const path = require('node:path');

const patch = fs.readFileSync(path.resolve(__dirname, '../../../patches/@react-native-menu__menu@2.0.0.patch'), 'utf8');
const nativeMenu = fs.readFileSync(path.resolve(__dirname, '../node_modules/@react-native-menu/menu/ios/NewArch/MenuView.mm'), 'utf8');
const nativeMenuButton = fs.readFileSync(path.resolve(__dirname, '../node_modules/@react-native-menu/menu/ios/Shared/MenuViewImplementation.swift'), 'utf8');
const sessionMenus = fs.readFileSync(path.resolve(__dirname, '../src/ai-sessions/SessionComposerMenus.ios.tsx'), 'utf8');
const sessionWorkspace = fs.readFileSync(path.resolve(__dirname, '../src/ai-sessions/SessionWorkspace.tsx'), 'utf8');

test('the native menu keeps the presented UIKit menu event target enabled until recycle', () => {
  for (const source of [patch, nativeMenu]) {
    expect(source).toContain('retainPresentedEventEmitter:eventEmitter');
    expect(source).toContain('EventEmitter::DispatchMutex()');
    expect(source).toContain('setEnabled(true)');
    expect(source).toContain('setEnabled(false)');
    expect(source).toContain('auto eventEmitter = _presentedEventEmitter');
    expect(source).toContain('releasePresentedEventEmitter');
    expect(source).toContain('prepareForRecycle');
    expect(source).not.toContain('experimental_flushSync');
  }
  expect(nativeMenu).toMatch(/onPressAction:[\s\S]*auto eventEmitter = _presentedEventEmitter/);
  expect(nativeMenu).toMatch(/onPressAction:[\s\S]*eventEmitter->onPressAction/);
  expect(nativeMenu).toMatch(/prepareForRecycle[\s\S]*releasePresentedEventEmitter/);
  for (const source of [patch, nativeMenuButton]) {
    expect(source).toContain('for: .menuActionTriggered');
    expect(source).toMatch(/primaryMenuTriggered[\s\S]*sendMenuOpen\(\)/);
  }
});

test('the iOS model selector remains a native UIMenu with subtitles and controlled states', () => {
  expect(sessionMenus).toContain("from '@react-native-menu/menu'");
  expect(sessionMenus).toContain('subtitle: modelGroupSubtitle');
  expect(sessionMenus).toMatch(/state: selectedModel === model\.modelName \? 'on' : 'off'/);
  expect(sessionMenus).not.toContain('<Popover');
});

test('existing-session actions create request ids with the React Native crypto implementation', () => {
  expect(sessionWorkspace).toContain("import * as Crypto from 'expo-crypto'");
  expect(sessionWorkspace).toContain('Crypto.randomUUID()');
  expect(sessionWorkspace).not.toContain('crypto.randomUUID()');
});
