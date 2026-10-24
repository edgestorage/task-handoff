import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform, Text } from 'react-native';

import { iosTransparentHeaderOptions } from '../src/components/navigation-header';
import { PrimaryTabStack } from '../src/components/PrimaryTabStack';

const mockHeaderOptions: { current?: Record<string, unknown> } = {};

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Stack: ({ screenOptions }: { screenOptions: Record<string, unknown> }) => {
      mockHeaderOptions.current = screenOptions;
      return React.createElement(React.Fragment);
    },
  };
});

const setPlatform = (os: 'android' | 'ios') => Object.defineProperty(Platform, 'OS', { configurable: true, value: os, writable: true });

const setPlatformVersion = (version: number) => Object.defineProperty(Platform, 'Version', { configurable: true, value: version, writable: true });

test('keeps the Android header title clear of the scope control', async () => {
  const originalPlatform = Platform.OS;
  try {
    setPlatform('android');
    await render(<PrimaryTabStack scopeControl={<Text testID="scope-control">All Instances</Text>} title="AI Sessions" />);

    const headerLeft = mockHeaderOptions.current?.headerLeft as () => ReactElement<{ children: ReactElement; style: unknown }>;
    const element = headerLeft();

    expect(element.props.style).toEqual({ paddingRight: 12 });
    expect((await render(element)).getByTestId('scope-control')).toBeTruthy();
  } finally {
    setPlatform(originalPlatform as 'android' | 'ios');
  }
});

test('leaves the iOS header left untouched', async () => {
  const originalPlatform = Platform.OS;
  try {
    setPlatform('ios');
    await render(<PrimaryTabStack scopeControl={<Text testID="scope-control">All Instances</Text>} title="AI Sessions" />);

    const headerLeft = mockHeaderOptions.current?.headerLeft as () => ReactElement;
    const element = headerLeft();

    expect((element.props as { style?: unknown }).style).toBeUndefined();
    expect((await render(element)).getByTestId('scope-control')).toBeTruthy();
  } finally {
    setPlatform(originalPlatform as 'android' | 'ios');
  }
});

test.each([
  [27, 'automatic'],
  [26, 'soft'],
] as const)('uses the iOS %i scroll edge effect', (version, effect) => {
  const originalPlatform = Platform.OS;
  const originalVersion = Platform.Version;
  try {
    setPlatform('ios');
    setPlatformVersion(version);

    expect(iosTransparentHeaderOptions(false)).toEqual(expect.objectContaining({ scrollEdgeEffects: { top: effect } }));
  } finally {
    setPlatform(originalPlatform as 'android' | 'ios');
    Object.defineProperty(Platform, 'Version', { configurable: true, value: originalVersion, writable: true });
  }
});
