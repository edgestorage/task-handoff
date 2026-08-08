import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { useI18n } from '../../../../src/i18n';
export default function InstancesLayout() { const { t } = useI18n(); return <PrimaryTabStack title={t('nav.instances')} />; }
