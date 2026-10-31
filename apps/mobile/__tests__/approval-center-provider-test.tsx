import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import { AccessibilityInfo, Keyboard, Pressable, Text, View } from 'react-native';

import type { ApprovalCenterItem } from '@task-handoff/control-plane-client';

import {
  MobileApprovalCenterProvider,
  useApprovalCenterOcclusion,
  useMobileApprovalCenter,
} from '../src/approval-center/use-mobile-approval-center';
import { MobileI18nProvider } from '../src/i18n';

type MockController = {
  items: ApprovalCenterItem[];
  listeners: Set<() => void>;
  publish(items: ApprovalCenterItem[]): void;
};

const mockControllers: MockController[] = [];
let mockControlPlaneId = 'cp_a';
let mockInitialItems: ApprovalCenterItem[] = [];
const mockRuntimeApi = {};
const mockCoordinator = { register: () => () => undefined };

const mockIsScreenReaderEnabled = jest.fn(async () => false);
const mockAnnounceForAccessibility = jest.fn();
Object.defineProperties(AccessibilityInfo, {
  isScreenReaderEnabled: { configurable: true, value: mockIsScreenReaderEnabled },
  announceForAccessibility: { configurable: true, value: mockAnnounceForAccessibility },
});

jest.mock('../src/approval-center/controller', () => ({
  MobileApprovalCenterController: class {
    items = [] as ApprovalCenterItem[];
    listeners = new Set<() => void>();
    snapshotValue = {
      items: [] as ApprovalCenterItem[],
      sources: {},
      actions: {},
    };
    constructor() {
      this.items = [...mockInitialItems];
      this.snapshotValue = { ...this.snapshotValue, items: this.items };
      mockControllers.push(this as unknown as MockController);
    }
    snapshot = () => this.snapshotValue;
    subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    start = jest.fn(async () => undefined);
    stop = jest.fn();
    setOnline = jest.fn();
    offline = jest.fn();
    onConnectionError = jest.fn();
    syncAiSessions = jest.fn();
    syncDirectory = jest.fn();
    retry = jest.fn(async () => undefined);
    decide = jest.fn(async () => undefined);
    publish(items: ApprovalCenterItem[]) {
      this.items = items;
      this.snapshotValue = { ...this.snapshotValue, items };
      for (const listener of this.listeners) listener();
    }
  },
}));

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({
  useMobileControlPlaneRuntime: () => ({
    phase: 'connected',
    controlPlaneId: mockControlPlaneId,
    api: mockRuntimeApi,
    aiSessionsCapability: true,
    storyCapability: true,
    nodeCapability: true,
    coordinator: mockCoordinator,
  }),
}));

const item = {
  type: 'operation-approval',
  key: 'cp_a:operation-approval:apr_a',
  controlPlaneId: 'cp_a',
  request: {
    id: 'apr_a',
    operation: 'instance.delete',
    targetId: 'ins_a',
    createdAt: '2026-10-31T00:10:00.000Z',
    expiresAt: '2026-10-31T01:10:00.000Z',
  },
} as ApprovalCenterItem;

function Harness() {
  const center = useMobileApprovalCenter();
  return <>
    <Text testID="pending">{center.pendingCount}</Text>
    <Text testID="expanded">{String(center.expanded)}</Text>
    <Text testID="preferred">{String(center.preferredExpanded)}</Text>
    <Text testID="obstruction">{center.obstructionHeight}</Text>
    <Pressable testID="toggle" onPress={center.expandOrCollapse}><Text>Toggle</Text></Pressable>
  </>;
}

function OcclusionHarness({ kind, height, active }: {
  kind: 'composer' | 'detail' | 'modal';
  height: number;
  active: boolean;
}) {
  useApprovalCenterOcclusion(kind, active, height);
  return <Harness />;
}

function tree(occlusion?: { kind: 'composer' | 'detail' | 'modal'; height: number; active: boolean }) {
  return <MobileI18nProvider><MobileApprovalCenterProvider>
    {occlusion ? <OcclusionHarness {...occlusion} /> : <Harness />}
  </MobileApprovalCenterProvider></MobileI18nProvider>;
}

const PRIMARY_TABS = ['sessions', 'stories', 'apps', 'instances'] as const;

function TabSurfaceHarness() {
  const [activeTab, setActiveTab] = useState<(typeof PRIMARY_TABS)[number]>('sessions');
  const center = useMobileApprovalCenter();
  return <>
    {PRIMARY_TABS.map((tab) => <Pressable key={tab} testID={`tab-${tab}`} onPress={() => setActiveTab(tab)}>
      <Text>{tab}</Text>
    </Pressable>)}
    <View testID={`surface-${activeTab}`}>
      <Text testID="pending">{center.pendingCount}</Text>
      <Text testID="expanded">{String(center.expanded)}</Text>
      <Text testID="preferred">{String(center.preferredExpanded)}</Text>
      <Text testID="scroll">{center.scrollOffset}</Text>
      <Text testID="selected">{center.selectedKey ?? ''}</Text>
      <Pressable testID="toggle" onPress={center.expandOrCollapse}><Text>Toggle</Text></Pressable>
      <Pressable testID="scroll-forward" onPress={() => center.setScrollOffset(144)}><Text>Scroll</Text></Pressable>
      <Pressable testID="select-item" onPress={() => center.selectItem(item.key)}><Text>Select</Text></Pressable>
    </View>
  </>;
}

