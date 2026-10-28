import { Platform } from 'react-native';

import { useAppSessionInboxHeaderActions } from '../../../../src/app-sessions/use-app-session-inbox-header-actions';
import { useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useI18n } from '../../../../src/i18n';
export default function AppsLayout() {
  const { t } = useI18n();
  const { wide } = useMasterDetailLayout();
  const { headerRight, headerRightItems, openNewSession } = useAppSessionInboxHeaderActions();
  return <PrimaryTabStack
    addAccessibilityLabel={t('appSessions.newAccessibility')}
    headerShown={!(Platform.OS === 'ios' && wide)}
    headerRight={headerRight}
    headerRightItems={headerRightItems}
    onAdd={openNewSession}
    title={t('nav.appSessions')}
  />;
}
