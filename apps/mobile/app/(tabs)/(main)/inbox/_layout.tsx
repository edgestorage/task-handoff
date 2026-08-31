import { router } from 'expo-router';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useI18n } from '../../../../src/i18n';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';

export default function InboxLayout() {
  const { t } = useI18n();
  const { scope } = useInstanceScope();
  return <PrimaryTabStack
    addAccessibilityLabel={t('sessions.newAccessibility')}
    onAdd={() => router.push(scope.kind === 'instance'
      ? { pathname: '/sessions/new', params: { instanceId: scope.instanceId } }
      : '/sessions/new')}
    title={t('nav.aiSessions')}
  />;
}