function tabsTree() {
  return <MobileI18nProvider><MobileApprovalCenterProvider><TabSurfaceHarness /></MobileApprovalCenterProvider></MobileI18nProvider>;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockIsScreenReaderEnabled.mockReset().mockResolvedValue(false);
  mockAnnounceForAccessibility.mockReset();
  mockControllers.length = 0;
  mockControlPlaneId = 'cp_a';
  mockInitialItems = [item];
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('zero pending removes all presentation state and the next pending item appears collapsed', async () => {
  const screen = await render(tree());
  await fireEvent.press(screen.getByTestId('toggle'));
  await waitFor(() => expect(screen.getByTestId('preferred')).toHaveTextContent('true'));

  const controller = mockControllers.at(-1)!;
  await act(async () => { controller.publish([]); });
  await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('0'));
  await waitFor(() => expect(screen.getByTestId('preferred')).toHaveTextContent('false'));

  await act(async () => { controller.publish([item]); });
  await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('1'));
  expect(screen.getByTestId('expanded')).toHaveTextContent('false');
  expect(screen.getByTestId('preferred')).toHaveTextContent('false');
});

test('switching Control Plane cancels the prior interaction state and starts the next profile collapsed', async () => {
  const screen = await render(tree());
  await fireEvent.press(screen.getByTestId('toggle'));
  await waitFor(() => expect(screen.getByTestId('preferred')).toHaveTextContent('true'));

  mockControlPlaneId = 'cp_b';
  mockInitialItems = [{
    ...item,
    key: 'cp_b:operation-approval:apr_b',
    controlPlaneId: 'cp_b',
  }];
  await screen.rerender(tree());

  expect(mockControllers.length).toBeGreaterThanOrEqual(2);
  expect(screen.getByTestId('pending')).toHaveTextContent('1');
  expect(screen.getByTestId('expanded')).toHaveTextContent('false');
  expect(screen.getByTestId('preferred')).toHaveTextContent('false');
});

test('switching all four primary tab surfaces preserves one provider interaction state', async () => {
  const screen = await render(tabsTree());
  await fireEvent.press(screen.getByTestId('toggle'));
  await fireEvent.press(screen.getByTestId('scroll-forward'));
  await fireEvent.press(screen.getByTestId('select-item'));
  expect(mockControllers).toHaveLength(1);

  for (const tab of PRIMARY_TABS) {
    await fireEvent.press(screen.getByTestId(`tab-${tab}`));
    expect(screen.getByTestId(`surface-${tab}`)).toBeTruthy();
    expect(screen.getByTestId('pending')).toHaveTextContent('1');
    expect(screen.getByTestId('expanded')).toHaveTextContent('true');
    expect(screen.getByTestId('preferred')).toHaveTextContent('true');
    expect(screen.getByTestId('scroll')).toHaveTextContent('144');
    expect(screen.getByTestId('selected')).toHaveTextContent(item.key);
    expect(mockControllers).toHaveLength(1);
  }
});


test('keyboard obstruction temporarily collapses the panel and restores the user preference afterward', async () => {
  let showKeyboard: ((event: { endCoordinates: { height: number } }) => void) | undefined;
  let hideKeyboard: (() => void) | undefined;
  jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
    if (event === 'keyboardDidShow') showKeyboard = listener as typeof showKeyboard;
    if (event === 'keyboardDidHide') hideKeyboard = listener as typeof hideKeyboard;
    return { remove: jest.fn() } as unknown as ReturnType<typeof Keyboard.addListener>;
  });

  const screen = await render(tree());
  await fireEvent.press(screen.getByTestId('toggle'));
  expect(screen.getByTestId('expanded')).toHaveTextContent('true');

  await act(async () => { showKeyboard?.({ endCoordinates: { height: 310 } }); });
  expect(screen.getByTestId('preferred')).toHaveTextContent('true');
  expect(screen.getByTestId('expanded')).toHaveTextContent('false');
  expect(screen.getByTestId('obstruction')).toHaveTextContent('310');

  await act(async () => { hideKeyboard?.(); });
  expect(screen.getByTestId('obstruction')).toHaveTextContent('0');
  expect(screen.getByTestId('expanded')).toHaveTextContent('true');
});

test('composer or system modal occlusion blocks expansion and restores the preferred state when released', async () => {
  const screen = await render(tree({ kind: 'composer', height: 220, active: true }));
  await fireEvent.press(screen.getByTestId('toggle'));

  expect(screen.getByTestId('preferred')).toHaveTextContent('true');
  expect(screen.getByTestId('expanded')).toHaveTextContent('false');
  expect(screen.getByTestId('obstruction')).toHaveTextContent('220');

  await screen.rerender(tree({ kind: 'composer', height: 220, active: false }));
  expect(screen.getByTestId('expanded')).toHaveTextContent('true');
  expect(screen.getByTestId('obstruction')).toHaveTextContent('0');

  await screen.rerender(tree({ kind: 'modal', height: 0, active: true }));
  expect(screen.getByTestId('preferred')).toHaveTextContent('true');
  expect(screen.getByTestId('expanded')).toHaveTextContent('false');

  await screen.rerender(tree({ kind: 'modal', height: 0, active: false }));
  expect(screen.getByTestId('expanded')).toHaveTextContent('true');
});


test('debounces pending count accessibility announcements to the final value', async () => {
  mockIsScreenReaderEnabled.mockResolvedValue(true);
  const screen = await render(tree());
  const controller = mockControllers.at(-1)!;

  await act(async () => {
    controller.publish([]);
    controller.publish([item]);
    await jest.advanceTimersByTimeAsync(400);
  });

  expect(mockAnnounceForAccessibility).toHaveBeenCalledTimes(1);
  expect(mockAnnounceForAccessibility).toHaveBeenCalledWith('1 approval pending');
  expect(screen.getByTestId('pending')).toHaveTextContent('1');
});
