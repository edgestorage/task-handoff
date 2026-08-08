import { router } from 'expo-router';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useI18n } from '../../../../src/i18n';

export default function InboxLayout() {
  const { t } = useI18n();
  return <PrimaryTabStack addAccessibilityLabel={t('sessions.newAccessibility')} onAdd={() => router.push('/sessions/new')} title={t('nav.aiSessions')} />;
}
