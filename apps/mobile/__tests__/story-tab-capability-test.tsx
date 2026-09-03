import { render } from '@testing-library/react-native';

import StoriesLayout from '../app/(tabs)/(main)/stories/_layout';
import StoriesRoute from '../app/(tabs)/(main)/stories/index';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({
  useMobileControlPlaneRuntime: jest.fn(),
}));

jest.mock('../src/stories/StoryInbox', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { StoryInbox: () => React.createElement(Text, null, 'Story inbox') };
});

jest.mock('../src/components/PrimaryTabStack', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { PrimaryTabStack: ({ onAdd }: { onAdd?: () => void }) => React.createElement(Text, null, onAdd ? 'Story add enabled' : 'Story add disabled') };
});

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);

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
  });
});
