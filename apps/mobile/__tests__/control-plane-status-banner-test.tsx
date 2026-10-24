import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ControlPlaneClosedBanner, MobileControlPlaneStatusBanner } from '../src/control-plane/MobileControlPlaneStatusBanner';
import type { MobileControlPlaneRuntimePhase } from '../src/control-plane/use-mobile-control-plane-runtime';

let mockRuntimePhase: MobileControlPlaneRuntimePhase = 'connected';

jest.mock('../src/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({
  useMobileControlPlaneRuntime: () => ({ phase: mockRuntimePhase }),
}));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

describe('<ControlPlaneClosedBanner />', () => {
  test('shows an explicit closed state while the peer Control Plane is unavailable', async () => {
    const screen = await render(<SafeAreaProvider initialMetrics={metrics}>
      <ControlPlaneClosedBanner visible />
    </SafeAreaProvider>);

    expect(screen.getByTestId('control-plane-closed-banner')).toBeTruthy();
    expect(screen.getByText('controlPlane.closedTitle')).toBeTruthy();
    expect(screen.getByText('controlPlane.closedDescription')).toBeTruthy();
    expect(screen.getByTestId('control-plane-closed-banner-position')).toHaveStyle({
      bottom: 90,
      position: 'absolute',
    });
  });

  test('disappears once the connection recovers', async () => {
    const screen = await render(<SafeAreaProvider initialMetrics={metrics}>
      <ControlPlaneClosedBanner visible={false} />
    </SafeAreaProvider>);

    expect(screen.queryByTestId('control-plane-closed-banner')).toBeNull();
  });

  test('maps the runtime closed phase to the persistent banner', async () => {
    mockRuntimePhase = 'control-plane-closed';
    const screen = await render(<SafeAreaProvider initialMetrics={metrics}>
      <MobileControlPlaneStatusBanner />
    </SafeAreaProvider>);
    expect(screen.getByTestId('control-plane-closed-banner')).toBeTruthy();
  });

  test('hides the runtime banner after reconnecting', async () => {
    mockRuntimePhase = 'connected';
    const screen = await render(<SafeAreaProvider initialMetrics={metrics}>
      <MobileControlPlaneStatusBanner />
    </SafeAreaProvider>);
    expect(screen.queryByTestId('control-plane-closed-banner')).toBeNull();
  });
});
