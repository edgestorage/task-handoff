import { router } from 'expo-router';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useI18n } from '../../../../src/i18n';

export default function StoriesLayout() {
  const { t } = useI18n();
  return <PrimaryTabStack addAccessibilityLabel={t('stories.create')} onAdd={() => router.push('/stories/new' as never)} title={t('nav.stories')} />;
}
