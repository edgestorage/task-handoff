import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  approvalCenterBadgeText,
  type ApprovalCenterItem,
  type ApprovalCenterSource,
  type ApprovalCenterSourceHealth,
} from '@task-handoff/control-plane-client';

import { useAdaptiveContentLayout } from '../components/adaptive-layout';
import { Icon, type IconName } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/messages';
import {
  APPROVAL_CENTER_FAB_SIZE,
  APPROVAL_CENTER_GAP,
  mobileApprovalCenterLayout,
} from './geometry';
import {
  useApprovalCenterOcclusion,
  useMobileApprovalCenter,
} from './use-mobile-approval-center';

const SOURCE_ORDER: readonly ApprovalCenterSource[] = [
  'ai-session-approval',
  'story-decision',
  'operation-approval',
  'device-trust',
  'node-control-plane-trust',
];

function sourceLabel(source: ApprovalCenterSource, t: ReturnType<typeof useI18n>['t']) {
  switch (source) {
    case 'ai-session-approval': return t('approvalCenter.source.aiSession');
    case 'story-decision': return t('approvalCenter.source.storyDecision');
    case 'operation-approval': return t('approvalCenter.source.operation');
    case 'device-trust': return t('approvalCenter.source.deviceTrust');
    case 'node-control-plane-trust': return t('approvalCenter.source.nodeTrust');
  }
}

export function sourceIcon(source: ApprovalCenterSource): IconName {
  switch (source) {
    case 'ai-session-approval': return 'shield-outline';
    case 'story-decision': return 'book-outline';
    case 'operation-approval': return 'shield-checkmark-outline';
    case 'device-trust': return 'shield-checkmark-outline';
    case 'node-control-plane-trust': return 'shield-checkmark-outline';
  }
}

function itemSource(item: ApprovalCenterItem) {
  return item.type;
}

type ApprovalItem = ApprovalCenterItem;
type Translate = ReturnType<typeof useI18n>['t'];
type Operation = Extract<ApprovalItem, { type: 'operation-approval' }>['request']['operation'];

const OPERATION_LABEL_KEYS: Record<Operation, MessageKey> = {
  'instance.delete': 'approvalCenter.operation.instanceDelete',
  'node.remove': 'approvalCenter.operation.nodeRemove',
  'node.update.apply': 'approvalCenter.operation.nodeUpdate',
  'node.external-listener.set': 'approvalCenter.operation.nodeExternalListener',
  'user.access.set': 'approvalCenter.operation.userAccess',
  'user.role.update': 'approvalCenter.operation.roleUpdate',
  'user.role.remove': 'approvalCenter.operation.roleRemove',
  'identity-provider.update': 'approvalCenter.operation.identityProviderUpdate',
  'identity-provider.remove': 'approvalCenter.operation.identityProviderRemove',
  'git-credential.assign': 'approvalCenter.operation.gitCredentialAssign',
};

const DETAIL_LABEL_KEYS: Record<string, MessageKey> = {
  roleIds: 'approvalCenter.detail.roleIds',
  nodeScope: 'approvalCenter.detail.nodeScope',
  instanceScope: 'approvalCenter.detail.instanceScope',
  changedFields: 'approvalCenter.detail.changedFields',
  permissionIds: 'approvalCenter.detail.permissionIds',
  status: 'approvalCenter.detail.status',
  loginPolicy: 'approvalCenter.detail.loginPolicy',
  credentialId: 'approvalCenter.detail.credentialId',
  bindScope: 'approvalCenter.detail.bindScope',
  port: 'approvalCenter.detail.port',
  targetVersion: 'approvalCenter.detail.targetVersion',
  channel: 'approvalCenter.detail.channel',
};

function itemTitle(item: ApprovalItem, t: Translate) {
  switch (item.type) {
    case 'ai-session-approval': return item.session.title || item.session.userPrompt || item.session.id;
    case 'story-decision': return item.decision.question;
    case 'operation-approval': return t(OPERATION_LABEL_KEYS[item.request.operation]);
    case 'device-trust': return t((`deviceTrust.reason.${item.request.reason}`) as MessageKey);
    case 'node-control-plane-trust': return nodeTrustTitle(item.request.reason, t);
  }
}

