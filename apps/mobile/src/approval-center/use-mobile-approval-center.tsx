import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Keyboard } from 'react-native';

import { approvalCenterPendingCount, type ApprovalCenterItem } from '@task-handoff/control-plane-client';
import type { MobileApprovalCenterState } from './controller';
import { mobileAiSessionStore } from '../ai-sessions/store';
import { mobileDirectoryStore } from '../directories/store';
import {
  useMobileControlPlaneRuntime,
  type MobileControlPlaneRuntimeValue,
} from '../control-plane/use-mobile-control-plane-runtime';
import { mobileMetrics } from '../observability/mobile-metrics';
import { useI18n } from '../i18n';
import { MobileApprovalCenterController } from './controller';
import {
  DEFAULT_APPROVAL_CENTER_PLACEMENT,
  type ApprovalCenterFabPlacement,
} from './geometry';

type OcclusionKind = 'composer' | 'detail' | 'modal';
type OcclusionRegistration = { id: symbol; kind: OcclusionKind; height: number };

export type MobileApprovalCenterContextValue = {
  actions: MobileApprovalCenterState['actions'];
  collapse(): void;
  decide(item: ApprovalCenterItem, input: { decision?: string; optionId?: string; response?: string; retry?: boolean }): void;
  dockSide: ApprovalCenterFabPlacement['dockSide'];
  edgeHidden: boolean;
  expandOrCollapse(): void;
  expanded: boolean;
  fullScreenItem?: ApprovalCenterItem;
  headerInset: number;
  items: readonly ApprovalCenterItem[];
  obstructionHeight: number;
  pendingCount: number;
  preferredExpanded: boolean;
  registerHeaderInset(height: number): () => void;
  registerOcclusion(kind: OcclusionKind, height?: number): () => void;
  revealAndExpand(): void;
  retry(source?: Parameters<MobileApprovalCenterController['retry']>[0]): void;
  scrollOffset: number;
  selectedKey?: string;
  selectItem(key?: string): void;
  setFabPlacement(placement: ApprovalCenterFabPlacement): void;
  setFullScreenItem(item?: ApprovalCenterItem): void;
  setScrollOffset(offset: number): void;
  sourceHealth: ReturnType<MobileApprovalCenterController['snapshot']>['sources'];
  verticalRatio: number;
};

const EMPTY_VALUE: MobileApprovalCenterContextValue = {
  actions: {},
  collapse: () => undefined,
  decide: () => undefined,
  dockSide: DEFAULT_APPROVAL_CENTER_PLACEMENT.dockSide,
  edgeHidden: false,
  expandOrCollapse: () => undefined,
  expanded: false,
  headerInset: 0,
  items: [],
  obstructionHeight: 0,
  pendingCount: 0,
  preferredExpanded: false,
  registerHeaderInset: () => () => undefined,
  registerOcclusion: () => () => undefined,
  revealAndExpand: () => undefined,
  retry: () => undefined,
  scrollOffset: 0,
  selectItem: () => undefined,
  setFabPlacement: () => undefined,
  setFullScreenItem: () => undefined,
  setScrollOffset: () => undefined,
  sourceHealth: {} as MobileApprovalCenterContextValue['sourceHealth'],
  verticalRatio: DEFAULT_APPROVAL_CENTER_PLACEMENT.verticalRatio,
};

const Context = createContext<MobileApprovalCenterContextValue>(EMPTY_VALUE);

export function MobileApprovalCenterProvider({ children }: { children: ReactNode }) {
  const runtime = useMobileControlPlaneRuntime();
  return <MobileApprovalCenterStateProvider
    key={runtime.controlPlaneId ?? '__inactive__'}
    runtime={runtime}
  >{children}</MobileApprovalCenterStateProvider>;
}

function MobileApprovalCenterStateProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: MobileControlPlaneRuntimeValue;
}) {
  const { t } = useI18n();
  const online = runtime.phase === 'connected';
  const [preferredExpanded, setPreferredExpanded] = useState(false);
  const [scrollOffset, setScrollOffsetState] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [fullScreenKey, setFullScreenKey] = useState<string>();
  const [fabPlacement, setFabPlacement] = useState<ApprovalCenterFabPlacement>(DEFAULT_APPROVAL_CENTER_PLACEMENT);
  const [headerInsets, setHeaderInsets] = useState<readonly { height: number; id: symbol }[]>([]);
  const [occlusions, setOcclusions] = useState<readonly OcclusionRegistration[]>([]);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const controlPlaneId = runtime.controlPlaneId;
  const emptyAi = mobileAiSessionStore.profile(controlPlaneId || '__inactive__');
  const emptyDirectory = mobileDirectoryStore.profile(controlPlaneId || '__inactive__');
  useSyncExternalStore(
    (listener) => controlPlaneId ? mobileAiSessionStore.subscribe(controlPlaneId, listener) : () => undefined,
    () => controlPlaneId ? mobileAiSessionStore.profile(controlPlaneId) : emptyAi,
    () => emptyAi,
  );
  useSyncExternalStore(
    (listener) => controlPlaneId ? mobileDirectoryStore.subscribe(controlPlaneId, listener) : () => undefined,
    () => controlPlaneId ? mobileDirectoryStore.profile(controlPlaneId) : emptyDirectory,
    () => emptyDirectory,
  );

  const controller = useMemo(() => controlPlaneId && runtime.api
    ? new MobileApprovalCenterController(controlPlaneId, runtime.api, {
      aiSessions: () => mobileAiSessionStore.profile(controlPlaneId),
      directory: () => mobileDirectoryStore.profile(controlPlaneId),
      supportsAiSessions: runtime.aiSessionsCapability,
      supportsStories: runtime.storyCapability,
      supportsNodes: runtime.nodeCapability,
    })
    : undefined, [
    controlPlaneId,
    runtime.aiSessionsCapability,
    runtime.api,
    runtime.nodeCapability,
    runtime.storyCapability,
  ]);

  const emptyState = useMemo(() => ({
    items: [] as readonly ApprovalCenterItem[],
    sources: {} as MobileApprovalCenterContextValue['sourceHealth'],
    actions: {} as MobileApprovalCenterContextValue['actions'],
  }), []);
  const resetInteraction = useCallback(() => {
    setPreferredExpanded(false);
    setScrollOffsetState(0);
    setSelectedKey(undefined);
    setFullScreenKey(undefined);
    setFabPlacement((current) => current.visibility === 'docked' ? current : { ...current, visibility: 'docked' });
  }, [setFabPlacement, setFullScreenKey, setPreferredExpanded, setScrollOffsetState, setSelectedKey]);
  const subscribe = useCallback((listener: () => void) => {
    if (!controller) return () => undefined;
    return controller.subscribe(() => {
      const next = controller.snapshot();
      if (!approvalCenterPendingCount(next.items)) {
        resetInteraction();
      } else {
        const currentKeys = new Set(next.items.map((item) => item.key));
        setSelectedKey((current) => current && currentKeys.has(current) ? current : undefined);
        setFullScreenKey((current) => current && currentKeys.has(current) ? current : undefined);
      }
      listener();
    });
  }, [controller, resetInteraction, setFullScreenKey, setSelectedKey]);
  const snapshot = useCallback(
    () => controller?.snapshot() ?? emptyState,
    [controller, emptyState],
  );
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    controller?.setOnline(online);
  }, [controller, online]);

  useEffect(() => {
    if (!controller || !runtime.coordinator) return;
    return runtime.coordinator.register({
      key: 'mobile-approval-center',
      topics: ['device-trust', 'node.control-plane-trust.changed', 'nodes', 'operation.approvals', 'stories'],
      background: true,
      start: (signal) => controller.start(signal),
      stop: () => controller.stop(),
      offline: () => controller.offline(),
      onEvent: (event) => controller.applyEvent(event),
      onConnectionError: () => controller.onConnectionError(),
    });
  }, [controller, runtime.coordinator]);

  useEffect(() => {
    if (!controlPlaneId) return;
    const aiUnsubscribe = mobileAiSessionStore.subscribe(controlPlaneId, () => controller?.syncAiSessions());
    const directoryUnsubscribe = mobileDirectoryStore.subscribe(controlPlaneId, () => controller?.syncDirectory());
    controller?.syncAiSessions();
    return () => {
      aiUnsubscribe();
      directoryUnsubscribe();
    };
  }, [controlPlaneId, controller]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) => setKeyboardHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const pendingCount = approvalCenterPendingCount(state.items);
  useEffect(() => {
    if (!pendingCount) return;
    const timer = setTimeout(() => {
      void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
        if (enabled) AccessibilityInfo.announceForAccessibility(t('approvalCenter.pendingCount', { count: pendingCount }));
      }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [pendingCount, t]);

  useEffect(() => {
    mobileMetrics.record('mobile-approval-center.render', { screen: 'overlay', result: pendingCount ? 'visible' : 'hidden' }, pendingCount);
  }, [pendingCount]);

  const registerOcclusion = useCallback((kind: OcclusionKind, height = 0) => {
    const registration = { id: Symbol(kind), kind, height: Math.max(0, height) };
    setOcclusions((current) => [...current, registration]);
    return () => setOcclusions((current) => current.filter((entry) => entry.id !== registration.id));
  }, [setOcclusions]);
  const registerHeaderInset = useCallback((height: number) => {
    const registration = { height: Math.max(0, height), id: Symbol('approval-center-header') };
    setHeaderInsets((current) => [...current, registration]);
    return () => setHeaderInsets((current) => current.filter((entry) => entry.id !== registration.id));
  }, []);
  const headerInset = Math.max(0, ...headerInsets.map((entry) => entry.height));

  const obstructionHeight = Math.max(
    0,
    keyboardHeight,
    ...occlusions.filter((entry) => entry.kind === 'composer' || entry.kind === 'detail').map((entry) => entry.height),
  );
  const obstructed = keyboardHeight > 0 || occlusions.some((entry) => entry.kind === 'detail' || entry.kind === 'modal' || entry.kind === 'composer');
  const expanded = preferredExpanded && pendingCount > 0 && !obstructed && fabPlacement.visibility === 'docked';

  const decide = useCallback((item: ApprovalCenterItem, input: { decision?: string; optionId?: string; response?: string; retry?: boolean }) => {
    void controller?.decide(item, input);
  }, [controller]);
  const retry = useCallback((source?: Parameters<MobileApprovalCenterController['retry']>[0]) => {
    void controller?.retry(source);
  }, [controller]);
  const collapse = useCallback(() => setPreferredExpanded(false), []);
  const revealAndExpand = useCallback(() => {
    setFabPlacement((current) => current.visibility === 'docked' ? current : { ...current, visibility: 'docked' });
    setPreferredExpanded(true);
  }, []);
  const expandOrCollapse = useCallback(() => setPreferredExpanded((current) => !current), [setPreferredExpanded]);
  const selectItem = useCallback((key?: string) => setSelectedKey(key), [setSelectedKey]);
  const setFullScreenItem = useCallback((item?: ApprovalCenterItem) => setFullScreenKey(item?.key), [setFullScreenKey]);
  const setScrollOffset = useCallback((offset: number) => setScrollOffsetState(offset), [setScrollOffsetState]);
  const fullScreenItem = fullScreenKey
    ? state.items.find((item) => item.key === fullScreenKey)
    : undefined;

  const value = useMemo<MobileApprovalCenterContextValue>(() => ({
    actions: state.actions,
    collapse,
    decide,
    dockSide: fabPlacement.dockSide,
    edgeHidden: fabPlacement.visibility === 'edge-hidden',
    expandOrCollapse,
    expanded,
    fullScreenItem,
    headerInset,
    items: state.items,
    obstructionHeight,
    pendingCount,
    preferredExpanded,
    registerHeaderInset,
    registerOcclusion,
    revealAndExpand,
    retry,
    scrollOffset,
    selectedKey,
    selectItem,
    setFabPlacement,
    setFullScreenItem,
    setScrollOffset,
    sourceHealth: state.sources,
    verticalRatio: fabPlacement.verticalRatio,
  }), [
    collapse,
    decide,
    fabPlacement,
    expandOrCollapse,
    expanded,
    fullScreenItem,
    headerInset,
    obstructionHeight,
    pendingCount,
    preferredExpanded,
    registerHeaderInset,
    registerOcclusion,
    revealAndExpand,
    retry,
    scrollOffset,
    selectedKey,
    selectItem,
    setFabPlacement,
    setFullScreenItem,
    setScrollOffset,
    state.actions,
    state.items,
    state.sources,
  ]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useMobileApprovalCenter() {
  return useContext(Context);
}

export function useApprovalCenterOcclusion(kind: OcclusionKind, active = true, height = 0) {
  const { registerOcclusion } = useContext(Context);
  useEffect(() => active ? registerOcclusion(kind, height) : undefined, [active, height, kind, registerOcclusion]);
}
