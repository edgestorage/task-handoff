import { Platform } from 'react-native';

import { useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useI18n } from '../../../../src/i18n';
import { StoryNodeFilterHeaderButton } from '../../../../src/stories/StoryNodeFilterHeaderButton';
import { useStoryInboxHeaderActions } from '../../../../src/stories/use-story-inbox-header-actions';

export default function StoriesLayout() {
  const { t } = useI18n();
  const { wide } = useMasterDetailLayout();
  const { canCreate, headerRight, headerRightItems, openNewStory } = useStoryInboxHeaderActions();
  return <PrimaryTabStack
    addAccessibilityLabel={canCreate ? t('stories.create') : undefined}
    headerShown={!(Platform.OS === 'ios' && wide)}
    onAdd={canCreate ? openNewStory : undefined}
    headerRight={headerRight}
    headerRightItems={headerRightItems}
    scopeControl={<StoryNodeFilterHeaderButton />}
    title={t('nav.stories')}
  />;
}
