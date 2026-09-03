import { router } from 'expo-router';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../../../../src/i18n';

export default function StoriesLayout() {
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  return <PrimaryTabStack
    addAccessibilityLabel={runtime.storyCapability ? t('stories.create') : undefined}
    onAdd={runtime.storyCapability ? () => router.push('/stories/new' as never) : undefined}
    title={t('nav.stories')}
  />;
}
