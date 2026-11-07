import type { Translate } from '../i18n';

export type RepositoryFailureKind = 'permission' | 'unavailable' | 'not-found' | 'unknown';

export function repositoryFailureKind(error: unknown): RepositoryFailureKind {
  const record = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; statusCode?: unknown } : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const status = Number(record.status ?? record.statusCode);
  if (code === 'CLOUD_ROUTE_FORBIDDEN' || code === 'CONTROL_PLANE_FORBIDDEN' || status === 401 || status === 403) return 'permission';
  if (code === 'CONTROL_PLANE_RESOURCE_NOT_VISIBLE' || status === 404) return 'not-found';
  if (status >= 500 || /NETWORK|CONNECT|RELAY|OFFLINE|UNAVAILABLE|UNREACHABLE|TIMEOUT|FAILED/.test(code)) return 'unavailable';
  return 'unknown';
}

export function repositoryFailureCopy(kind: RepositoryFailureKind, t: Translate) {
  return {
    permission: {
      icon: 'lock-closed-outline' as const,
      title: t('sessionResources.errorPermissionTitle'),
      detail: t('sessionResources.errorPermissionDetail'),
    },
    unavailable: {
      icon: 'cloud-offline-outline' as const,
      title: t('sessionResources.errorOfflineTitle'),
      detail: t('sessionResources.errorOfflineDetail'),
    },
    'not-found': {
      icon: 'folder-open-outline' as const,
      title: t('sessionResources.errorNotFoundTitle'),
      detail: t('sessionResources.errorNotFoundDetail'),
    },
    unknown: {
      icon: 'alert-circle-outline' as const,
      title: t('sessionResources.errorGenericTitle'),
      detail: t('sessionResources.errorGenericDetail'),
    },
  }[kind];
}
