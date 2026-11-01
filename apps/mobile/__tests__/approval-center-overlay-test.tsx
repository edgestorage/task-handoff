import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { approvalFabIcon, MobileApprovalCenterOverlay, sourceIcon } from '../src/approval-center/MobileApprovalCenterOverlay';
import type { MobileApprovalCenterContextValue } from '../src/approval-center/use-mobile-approval-center';
import { MobileThemeProvider } from '../src/components/theme';
import { MobileI18nProvider } from '../src/i18n';

let mockCenter: MobileApprovalCenterContextValue;
type MockBottomSheetProps = {
  enablePanDownToClose?: boolean;
  index?: number;
  onClose?: () => void;
  snapPoints?: readonly (string | number)[];
};
const mockBottomSheetProps: { current?: MockBottomSheetProps } = {};
const mockSheetClose = jest.fn();
const originalPlatform = Platform.OS;

function setPlatform(os: 'android' | 'ios') {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os, writable: true });
}

jest.mock('@expo/ui/community/bottom-sheet', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  function BottomSheet(props: MockBottomSheetProps & {
    children?: React.ReactNode;
    ref?: React.Ref<{ close(): void }>;
  }) {
    const { children, onClose, ref, ...rest } = props;
    mockBottomSheetProps.current = { onClose, ...rest };
    const close = React.useCallback(() => {
      mockSheetClose();
      onClose?.();
    }, [onClose]);
    React.useImperativeHandle(ref, () => ({ close }), [close]);
    return React.createElement(View, { testID: 'mobile-approval-detail-sheet' }, children);
  }
  return {
    __esModule: true,
    default: BottomSheet,
    BottomSheet,
    BottomSheetView: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement(View, props, children),
  };
});

jest.mock('../src/approval-center/use-mobile-approval-center', () => ({
  useApprovalCenterOcclusion: jest.fn(),
  useMobileApprovalCenter: () => mockCenter,
}));

const request = {
  id: 'apr_a',
  operation: 'instance.delete' as const,
  targetId: 'ins_a',
  createdAt: '2026-10-31T00:10:00.000Z',
  expiresAt: '2026-10-31T01:10:00.000Z',
  details: [{ field: 'roleIds', value: 'Role A' }],
};

const item = {
  type: 'operation-approval' as const,
  key: 'cp_a:operation-approval:apr_a',
  controlPlaneId: 'cp_a',
  request,
};

const deviceItem = {
  type: 'device-trust' as const,
  key: 'cp_a:device-trust:control-plane-device:bind_a:dtr_a',
  controlPlaneId: 'cp_a',
  request: {
    source: 'control-plane-device' as const,
    requestId: 'dtr_a',
    status: 'pending' as const,
    reason: 'first-seen' as const,
    device: { name: 'iPhone', kind: 'mobile', platform: 'ios' },
    fingerprint: `sha256:${'a'.repeat(43)}`,
    comparisonCode: 'AAAA-BBBB-CCCC-DDDD',
    bindingId: 'bind_a',
    accountId: 'acct_a',
    ownerAccountId: 'acct_a',
    accessMode: 'owner' as const,
    cloudAccessRoleId: 'role_a',
    requestedAt: '2026-10-31T00:20:00.000Z',
    lastSeenAt: '2026-10-31T00:20:00.000Z',
    expiresAt: '2026-10-31T01:10:00.000Z',
    revision: 1,
  },
  roles: [{ roleId: 'role_a', name: 'Operator', status: 'archived' as const, isAdmin: false }],
};

