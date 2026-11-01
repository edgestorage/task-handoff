import type { ApprovalCenterItem, ApprovalCenterSource } from '@task-handoff/control-plane-client';

import type { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/messages';

export type ApprovalTranslate = ReturnType<typeof useI18n>['t'];

const OPERATION_LABEL_KEYS: Record<Extract<ApprovalCenterItem, { type: 'operation-approval' }>['request']['operation'], MessageKey> = {
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

export function sourceLabel(source: ApprovalCenterSource, t: ApprovalTranslate) {
  switch (source) {
    case 'ai-session-approval': return t('approvalCenter.source.aiSession');
    case 'story-decision': return t('approvalCenter.source.storyDecision');
    case 'operation-approval': return t('approvalCenter.source.operation');
    case 'device-trust': return t('approvalCenter.source.deviceTrust');
    case 'node-control-plane-trust': return t('approvalCenter.source.nodeTrust');
  }
}

export function itemSource(item: ApprovalCenterItem) {
  return item.type;
}

export function itemTitle(item: ApprovalCenterItem, t: ApprovalTranslate) {
  switch (item.type) {
    case 'ai-session-approval': return item.session.title || item.session.userPrompt || item.session.id;
    case 'story-decision': return item.decision.question;
    case 'operation-approval': return t(OPERATION_LABEL_KEYS[item.request.operation]);
    case 'device-trust': return t((`deviceTrust.reason.${item.request.reason}`) as MessageKey);
    case 'node-control-plane-trust': return nodeTrustTitle(item.request.reason, t);
  }
}

export function itemSourceDetail(item: ApprovalCenterItem) {
  switch (item.type) {
    case 'ai-session-approval': return `${item.instanceName} · ${item.session.agent}`;
    case 'story-decision': return item.story.title;
    case 'operation-approval': return item.targetName || item.request.targetId;
    case 'device-trust': return item.request.device.name;
    case 'node-control-plane-trust': return item.nodeName || item.request.nodeHandle || item.nodeId;
  }
}

export function itemContextLines(item: ApprovalCenterItem, t: ApprovalTranslate) {
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

export function deviceRoleAvailable(item: Extract<ApprovalCenterItem, { type: 'device-trust' }>) {
  return item.roles.some((role) => role.roleId === item.request.cloudAccessRoleId && role.status === 'active');
}

export function actionErrorMessage(error: string | undefined, t: ApprovalTranslate) {
  if (error === 'OFFLINE') return t('approvalCenter.offline');
  if (error === 'SOURCE_UNAVAILABLE') return t('approvalCenter.sourceUnavailable');
  if (error === 'STORY_RETRY_REQUIRED') return t('approvalCenter.storyRetryRequired');
  if (error === 'REQUEST_RESULT_UNKNOWN') return t('approvalCenter.resultUnknown');
  return t('approvalCenter.requestFailed');
}

export type ApprovalActionSpec = {
  key: string;
  decision?: string;
  label: string;
  danger?: boolean;
  open?: boolean;
};

export function approvalActions(item: ApprovalCenterItem, t: ApprovalTranslate): ApprovalActionSpec[] {
  switch (item.type) {
    case 'ai-session-approval': return item.decisions.map((decision) => ({
      key: decision,
      decision,
      label: t(decision === 'allow' ? 'approvalCenter.allow' : decision === 'deny' ? 'approvalCenter.deny' : 'approvalCenter.skip'),
    }));
    case 'story-decision': return [{ key: 'open', label: t('approvalCenter.answer'), open: true }];
    case 'operation-approval': return [
      { key: 'approve', decision: 'approve', label: t('approvalCenter.approve') },
      { key: 'deny', decision: 'deny', label: t('approvalCenter.deny'), danger: true },
    ];
    case 'device-trust': return [
      { key: 'approve', decision: 'approve', label: t('approvalCenter.approve') },
      { key: 'reject', decision: 'reject', label: t('approvalCenter.reject'), danger: true },
    ];
    case 'node-control-plane-trust': return [
      { key: 'approve', decision: 'approve', label: t('approvalCenter.approve') },
      { key: 'reject', decision: 'reject', label: t('approvalCenter.reject'), danger: true },
    ];
  }
}

export type ApprovalDetailField = {
  key: string;
  label: string;
  value: string;
};

export function approvalDetailFields(item: ApprovalCenterItem, t: ApprovalTranslate): ApprovalDetailField[] {
  const fields: [string, string, string | undefined][] = item.type === 'ai-session-approval' ? [
    ['instance', t('approvalCenter.field.instance'), item.instanceName],
    ['agent', t('approvalCenter.field.agent'), item.session.agent],
    ['session', t('approvalCenter.field.session'), item.session.id],
    ['workspace', t('approvalCenter.field.workspace'), item.session.cwd],
    ['context', t('approvalCenter.field.context'), item.session.lastMessage || item.session.summary || item.session.userPrompt],
  ] : item.type === 'story-decision' ? [
    ['node', t('approvalCenter.field.node'), item.story.ownerNodeId],
    ['story', t('approvalCenter.field.story'), item.story.id],
    ['decision', t('approvalCenter.field.decision'), item.decision.id],
    ['question', t('approvalCenter.field.question'), item.decision.question],
    ['context', t('approvalCenter.field.context'), item.decision.context],
    ['revision', t('approvalCenter.field.revision'), String(item.decision.revision)],
  ] : item.type === 'operation-approval' ? [
    ['request', t('approvalCenter.field.request'), item.request.id],
    ['operation', t('approvalCenter.field.operation'), t(OPERATION_LABEL_KEYS[item.request.operation])],
    ['target', t('approvalCenter.field.target'), item.targetName ? `${item.targetName} (${item.request.targetId})` : item.request.targetId],
    ['expires', t('approvalCenter.field.expires'), item.request.expiresAt],
    ...(item.request.details ?? []).map((detail): [string, string, string] => {
      const key = DETAIL_LABEL_KEYS[detail.field];
      return [detail.field, key ? t(key) : detail.field, detail.value];
    }),
  ] : item.type === 'device-trust' ? [
    ['request', t('approvalCenter.field.request'), item.request.requestId],
    ['device', t('approvalCenter.field.device'), `${item.request.device.name} (${item.request.device.platform})`],
    ['comparisonCode', t('approvalCenter.field.comparisonCode'), item.request.comparisonCode],
    ['fingerprint', t('approvalCenter.field.fingerprint'), item.request.fingerprint],
    ['revision', t('approvalCenter.field.revision'), String(item.request.revision)],
    ['expires', t('approvalCenter.field.expires'), item.request.expiresAt],
  ] : [
    ['node', t('approvalCenter.field.node'), item.nodeName ? `${item.nodeName} (${item.nodeId})` : item.nodeId],
    ['request', t('approvalCenter.field.request'), item.request.requestId],
    ['controlPlane', t('approvalCenter.field.controlPlane'), item.request.controlPlaneId],
    ['comparisonCode', t('approvalCenter.field.comparisonCode'), item.request.comparisonCode],
    ['fingerprint', t('approvalCenter.field.fingerprint'), item.request.fingerprint],
    ['revision', t('approvalCenter.field.revision'), String(item.request.revision)],
    ['expires', t('approvalCenter.field.expires'), item.request.expiresAt],
  ];
  return fields
    .filter((field): field is [string, string, string] => Boolean(field[2]))
    .map(([key, label, value]) => ({ key, label, value }));
}

function nodeTrustTitle(reason: string | undefined, t: ApprovalTranslate) {
  if (reason === 'key-changed') return t('approvalCenter.nodeTrust.keyChanged');
  if (reason === 'access-context-changed') return t('approvalCenter.nodeTrust.accessContextChanged');
  return t('approvalCenter.nodeTrust.firstSeen');
}

function formatExpiryRelative(value: string | undefined, t: ApprovalTranslate) {
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
