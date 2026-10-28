import { Platform } from 'react-native';

import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { useI18n } from '../../../../src/i18n';
import { useAiSessionInboxHeaderActions } from '../../../../src/ai-sessions/use-ai-session-inbox-header';

export default function InboxLayout() {
  const { t } = useI18n();
  const { wide } = useMasterDetailLayout();
  const { headerRight, headerRightItems, openNewSession } = useAiSessionInboxHeaderActions();

  return <PrimaryTabStack
    addAccessibilityLabel={t('sessions.newAccessibility')}
    headerShown={!(Platform.OS === 'ios' && wide)}
    onAdd={openNewSession}
    headerRight={headerRight}
    headerRightItems={headerRightItems}
    title={t('nav.aiSessions')}
  />;
}