const nodeTrustItem = {
  type: 'node-control-plane-trust' as const,
  key: 'cp_a:node-control-plane-trust:nod_a:ntr_a',
  controlPlaneId: 'cp_a',
  nodeId: 'nod_a',
  nodeName: 'Mac Mini',
  request: {
    controlPlaneId: 'cp_b',
    fingerprint: `sha256:${'b'.repeat(43)}`,
    comparisonCode: 'EEEE-FFFF-GGGG-HHHH',
    nodeHandle: 'nrh_05v1q51sea67s',
    bindingId: 'bind_b',
    bindingRevision: 1,
    access: { userId: 'usr_b', permissions: [], roleIds: [], accountId: 'acct_b', ownerAccountId: 'acct_b', accessMode: 'owner' as const },
    requestId: 'ntr_a',
    status: 'pending' as const,
    reason: 'first-seen' as const,
    requestedAt: '2026-10-31T00:30:00.000Z',
    lastSeenAt: '2026-10-31T00:30:00.000Z',
    expiresAt: '2026-10-31T01:10:00.000Z',
    revision: 1,
  },
};

function center(overrides: Partial<MobileApprovalCenterContextValue> = {}): MobileApprovalCenterContextValue {
  const items = overrides.items ?? [item];
  return {
    actions: {},
    collapse: jest.fn(),
    decide: jest.fn(),
    dockSide: 'right',
    edgeHidden: false,
    expandOrCollapse: jest.fn(),
    expanded: false,
    detailItem: undefined,
    headerInset: 143,
    items,
    obstructionHeight: 0,
    pendingCount: items.length,
    preferredExpanded: false,
    registerHeaderInset: jest.fn(() => () => undefined),
    registerOcclusion: jest.fn(() => () => undefined),
    revealAndExpand: jest.fn(),
    retry: jest.fn(),
    scrollOffset: 0,
    selectedKey: undefined,
    selectItem: jest.fn(),
    setFabPlacement: jest.fn(),
    setDetailItem: jest.fn(),
    setScrollOffset: jest.fn(),
    sourceHealth: {
      'ai-session-approval': { items: [], health: { source: 'ai-session-approval', phase: 'ready', pendingCount: 0, retryable: true } },
      'story-decision': { items: [], health: { source: 'story-decision', phase: 'ready', pendingCount: 0, retryable: true } },
      'operation-approval': { items, health: { source: 'operation-approval', phase: 'ready', pendingCount: items.length, retryable: true } },
      'device-trust': { items: [], health: { source: 'device-trust', phase: 'ready', pendingCount: 0, retryable: true } },
      'node-control-plane-trust': { items: [], health: { source: 'node-control-plane-trust', phase: 'ready', pendingCount: 0, retryable: true } },
    },
    verticalRatio: 1,
    ...overrides,
  };
}

function tree(value: MobileApprovalCenterContextValue) {
  mockCenter = value;
  return <SafeAreaProvider initialMetrics={{
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 47, right: 0, bottom: 34, left: 0 },
  }}>
    <MobileThemeProvider><MobileI18nProvider><MobileApprovalCenterOverlay /></MobileI18nProvider></MobileThemeProvider>
  </SafeAreaProvider>;
}

beforeEach(() => {
  mockBottomSheetProps.current = undefined;
  mockSheetClose.mockClear();
});

afterEach(() => {
  setPlatform(originalPlatform as 'android' | 'ios');
});

test('renders no approval surface at all when pending count is zero', async () => {
  const screen = await render(tree(center({ items: [], pendingCount: 0 })));

  expect(screen.queryByTestId('mobile-approval-center')).toBeNull();
  expect(screen.queryByTestId('mobile-approval-fab')).toBeNull();
});

test('uses one 44 point floating entry and exposes the true count independently of the capped badge', async () => {
  const screen = await render(tree(center({ pendingCount: 150 })));

  expect(screen.getByTestId('mobile-approval-fab')).toHaveStyle({ height: 44, width: 44 });
  expect(screen.getByLabelText(/Open approvals\. 150 pending, Approvals panel collapsed/u)).toBeTruthy();
  expect(screen.getByTestId('mobile-approval-center')).toBeTruthy();
});

