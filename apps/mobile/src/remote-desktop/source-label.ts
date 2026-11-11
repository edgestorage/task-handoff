import type { useI18n } from '../i18n';
import type { PersistedCaptureTarget } from './preferences';

type Translate = ReturnType<typeof useI18n>['t'];

export function sourceKindLabel(kind: string, t: Translate) {
  if (kind === 'display') return t('remoteDesktop.entireDesktop');
  if (kind === 'window') return t('remoteDesktop.singleWindow');
  if (kind === 'application') return t('remoteDesktop.applicationSource');
  if (kind === 'region') return t('remoteDesktop.customRegionSource');
  return kind;
}

export function sourceTargetLabel(target: PersistedCaptureTarget, t: Translate) {
  return target.title?.trim() || sourceKindLabel(target.kind, t);
}
