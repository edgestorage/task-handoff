import { router, Stack } from 'expo-router';
import type { ControlPlaneTriggerTemplateInput } from '@task-handoff/protocol/triggers';

import { useI18n } from '../../src/i18n';
import { TriggerForm } from '../../src/triggers/TriggerForm';
import { useActiveTriggers } from '../../src/triggers/use-active-triggers';

export default function NewTriggerRoute() {
  const { t } = useI18n();
  const triggers = useActiveTriggers();
  const submit = async (input: ControlPlaneTriggerTemplateInput) => { await triggers.create(input); router.back(); };
  return <><Stack.Screen options={{ title: t('triggers.create') }} /><TriggerForm onSubmit={submit} submitLabel={t('triggers.create')} /></>;
}
