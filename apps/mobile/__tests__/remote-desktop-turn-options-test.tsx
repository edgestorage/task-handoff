import { render } from '@testing-library/react-native';
import { RemoteDesktopSettingsMenu } from '../src/remote-desktop/RemoteDesktopSettingsMenu';
import { emptyRemoteDesktopSnapshot } from '../src/remote-desktop/types';
import type { MenuAction } from '../src/components/MenuView';

let mockActions: MenuAction[] = [];
jest.mock('../src/components/MenuView', () => ({ MenuView: ({ actions, children }: { actions: MenuAction[]; children: React.ReactNode }) => { mockActions = actions; return children; } }));
jest.mock('../src/components/theme', () => ({ useMobileTheme: () => ({ colors: { primary: '#111' } }) }));
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

test.each([[false, false], [true, false], [false, true], [true, true]])('TURN sources are independent: custom configured=%s, panel signed in=%s', async (configured, signedIn) => {
  const screen = await render(<RemoteDesktopSettingsMenu
    snapshot={{ ...emptyRemoteDesktopSnapshot, transportAvailability: { p2p: true, websocket: false, turn: configured },
      connectionOptions: { customTurn: { configured }, cloudTurn: { signedIn, available: false } },
    }}
    onDisconnect={jest.fn()} onSetCapturePrecision={jest.fn()} onSetInputEnabled={jest.fn()}
    onSetFrameRate={jest.fn()} onSetResolution={jest.fn()} onToggleTransport={jest.fn()}
  />);
  const methods = mockActions.find(action => action.id === 'connection-methods')!.subactions!;
  expect(methods.some(action => action.id === 'transport:turn')).toBe(configured);
  expect(methods.some(action => action.id === 'cloud-turn')).toBe(signedIn);
  if (signedIn) expect(methods.find(action => action.id === 'cloud-turn')!.attributes?.disabled).toBe(true);
  // A hidden TURN preference and an unavailable cloud grant cannot count as
  // another usable path when guarding the last enabled transport.
  expect(methods.find(action => action.id === 'transport:p2p')!.attributes?.disabled).toBe(!configured);
  await screen.unmount();
});
