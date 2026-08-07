import { router } from 'expo-router';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useI18n } from '../../../../src/i18n';
export default function AppsLayout() {
  const { t } = useI18n();
  return <PrimaryTabStack addAccessibilityLabel={t('appSessions.newAccessibility')} onAdd={() => router.push('/app-sessions/new')} title={t('nav.appSessions')} />;
}
