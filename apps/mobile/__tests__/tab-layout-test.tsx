import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PrimaryTabsLayout from '../app/(tabs)/(main)/_layout';
import { ScreenFlatList } from '../src/components/ScreenFlatList';
import { useOptionalMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({
  useOptionalMobileControlPlaneRuntime: jest.fn(),
}));

jest.mock('expo-router/unstable-native-tabs', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Trigger = Object.assign(
    ({ children, hidden, name }: React.PropsWithChildren<{ hidden?: boolean; name?: string }>) => React.createElement(View, {
      accessibilityElementsHidden: hidden,
      testID: `native-tab-${name}`,
    }, children),
    {
      Icon: () => null,
      Label: ({ children }: React.PropsWithChildren) => React.createElement(Text, null, children),
      VectorIcon: () => null,
    },
  );
  const NativeTabs = Object.assign(
    ({ children }: React.PropsWithChildren) => React.createElement(View, { testID: 'native-tabs' }, children),
    { Trigger },
  );
  return { NativeTabs };
});

const mockUseOptionalMobileControlPlaneRuntime = jest.mocked(useOptionalMobileControlPlaneRuntime);

describe('<PrimaryTabsLayout />', () => {
  beforeEach(() => {
    mockUseOptionalMobileControlPlaneRuntime.mockReturnValue({ storyCapability: false } as ReturnType<typeof useOptionalMobileControlPlaneRuntime>);
  });

  test('keeps the native tabs below the status-bar safe area', async () => {
    const screen = await render(
      <SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, right: 0, bottom: 34, left: 0 },
      }}>
        <PrimaryTabsLayout />
      </SafeAreaProvider>,
    );

    expect(screen.getByTestId('native-tabs')).toBeTruthy();
    expect(screen.getByText('AI Sessions')).toBeTruthy();
    expect(screen.getByText('App Sessions')).toBeTruthy();
    expect(screen.getByText('Instances')).toBeTruthy();
    expect(screen.getByTestId('primary-tabs-safe-area')).toHaveStyle({ flex: 1 });
  });

  test.each([
    { storyCapability: false, storyTabHidden: true },
    { storyCapability: true, storyTabHidden: false },
  ])('keeps every native tab route mounted when Story capability is $storyCapability', async ({ storyCapability, storyTabHidden }) => {
    mockUseOptionalMobileControlPlaneRuntime.mockReturnValue({ storyCapability } as ReturnType<typeof useOptionalMobileControlPlaneRuntime>);
    const screen = await render(<PrimaryTabsLayout />);

    expect(screen.getAllByTestId(/^native-tab-/u, { includeHiddenElements: true })).toHaveLength(4);
    expect(screen.getByTestId('native-tab-stories', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(storyTabHidden);
  });

  test('lets the native tab controller apply its bottom inset to screen lists', async () => {
    const screen = await render(
      <ScreenFlatList data={['entry']} renderItem={() => null} testID="screen-list" />,
    );

    expect(screen.getByTestId('screen-list').props.contentInsetAdjustmentBehavior).toBe('automatic');
  });
});
