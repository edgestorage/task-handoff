import type { MobileControlPlaneRuntimePhase } from '../control-plane/use-mobile-control-plane-runtime';
import { useI18n, type Translate } from '../i18n';
import type { MessageKey } from '../i18n/messages';
import { useAdaptiveContentLayout } from './adaptive-layout';
import { LoadingState } from './LoadingState';
import { useMobileTheme } from './theme';

export type InitialSyncResource = 'aiSessions' | 'stories' | 'appSessions';

export type InitialSyncConnection = {
  phase: MobileControlPlaneRuntimePhase;
  relay?: boolean;
};

const resourceLabels: Record<InitialSyncResource, { item: MessageKey; plural: MessageKey }> = {
  aiSessions: { item: 'nav.aiSession', plural: 'nav.aiSessions' },
  appSessions: { item: 'appSessions.singular', plural: 'nav.appSessions' },
  stories: { item: 'stories.singular', plural: 'nav.stories' },
};

export function InitialSyncLoading({
  connection,
  resource,
  testID,
}: {
  connection?: InitialSyncConnection;
  resource: InitialSyncResource;
  testID?: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const adaptive = useAdaptiveContentLayout();
  const labels = resourceLabels[resource];
  const resourceName = t(labels.plural);
  const copy = initialLoadingCopy(connection, resourceName, t(labels.item), t);
  return <LoadingState
    accessibilityLabel={t('common.loading.accessibility', { resource: resourceName })}
    description={copy.description}
    style={[adaptive.contentStyle, { backgroundColor: colors.background }]}
    testID={testID}
    title={copy.title}
  />;
}

function initialLoadingCopy(connection: InitialSyncConnection | undefined, resource: string, item: string, t: Translate) {
  if (connection?.phase === 'verifying') return connection.relay
    ? { title: t('common.loading.connectingRelay'), description: t('common.loading.connectingDescription', { resource }) }
    : { title: t('common.loading.connectingControlPlane'), description: t('common.loading.connectingDescription', { resource }) };
  if (connection?.phase === 'reconnecting') return connection.relay
    ? { title: t('common.loading.reconnectingRelay'), description: t('common.loading.reconnectingDescription', { resource }) }
    : { title: t('common.loading.reconnectingControlPlane'), description: t('common.loading.reconnectingDescription', { resource }) };
  if (!connection?.phase || connection.phase === 'idle') return {
    title: t('common.loading.preparing', { resource }),
    description: t('common.loading.preparingDescription'),
  };
  return {
    title: t('common.loading.syncing', { resource }),
    description: t('common.loading.syncingDescription', { item }),
  };
}