test('reveals and expands an edge-hidden entry from the visible sliver', async () => {
  const revealAndExpand = jest.fn();
  const screen = await render(tree(center({ edgeHidden: true, revealAndExpand })));

  await fireEvent.press(screen.getByTestId('mobile-approval-fab'));

  expect(revealAndExpand).toHaveBeenCalledTimes(1);
});

test('opens and collapses in place without remounting or reordering the tab layout', async () => {
  const expandOrCollapse = jest.fn();
  const screen = await render(tree(center({ expanded: true, expandOrCollapse })));

  expect(screen.getByTestId('mobile-approval-panel')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('mobile-approval-fab'));
  expect(expandOrCollapse).toHaveBeenCalledTimes(1);
});

test('keeps loaded approvals visible while showing sanitized partial-source diagnostics', async () => {
  const value = center();
  const screen = await render(tree({
    ...value,
    expanded: true,
    preferredExpanded: true,
    sourceHealth: {
      ...value.sourceHealth,
      'device-trust': {
        items: [],
        health: { source: 'device-trust', phase: 'stale', pendingCount: 0, retryable: true, diagnostic: 'SOURCE_STALE' },
      },
    },
  }));

  expect(screen.getByTestId('mobile-approval-diagnostics')).toBeTruthy();
  expect(screen.getByText('Some approval sources are unavailable')).toBeTruthy();
  expect(screen.getByText('Device trust')).toBeTruthy();
  expect(screen.getByTestId('mobile-approval-item-cp_a:operation-approval:apr_a')).toBeTruthy();
});

test('opens the native sheet for complete approval context', async () => {
  setPlatform('ios');
  const screen = await render(tree(center({ detailItem: item })));

  expect(screen.getByTestId('mobile-approval-detail-sheet')).toBeTruthy();
  expect(screen.getByTestId('mobile-approval-detail')).toBeTruthy();
  expect(screen.getByText('Role A')).toBeTruthy();
  expect(screen.getByLabelText('Close')).toBeTruthy();
});

test.each(['ios', 'android'] as const)('uses the same half-height sheet on %s and closes back to the floating list', async (platform) => {
  setPlatform(platform);
  const setDetailItem = jest.fn();
  await render(tree(center({ detailItem: item, setDetailItem })));

  expect(mockBottomSheetProps.current).toEqual(expect.objectContaining({
    enablePanDownToClose: true,
    index: 0,
    snapPoints: ['50%', '100%'],
  }));

  await act(async () => { mockBottomSheetProps.current?.onClose?.(); });

  expect(setDetailItem).toHaveBeenCalledWith(undefined);
});

test('uses desktop-style business titles, source identity and localized operation fields', async () => {
  const screen = await render(tree(center({ expanded: true })));

  expect(screen.getByText('Delete instance')).toBeTruthy();
  expect(screen.getByText('ins_a')).toBeTruthy();
  expect(screen.getByText('Roles: Role A')).toBeTruthy();
  expect(screen.queryByText('instance.delete')).toBeNull();
});

test('opens full detail from the shared approval row', async () => {
  const selectItem = jest.fn();
  const setDetailItem = jest.fn();
  const screen = await render(tree(center({ expanded: true, selectItem, setDetailItem })));

  await fireEvent.press(screen.getByLabelText('Operation approval. Delete instance. ins_a'));

  expect(selectItem).toHaveBeenCalledWith(item.key);
  expect(setDetailItem).toHaveBeenCalledWith(item);
});

test('disables approval when the requested device role is unavailable', async () => {
  const decide = jest.fn();
  const screen = await render(tree(center({ expanded: true, items: [deviceItem], pendingCount: 1, decide })));

  expect(screen.getByText('The requested cloud role is not active locally. Enable it before approving.')).toBeTruthy();
  await fireEvent.press(screen.getByText('Approve'));
  expect(decide).not.toHaveBeenCalled();
});