function itemSourceDetail(item: ApprovalItem) {
  switch (item.type) {
    case 'ai-session-approval': return `${item.instanceName} · ${item.session.agent}`;
    case 'story-decision': return item.story.title;
    case 'operation-approval': return item.targetName || item.request.targetId;
    case 'device-trust': return item.request.device.name;
    case 'node-control-plane-trust': return item.nodeName || item.request.nodeHandle || item.nodeId;
  }
}

function itemContextLines(item: ApprovalItem, t: Translate) {
  switch (item.type) {
    case 'ai-session-approval': return [];
    case 'story-decision': return item.decision.context ? [`${t('approvalCenter.field.context')}: ${item.decision.context}`] : [];
    case 'operation-approval': return (item.request.details ?? []).map((detail) => {
      const key = DETAIL_LABEL_KEYS[detail.field];
      return `${key ? t(key) : detail.field}: ${detail.value}`;
    });
    case 'device-trust': {
      const role = item.roles.find((candidate) => candidate.roleId === item.request.cloudAccessRoleId);
      return [
        `${t('approvalCenter.field.comparisonCode')}: ${item.request.comparisonCode}`,
        formatExpiryRelative(item.request.expiresAt, t),
        `${t('approvalCenter.field.role')}: ${role?.name || item.request.cloudAccessRoleId}`,
      ].filter(Boolean);
    }
    case 'node-control-plane-trust': return [
      `${t('approvalCenter.field.comparisonCode')}: ${item.request.comparisonCode}`,
      formatExpiryRelative(item.request.expiresAt, t),
    ].filter(Boolean);
  }
}

function nodeTrustTitle(reason: string | undefined, t: Translate) {
  if (reason === 'key-changed') return t('approvalCenter.nodeTrust.keyChanged');
  if (reason === 'access-context-changed') return t('approvalCenter.nodeTrust.accessContextChanged');
  return t('approvalCenter.nodeTrust.firstSeen');
}

function formatExpiryRelative(value: string | undefined, t: Translate) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return t('deviceTrust.expiredAlready');
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return t('deviceTrust.expiresInMinutes', { count: minutes });
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return t('deviceTrust.expiresInHours', { count: hours });
  return t('deviceTrust.expiresInDays', { count: Math.ceil(hours / 24) });
}

function deviceRoleAvailable(item: Extract<ApprovalItem, { type: 'device-trust' }>) {
  return item.roles.some((role) => role.roleId === item.request.cloudAccessRoleId && role.status === 'active');
}

export function approvalFabIcon(expanded: boolean): IconName {
  return expanded ? 'chevron-down' : 'shield-checkmark-outline';
}

export function MobileApprovalCenterOverlay() {
  const center = useMobileApprovalCenter();
  if (!center.pendingCount) return null;
  return <MobileApprovalCenterOverlayContent />;
}

