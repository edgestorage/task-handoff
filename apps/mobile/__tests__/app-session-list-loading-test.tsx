import { render } from '@testing-library/react-native';

import { AppSessionList } from '../src/app-sessions/AppSessionList';
import type { MobileDirectoryProfileState } from '../src/directories/store';

const directory: MobileDirectoryProfileState = {
  controlPlaneId: 'cp-1',
  instances: [],
  nodeStates: [],
  nodes: [],
  phase: 'ready',
};

describe('<AppSessionList /> initial sync', () => {
  test('shows the Relay and snapshot phases before the first App Session snapshot arrives', async () => {
    const relay = await render(<AppSessionList
      connection={{ phase: 'verifying', relay: true }}
      directory={directory}
      onCloseSession={jest.fn()}
      scope={{ kind: 'all' }}
      state={{ controlPlaneId: 'cp-1', sync: { phase: 'idle' } }}
    />);

    expect(relay.getByLabelText('Loading App Sessions')).toBeTruthy();
    expect(relay.getByTestId('app-session-list-loading').props.accessibilityState).toEqual({ busy: true });
    expect(relay.getByText('Connecting to Cloud Relay')).toBeTruthy();
    expect(relay.getByText('Establishing a secure connection before syncing App Sessions')).toBeTruthy();
    expect(relay.queryByText('No app sessions in this scope')).toBeNull();
    await relay.unmount();

    const syncing = await render(<AppSessionList
      connection={{ phase: 'connected', relay: false }}
      directory={directory}
      onCloseSession={jest.fn()}
      scope={{ kind: 'all' }}
      state={{ controlPlaneId: 'cp-1', sync: { phase: 'loading' } }}
    />);

    expect(syncing.getByLabelText('Loading App Sessions')).toBeTruthy();
    expect(syncing.getByTestId('app-session-list-loading')).toBeTruthy();
    expect(syncing.getByText('Syncing App Sessions')).toBeTruthy();
    expect(syncing.getByText('Fetching the latest App Session snapshot')).toBeTruthy();
    expect(syncing.queryByText('No app sessions in this scope')).toBeNull();
    await syncing.unmount();
  });
});