test('dims the app while expanded and collapses from the backdrop', async () => {
  const expandOrCollapse = jest.fn();
  const screen = await render(tree(center({ expanded: true, expandOrCollapse })));

  expect(screen.getByTestId('mobile-approval-backdrop')).toHaveStyle({ backgroundColor: 'rgba(0, 0, 0, 0.48)' });
  await fireEvent.press(screen.getByTestId('mobile-approval-backdrop'));
  expect(expandOrCollapse).toHaveBeenCalledTimes(1);
});

test('does not render a backdrop while the approval panel is collapsed', async () => {
  const screen = await render(tree(center({ expanded: false })));

  expect(screen.queryByTestId('mobile-approval-backdrop')).toBeNull();
});

test('keeps rejection available when the requested device role is unavailable', async () => {
  const decide = jest.fn();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = await render(tree(center({ expanded: true, items: [deviceItem], pendingCount: 1, decide })));

  await fireEvent.press(screen.getByText('Reject'));
  const buttons = alert.mock.calls.at(-1)?.[2];
  const reject = buttons?.find((button) => button.style === 'destructive');
  reject?.onPress?.();

  expect(decide).toHaveBeenCalledWith(deviceItem, { decision: 'reject' });
  alert.mockRestore();
});

test('uses the desktop shield language for the FAB and approval sources', () => {
  expect(approvalFabIcon(false)).toBe('shield-checkmark-outline');
  expect(approvalFabIcon(true)).toBe('chevron-down');
  expect(sourceIcon('ai-session-approval')).toBe('shield-outline');
  expect(sourceIcon('operation-approval')).toBe('shield-checkmark-outline');
  expect(sourceIcon('device-trust')).toBe('shield-checkmark-outline');
  expect(sourceIcon('node-control-plane-trust')).toBe('shield-checkmark-outline');
});

test('renders approval actions as compact neutral outline buttons', async () => {
  const screen = await render(tree(center({ expanded: true })));

  expect(screen.getByTestId(`approval-actions-${item.key}`)).toHaveStyle({ paddingTop: 12 });
  expect(screen.getByTestId(`approval-action-${item.key}-approve`)).toHaveStyle({
    backgroundColor: 'transparent',
    flexGrow: 1,
    minHeight: 38,
  });
  expect(screen.getByTestId(`approval-action-${item.key}-deny`)).toHaveStyle({
    backgroundColor: 'transparent',
    flexGrow: 1,
    minHeight: 38,
  });
});

test('maps node trust handles to the authoritative directory name', async () => {
  const screen = await render(tree(center({ expanded: true, items: [nodeTrustItem], pendingCount: 1 })));

  expect(screen.getByText('Mac Mini')).toBeTruthy();
  expect(screen.queryByText('nrh_05v1q51sea67s')).toBeNull();
});

test('closing the detail sheet returns to the shared approval surface', async () => {
  setPlatform('ios');
  const setDetailItem = jest.fn();
  const screen = await render(tree(center({ detailItem: item, setDetailItem })));

  await fireEvent.press(screen.getByLabelText('Close'));

  expect(mockSheetClose).toHaveBeenCalledTimes(1);
  expect(setDetailItem).toHaveBeenCalledWith(undefined);
});

test('retries all sources when more than one loaded source is unavailable', async () => {
  const value = center();
  const retry = jest.fn();
  const screen = await render(tree({
    ...value,
    expanded: true,
    retry,
    sourceHealth: {
      ...value.sourceHealth,
      'operation-approval': {
        items: value.sourceHealth['operation-approval'].items,
        health: { ...value.sourceHealth['operation-approval'].health, phase: 'stale', diagnostic: 'SOURCE_STALE' },
      },
      'device-trust': {
        items: [],
        health: { source: 'device-trust', phase: 'unavailable', pendingCount: 0, retryable: true, diagnostic: 'SOURCE_UNAVAILABLE' },
      },
    },
  }));

  await fireEvent.press(screen.getByText('Retry'));

  expect(retry).toHaveBeenCalledWith(undefined);
});