function MobileApprovalCenterOverlayContent() {
  const center = useMobileApprovalCenter();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const adaptive = useAdaptiveContentLayout();
  const { height } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!center.expanded) return;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ animated: false, y: center.scrollOffset });
    });
    return () => cancelAnimationFrame(frame);
  }, [center.expanded, center.scrollOffset]);

  if (!center.pendingCount) return null;

  const layout = mobileApprovalCenterLayout({
    adaptiveInsets: adaptive.contentInsets,
    bottomInset: insets.bottom,
    contentWidth: adaptive.contentWidth,
    obstructionHeight: center.obstructionHeight,
    platform: Platform.OS,
    windowHeight: height,
  });
  const unavailable = SOURCE_ORDER
    .map((source) => center.sourceHealth[source]?.health)
    .filter((health): health is ApprovalCenterSourceHealth => Boolean(health && (health.phase === 'stale' || health.phase === 'unavailable')));
  const stateLabel = center.expanded ? t('approvalCenter.expanded') : t('approvalCenter.collapsed');

  return <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="mobile-approval-center">
    {center.expanded ? <Pressable
      accessibilityLabel={t('approvalCenter.collapse')}
      accessibilityRole="button"
      onPress={center.expandOrCollapse}
      style={styles.backdrop}
      testID="mobile-approval-backdrop"
    /> : null}

    {center.expanded ? <View
      accessibilityLabel={`${t('approvalCenter.title')}, ${t('approvalCenter.pendingCount', { count: center.pendingCount })}`}
      style={[
        styles.panel,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          bottom: layout.bottom + APPROVAL_CENTER_FAB_SIZE + APPROVAL_CENTER_GAP,
          maxHeight: layout.panelMaxHeight,
          right: layout.right,
          width: layout.panelWidth,
        },
      ]}
      testID="mobile-approval-panel"
    >
      <View style={[styles.panelHeader, { borderBottomColor: colors.border }]}>
        <Icon color={colors.primary} name="shield-checkmark-outline" size={24} />
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={[styles.panelTitle, { color: colors.text }]}>{t('approvalCenter.title')}</Text>
          <Text style={[styles.panelSubtitle, { color: colors.textMuted }]}>{t('approvalCenter.pendingCount', { count: center.pendingCount })}</Text>
        </View>
        <Pressable
          accessibilityLabel={t('approvalCenter.collapse')}
          accessibilityRole="button"
          hitSlop={8}
          onPress={center.expandOrCollapse}
          style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? colors.workbenchSelectionBackground : colors.background }]}
        >
          <Icon color={colors.textMuted} name="chevron-down" size={20} />
        </Pressable>
      </View>

      {unavailable.length ? <View
        accessibilityHint={t('approvalCenter.diagnosticsDescription')}
        style={[styles.diagnostics, { backgroundColor: colors.notice, borderColor: colors.noticeText }]}
        testID="mobile-approval-diagnostics"
      >
        <Icon color={colors.noticeText} name="cloud-offline-outline" size={18} />
        <View style={styles.headerCopy}>
          <Text style={[styles.diagnosticTitle, { color: colors.noticeText }]}>{t('approvalCenter.diagnosticsTitle')}</Text>
          <Text numberOfLines={2} style={[styles.diagnosticText, { color: colors.noticeText }]}>{unavailable.map((health) => sourceLabel(health.source, t)).join(' · ')}</Text>
        </View>
        {unavailable.some((health) => health.retryable) ? <Pressable
          accessibilityLabel={t('approvalCenter.retry')}
          accessibilityRole="button"
          onPress={() => center.retry(unavailable.filter((health) => health.retryable).length === 1 ? unavailable.find((health) => health.retryable)?.source : undefined)}
          style={({ pressed }) => [styles.smallAction, { backgroundColor: pressed ? colors.noticeText : 'transparent', borderColor: colors.noticeText }]}
        >
          <Text style={[styles.smallActionText, { color: colors.noticeText }]}>{t('approvalCenter.retry')}</Text>
        </Pressable> : null}
      </View> : null}

      <ScrollView
        accessibilityLabel={t('approvalCenter.listLabel')}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => center.setScrollOffset(event.nativeEvent.contentOffset.y)}
        ref={scrollRef}
        scrollEventThrottle={100}
        showsVerticalScrollIndicator
        style={styles.list}
        testID="mobile-approval-list"
      >
        {center.items.map((item) => <ApprovalItemCard center={center} item={item} key={item.key} />)}
      </ScrollView>
    </View> : null}

    <Pressable
      accessibilityLabel={`${t('approvalCenter.fabLabel', { count: center.pendingCount })}, ${stateLabel}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: center.expanded }}
      onPress={center.expandOrCollapse}
      style={({ pressed }) => [
        styles.fab,
        {
          backgroundColor: pressed ? colors.primaryButton : colors.primary,
          bottom: layout.bottom,
          opacity: pressed ? 0.9 : 1,
          right: layout.right,
        },
      ]}
      testID="mobile-approval-fab"
    >
      <Icon color="#ffffff" name={approvalFabIcon(center.expanded)} size={27} testID="mobile-approval-fab-icon" />
      <View accessibilityElementsHidden style={[styles.badge, { backgroundColor: colors.error, borderColor: colors.surface }]}>
        <Text adjustsFontSizeToFit numberOfLines={1} style={styles.badgeText}>{approvalCenterBadgeText(center.pendingCount)}</Text>
      </View>
    </Pressable>

    <ApprovalDetailModal reduceMotion={reduceMotion} />

  </View>;
}

function actionErrorMessage(error: string | undefined, t: ReturnType<typeof useI18n>['t']) {
  if (error === 'OFFLINE') return t('approvalCenter.offline');
  if (error === 'SOURCE_UNAVAILABLE') return t('approvalCenter.sourceUnavailable');
  if (error === 'STORY_RETRY_REQUIRED') return t('approvalCenter.storyRetryRequired');
  if (error === 'REQUEST_RESULT_UNKNOWN') return t('approvalCenter.resultUnknown');
  return t('approvalCenter.requestFailed');
}

function ApprovalItemCard({ center, item }: {
  center: ReturnType<typeof useMobileApprovalCenter>;
  item: ApprovalItem;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const action = center.actions[item.key];
  const busy = action?.phase === 'busy';
  const failed = action?.phase === 'failed' || action?.phase === 'result-unknown';
  const selected = center.selectedKey === item.key;
  const sourceUnavailable = center.sourceHealth[itemSource(item)]?.health.phase !== 'ready';
  const roleUnavailable = item.type === 'device-trust' && !deviceRoleAvailable(item);
  const open = () => {
    center.selectItem(item.key);
    center.setFullScreenItem(item);
  };

  return <View
    key={item.key}
    style={[styles.item, {
      backgroundColor: selected ? colors.workbenchSelectionBackground : 'transparent',
      borderBottomColor: colors.border,
    }]}
    testID={`mobile-approval-item-${item.key}`}
  >
    <Pressable
      accessibilityHint={t('approvalCenter.openDetailsHint')}
      accessibilityLabel={`${sourceLabel(itemSource(item), t)}. ${itemTitle(item, t)}. ${itemSourceDetail(item)}`}
      accessibilityRole="button"
      onPress={open}
      style={styles.itemPressable}
    >
      <View style={styles.itemHead}>
        <View style={[styles.kindBadge, { backgroundColor: colors.background }]}>
          <Icon color={colors.textMuted} name={sourceIcon(itemSource(item))} size={13} testID={`approval-source-icon-${itemSource(item)}`} />
          <Text numberOfLines={1} style={[styles.kindText, { color: colors.textMuted }]}>{sourceLabel(itemSource(item), t)}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.sourceText, { color: colors.textMuted }]}>{itemSourceDetail(item)}</Text>
        <Icon color={colors.textMuted} name="chevron-forward" size={16} />
      </View>
      <Text numberOfLines={2} style={[styles.itemTitle, { color: colors.text }]}>{itemTitle(item, t)}</Text>
      {itemContextLines(item, t).map((line) => <Text key={line} numberOfLines={2} style={[styles.itemSummary, { color: colors.textMuted }]}>{line}</Text>)}
      {roleUnavailable ? <Text style={[styles.itemSummary, { color: colors.error }]}>{t('approvalCenter.roleUnavailable')}</Text> : null}
    </Pressable>
    <InlineActions
      disabled={busy || sourceUnavailable}
      item={item}
      onDecision={(decision) => center.decide(item, { decision })}
      onOpen={open}
      roleUnavailable={roleUnavailable}
    />
    {failed ? <Text accessibilityLiveRegion="polite" style={[styles.actionError, { color: colors.error }]}>{actionErrorMessage(action?.error, t)}</Text> : null}
    {busy ? <View style={styles.busyRow}><ActivityIndicator color={colors.primary} size="small" /><Text accessibilityLiveRegion="polite" style={[styles.itemMeta, { color: colors.textMuted }]}>{t('approvalCenter.submitting')}</Text></View> : null}
  </View>;
}

function InlineActions({ disabled, item, onDecision, onOpen, roleUnavailable = false }: {
  disabled: boolean;
  item: ApprovalItem;
  onDecision(decision: string): void;
  onOpen(): void;
  roleUnavailable?: boolean;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const actions: { decision?: string; label: string; danger?: boolean; open?: boolean }[] = (() => {
    switch (item.type) {
      case 'ai-session-approval': return item.decisions.map((decision) => ({ decision, label: t(decision === 'allow' ? 'approvalCenter.allow' : decision === 'deny' ? 'approvalCenter.deny' : 'approvalCenter.skip') }));
      case 'story-decision': return [{ label: t('approvalCenter.answer'), open: true }];
      case 'operation-approval': return [{ decision: 'approve', label: t('approvalCenter.approve') }, { decision: 'deny', label: t('approvalCenter.deny'), danger: true }];
      case 'device-trust': return [{ decision: 'approve', label: t('approvalCenter.approve') }, { decision: 'reject', label: t('approvalCenter.reject'), danger: true }];
      case 'node-control-plane-trust': return [{ decision: 'approve', label: t('approvalCenter.approve') }, { decision: 'reject', label: t('approvalCenter.reject'), danger: true }];
    }
  })();
  return <View style={styles.inlineActions}>
    {actions.slice(0, 3).map((action) => {
      const actionDisabled = disabled || (roleUnavailable && action.decision === 'approve');
      return <Pressable
      accessibilityLabel={action.open ? `${t('approvalCenter.answer')} ${itemTitle(item, t)}` : action.label}
      accessibilityRole="button"
      disabled={actionDisabled}
      key={action.label}
      testID={`approval-action-${item.key}-${action.decision ?? 'open'}`}
      onPress={() => {
        if (action.open) onOpen();
        else if (action.decision) {
          if (action.danger) confirmDanger(action.label, t('common.cancel'), () => onDecision(action.decision!));
          else onDecision(action.decision);
        }
      }}
      style={({ pressed }) => [styles.inlineButton, {
        backgroundColor: pressed ? colors.workbenchSelectionBackground : 'transparent',
        borderColor: action.danger ? colors.error : colors.border,
        opacity: actionDisabled ? 0.45 : 1,
      }]}
    >
      <Text style={[styles.inlineButtonText, { color: action.danger ? colors.error : colors.primary }]}>{action.label}</Text>
    </Pressable>;
    })}
  </View>;
}

function ApprovalDetailModal({ reduceMotion }: { reduceMotion: boolean }) {
  const center = useMobileApprovalCenter();
  const item = center.fullScreenItem;
  useApprovalCenterOcclusion('modal', Boolean(item));

  if (!item) return null;
  return <Modal
    animationType={reduceMotion ? 'none' : 'slide'}
    onRequestClose={() => center.setFullScreenItem(undefined)}
    presentationStyle="fullScreen"
    visible
  >
    <ApprovalDetailContent item={item} key={item.key} />
  </Modal>;
}

function ApprovalDetailContent({ item }: { item: ApprovalCenterItem }) {
  const center = useMobileApprovalCenter();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [optionId, setOptionId] = useState<string>();
  const [response, setResponse] = useState('');
  const action = center.actions[item.key];
  const busy = action?.phase === 'busy';
  const failed = action?.phase === 'failed' || action?.phase === 'result-unknown';
  const sourceUnavailable = center.sourceHealth[itemSource(item)]?.health.phase !== 'ready';
  return <View style={[styles.detailRoot, { backgroundColor: colors.background, paddingTop: insets.top }]} testID="mobile-approval-detail">
    <View style={[styles.detailHeader, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
      <Pressable accessibilityLabel={t('approvalCenter.close')} accessibilityRole="button" hitSlop={8} onPress={() => center.setFullScreenItem(undefined)} style={styles.iconButton}>
        <Icon color={colors.primary} name="chevron-back" size={24} />
      </Pressable>
      <View style={styles.headerCopy}>
        <Text accessibilityRole="header" numberOfLines={2} style={[styles.panelTitle, { color: colors.text }]}>{itemTitle(item, t)}</Text>
        <Text style={[styles.panelSubtitle, { color: colors.textMuted }]}>{sourceLabel(itemSource(item), t)}</Text>
      </View>
    </View>
    <ScrollView contentContainerStyle={[styles.detailContent, { paddingBottom: Math.max(insets.bottom, 16) + 24 }]} keyboardShouldPersistTaps="handled">
      <DetailFields item={item} />
      {item.type === 'story-decision' ? <StoryDecisionAnswer
        decision={item.decision}
        onOption={setOptionId}
        onResponse={setResponse}
        optionId={optionId}
        response={response}
      /> : null}
      {failed ? <Text accessibilityLiveRegion="polite" style={[styles.detailError, { color: colors.error }]}>{actionErrorMessage(action?.error, t)}</Text> : null}
      {busy ? <View style={styles.busyRow}><ActivityIndicator color={colors.primary} size="small" /><Text accessibilityLiveRegion="polite" style={[styles.itemMeta, { color: colors.textMuted }]}>{t('approvalCenter.submitting')}</Text></View> : null}
      <View style={styles.detailActions}>
        {item.type === 'story-decision' ? <Pressable
          accessibilityRole="button"
          disabled={busy || sourceUnavailable || (!optionId && !response.trim())}
          onPress={() => center.decide(item, { optionId, response: response.trim() || undefined, retry: action?.error === 'STORY_RETRY_REQUIRED' })}
          style={[styles.primaryAction, { backgroundColor: colors.primary, opacity: busy || sourceUnavailable || (!optionId && !response.trim()) ? 0.45 : 1 }]}
        >
          <Text style={styles.primaryActionText}>{t(action?.error === 'STORY_RETRY_REQUIRED' ? 'approvalCenter.retryDecision' : 'approvalCenter.submit')}</Text>
        </Pressable> : <InlineActions
          disabled={busy || sourceUnavailable}
          item={item}
          onDecision={(decision) => center.decide(item, { decision })}
          onOpen={() => undefined}
        />}
      </View>
    </ScrollView>
  </View>;
}

function DetailFields({ item }: { item: ApprovalCenterItem }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const fields: [string, string | undefined][] = item.type === 'ai-session-approval' ? [
    [t('approvalCenter.field.instance'), item.instanceName],
    [t('approvalCenter.field.agent'), item.session.agent],
    [t('approvalCenter.field.session'), item.session.id],
    [t('approvalCenter.field.workspace'), item.session.cwd],
    [t('approvalCenter.field.context'), item.session.lastMessage || item.session.summary || item.session.userPrompt],
  ] : item.type === 'story-decision' ? [
    [t('approvalCenter.field.node'), item.story.ownerNodeId],
    [t('approvalCenter.field.story'), item.story.id],
    [t('approvalCenter.field.decision'), item.decision.id],
    [t('approvalCenter.field.question'), item.decision.question],
    [t('approvalCenter.field.context'), item.decision.context],
    [t('approvalCenter.field.revision'), String(item.decision.revision)],
  ] : item.type === 'operation-approval' ? [
    [t('approvalCenter.field.request'), item.request.id],
    [t('approvalCenter.field.operation'), t(OPERATION_LABEL_KEYS[item.request.operation])],
    [t('approvalCenter.field.target'), item.targetName ? `${item.targetName} (${item.request.targetId})` : item.request.targetId],
    [t('approvalCenter.field.expires'), item.request.expiresAt],
    ...(item.request.details ?? []).map((detail): [string, string] => {
      const key = DETAIL_LABEL_KEYS[detail.field];
      return [key ? t(key) : detail.field, detail.value];
    }),
  ] : item.type === 'device-trust' ? [
    [t('approvalCenter.field.request'), item.request.requestId],
    [t('approvalCenter.field.device'), `${item.request.device.name} (${item.request.device.platform})`],
    [t('approvalCenter.field.comparisonCode'), item.request.comparisonCode],
    [t('approvalCenter.field.fingerprint'), item.request.fingerprint],
    [t('approvalCenter.field.revision'), String(item.request.revision)],
    [t('approvalCenter.field.expires'), item.request.expiresAt],
  ] : [
    [t('approvalCenter.field.node'), item.nodeName ? `${item.nodeName} (${item.nodeId})` : item.nodeId],
    [t('approvalCenter.field.request'), item.request.requestId],
    [t('approvalCenter.field.controlPlane'), item.request.controlPlaneId],
    [t('approvalCenter.field.comparisonCode'), item.request.comparisonCode],
    [t('approvalCenter.field.fingerprint'), item.request.fingerprint],
    [t('approvalCenter.field.revision'), String(item.request.revision)],
    [t('approvalCenter.field.expires'), item.request.expiresAt],
  ];
  return <View style={styles.fields}>
    {fields.filter((field): field is [string, string] => Boolean(field[1])).map(([label, value]) => <View key={`${label}:${value}`} style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text selectable style={[styles.fieldValue, { color: colors.text }]}>{value}</Text>
    </View>)}
  </View>;
}

function StoryDecisionAnswer({ decision, onOption, onResponse, optionId, response }: {
  decision: Extract<ApprovalCenterItem, { type: 'story-decision' }>['decision'];
  onOption(value?: string): void;
  onResponse(value: string): void;
  optionId?: string;
  response: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <View style={styles.answer}>
    {decision.options?.map((option) => <Pressable
      accessibilityLabel={`${option.label}${option.description ? `, ${option.description}` : ''}`}
      accessibilityRole="radio"
      accessibilityState={{ checked: optionId === option.id }}
      key={option.id}
      onPress={() => { onOption(option.id); onResponse(''); }}
      style={[styles.option, { backgroundColor: optionId === option.id ? colors.primarySoft : colors.surface, borderColor: optionId === option.id ? colors.primary : colors.border }]}
    >
      <View style={[styles.radio, { borderColor: optionId === option.id ? colors.primary : colors.textMuted }]}>{optionId === option.id ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}</View>
      <View style={styles.headerCopy}><Text style={[styles.optionTitle, { color: colors.text }]}>{option.label}</Text>{option.description ? <Text style={[styles.optionDescription, { color: colors.textMuted }]}>{option.description}</Text> : null}</View>
    </Pressable>)}
    {decision.allowFreeText ? <TextInput
      accessibilityLabel={t('stories.decisionFreeTextPlaceholder')}
      multiline
      onChangeText={(value) => { onResponse(value); onOption(undefined); }}
      placeholder={t('stories.decisionFreeTextPlaceholder')}
      placeholderTextColor={colors.textPlaceholder}
      style={[styles.freeText, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
      textAlignVertical="top"
      value={response}
    /> : null}
  </View>;
}

function confirmDanger(label: string, cancelLabel: string, action: () => void) {
  Alert.alert(label, undefined, [
    { style: 'cancel', text: cancelLabel },
    { onPress: action, style: 'destructive', text: label },
  ]);
}

const styles = StyleSheet.create({
  actionError: { fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingBottom: 10 },
  answer: { gap: 10 },
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 930,
  },
  badge: { alignItems: 'center', borderRadius: 12, borderWidth: 2, justifyContent: 'center', minHeight: 22, minWidth: 22, paddingHorizontal: 5, position: 'absolute', right: -5, top: -5 },
  badgeText: { color: '#ffffff', fontSize: 12, fontVariant: ['tabular-nums'], fontWeight: '700', lineHeight: 16 },
  busyRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingBottom: 10, paddingHorizontal: 12 },
  detailActions: { gap: 10, marginTop: 8 },
  detailContent: { gap: 18, paddingHorizontal: 18, paddingTop: 18 },
  detailError: { fontSize: 13, lineHeight: 19 },
  detailHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 64, paddingHorizontal: 12, paddingVertical: 10 },
  detailRoot: { flex: 1 },
  diagnostics: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 9 },
  diagnosticText: { fontSize: 12, lineHeight: 16 },
  diagnosticTitle: { fontSize: 13, lineHeight: 17 },
  fab: { alignItems: 'center', borderRadius: APPROVAL_CENTER_FAB_SIZE / 2, elevation: 12, height: APPROVAL_CENTER_FAB_SIZE, justifyContent: 'center', position: 'absolute', shadowColor: '#000', shadowOffset: { height: 5, width: 0 }, shadowOpacity: 0.28, shadowRadius: 12, width: APPROVAL_CENTER_FAB_SIZE, zIndex: 950 },
  field: { gap: 4 },
  fieldLabel: { fontSize: 12, lineHeight: 17 },
  fieldValue: { fontSize: 14, lineHeight: 20 },
  fields: { gap: 14 },
  freeText: { borderRadius: 12, borderWidth: 1, fontSize: 15, lineHeight: 21, minHeight: 110, padding: 12 },
  headerCopy: { flex: 1, gap: 2 },
  iconButton: { alignItems: 'center', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
  inlineActions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 12, paddingHorizontal: 14 },
  inlineButton: { alignItems: 'center', borderRadius: 9, borderWidth: 1, flexBasis: 78, flexGrow: 1, justifyContent: 'center', minHeight: 38, paddingHorizontal: 14 },
  inlineButtonText: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  item: { borderBottomWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  itemHead: { alignItems: 'center', flexDirection: 'row', gap: 8, minWidth: 0 },
  itemMeta: { fontSize: 12, lineHeight: 17 },
  itemPressable: { gap: 4, paddingHorizontal: 14, paddingTop: 12 },
  itemSummary: { fontSize: 12, lineHeight: 17 },
  itemTitle: { fontSize: 14, lineHeight: 20 },
  kindBadge: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', flexShrink: 0, gap: 4, paddingHorizontal: 7, paddingVertical: 2 },
  kindText: { fontSize: 12, lineHeight: 16 },
  list: { flexShrink: 1 },
  listContent: { padding: 0 },
  option: { alignItems: 'flex-start', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: 52, padding: 12 },
  optionDescription: { fontSize: 13, lineHeight: 18 },
  optionTitle: { fontSize: 14, lineHeight: 19 },
  panel: { borderRadius: 14, borderWidth: 1, elevation: 14, overflow: 'hidden', position: 'absolute', shadowColor: '#000', shadowOffset: { height: 7, width: 0 }, shadowOpacity: 0.24, shadowRadius: 18, zIndex: 940 },
  panelHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 8 },
  panelSubtitle: { fontSize: 12, lineHeight: 17 },
  panelTitle: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  primaryAction: { alignItems: 'center', borderRadius: 12, justifyContent: 'center', minHeight: 48, paddingHorizontal: 16 },
  primaryActionText: { color: '#ffffff', fontSize: 15, fontWeight: '600', lineHeight: 20 },
  radio: { alignItems: 'center', borderRadius: 9, borderWidth: 1.5, height: 18, justifyContent: 'center', marginTop: 1, width: 18 },
  radioDot: { borderRadius: 5, height: 10, width: 10 },
  smallAction: { alignItems: 'center', borderRadius: 8, borderWidth: 1, justifyContent: 'center', minHeight: 36, paddingHorizontal: 9 },
  smallActionText: { fontSize: 12, lineHeight: 17 },
  sourceText: { flex: 1, fontSize: 12, lineHeight: 17 },
  visuallyHidden: { height: 1, opacity: 0, position: 'absolute', width: 1 },
});
