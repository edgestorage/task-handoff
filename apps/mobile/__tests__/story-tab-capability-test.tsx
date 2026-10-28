import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import StoriesLayout from '../app/(tabs)/(main)/stories/_layout';
import StoriesRoute from '../app/(tabs)/(main)/stories/index';
import { mobileLightColors } from '../src/components/theme';
import type { NativeSplitPaneOptions } from '../src/components/NativeSplitMasterDetail';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { updateStoryViewPreferences } from '../src/stories/story-view-preferences';

let mockWide = false;
let mockNativeSplitOptions: NativeSplitPaneOptions | undefined;
const mockOpenDrawer = jest.fn();

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: jest.fn() }));
jest.mock('../src/components/MasterDetailLayout', () => ({
  ...jest.requireActual<typeof import('../src/components/MasterDetailLayout')>('../src/components/MasterDetailLayout'),
  useMasterDetailLayout: () => ({ wide: mockWide }),
  MasterDetailLayout: ({ list, nativeSplitOptions }: { list?: ReactNode; nativeSplitOptions?: NativeSplitPaneOptions }) => {
    const React = jest.requireActual<typeof import('react')>('react');
    mockNativeSplitOptions = nativeSplitOptions;
    return React.createElement(React.Fragment, null, list, nativeSplitOptions?.list.headerLeft?.({} as never));
  },
}));
jest.mock('../src/instance-scope/use-open-instance-drawer', () => ({ useOpenInstanceDrawer: () => mockOpenDrawer }));

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => {
  const useMobileControlPlaneRuntime = jest.fn();
  return { useMobileControlPlaneRuntime, useOptionalMobileControlPlaneRuntime: useMobileControlPlaneRuntime };
});

jest.mock('../src/stories/StoryInbox', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { StoryInbox: () => React.createElement(Text, null, 'Story inbox') };
});

jest.mock('../src/stories/StoryNodeFilterHeaderButton', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { StoryNodeFilterHeaderButton: ({ onPress }: { onPress?(): void }) => React.createElement(Pressable, { onPress }, React.createElement(Text, null, 'Story node scope')) };
});

jest.mock('../src/components/PrimaryTabStack', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  type MockMenuEntry = { items?: MockMenuEntry[]; label?: string; multiselectable?: boolean; onPress?: () => void; state?: string; type: string };
  const actions = (items: MockMenuEntry[]): MockMenuEntry[] => items.flatMap((item) => item.items ? actions(item.items) : [item]);
  return { PrimaryTabStack: ({ headerRightItems, onAdd, scopeControl }: { headerRightItems?: () => { menu?: { items: MockMenuEntry[]; multiselectable?: boolean }; tintColor?: string; type: string }[]; onAdd?: () => void; scopeControl?: React.ReactNode }) => {
    const headerItems = headerRightItems?.();
    const menu = headerItems?.find((item) => item.type === 'menu')?.menu;
    return React.createElement(React.Fragment, null,
      React.createElement(Text, null, onAdd ? 'Story add enabled' : 'Story add disabled'),
      scopeControl,
      headerItems ? React.createElement(Text, { testID: 'native-header-tint' }, JSON.stringify(headerItems.filter((item) => item.type !== 'spacing').map((item) => item.tintColor))) : null,
      menu ? React.createElement(Text, { testID: 'native-menu-shape' }, JSON.stringify({ multiselectable: menu.multiselectable, submenus: menu.items.map((item) => ({ multiselectable: item.multiselectable, type: item.type })) })) : null,
      ...actions(menu?.items ?? []).map((action) => React.createElement(Pressable, { accessibilityLabel: `native-${action.label}`, key: action.label, onPress: action.onPress }, React.createElement(Text, null, `${action.label}:${action.state}`))),
    );
  } };
});

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);

beforeEach(() => {
  mockWide = false;
  mockNativeSplitOptions = undefined;
  mockOpenDrawer.mockClear();
  updateStoryViewPreferences({ manualKeys: [], sortMode: 'name', viewMode: 'compact' });
});

describe('<StoriesRoute />', () => {
  test('renders a stable unsupported page when the Control Plane lacks Story capability', async () => {
    mockRuntime.mockReturnValue({ storyCapability: false } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesRoute />);

    expect(screen.getByText('Stories are not supported by the current Control Plane.')).toBeTruthy();
    expect(screen.queryByText('Story inbox')).toBeNull();
  });

  test('renders the Story inbox when supported', async () => {
    mockRuntime.mockReturnValue({ storyCapability: true } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesRoute />);

    expect(screen.getByText('Story inbox')).toBeTruthy();
    expect(screen.queryByText('Stories are not supported by the current Control Plane.')).toBeNull();
  });

  test('opens the outer drawer from the native split node scope button', async () => {
    mockWide = true;
    mockRuntime.mockReturnValue({ storyCapability: true } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesRoute />);

    expect(mockNativeSplitOptions).toBeDefined();
    await fireEvent.press(screen.getByText('Story node scope'));
    expect(mockOpenDrawer).toHaveBeenCalledTimes(1);
  });
});

describe('<StoriesLayout />', () => {
  test('does not offer Story creation when the capability is unavailable', async () => {
    mockRuntime.mockReturnValue({ storyCapability: false } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesLayout />);

    expect(screen.getByText('Story add disabled')).toBeTruthy();
  });

  test('offers Story creation when the capability is available', async () => {
    mockRuntime.mockReturnValue({ storyCapability: true } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesLayout />);

    expect(screen.getByText('Story add enabled')).toBeTruthy();
    expect(screen.getByText('Story node scope')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('native-header-tint').props.children)).toEqual([mobileLightColors.primary, mobileLightColors.primary]);
  });

  test('updates the native sort checkmark after one selection', async () => {
    mockRuntime.mockReturnValue({ storyCapability: true } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesLayout />);

    expect(JSON.parse(screen.getByTestId('native-menu-shape').props.children)).toEqual({
      multiselectable: true,
      submenus: [{ type: 'submenu' }, { type: 'submenu' }],
    });
    await fireEvent.press(screen.getByLabelText('native-Last AI Session'));

    await waitFor(() => expect(screen.getByText('Last AI Session:on')).toBeTruthy());
    expect(screen.getByText('Name:off')).toBeTruthy();
  });
});
