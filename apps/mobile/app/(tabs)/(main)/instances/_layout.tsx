import { Platform } from 'react-native';

import { useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useI18n } from '../../../../src/i18n';

export default function InstancesLayout() {
  const { t } = useI18n();
  const { wide } = useMasterDetailLayout();
  return <PrimaryTabStack headerShown={!(Platform.OS === 'ios' && wide)} title={t('nav.instances')} />;
}
