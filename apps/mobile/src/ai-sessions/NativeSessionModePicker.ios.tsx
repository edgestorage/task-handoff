import { Host, Picker, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, pickerStyle, tag, tint } from '@expo/ui/swift-ui/modifiers';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { SessionDetailMode } from './SessionDetail';

export function NativeSessionModePicker({ mode, onChange }: { mode: SessionDetailMode; onChange(mode: SessionDetailMode): void }) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  return (
    <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ height: 36, width: 210 }}>
      <Picker label={t('sessions.sessionView')} modifiers={[pickerStyle('segmented'), tint(colors.primary), accessibilityLabel(t('sessions.sessionViewMode'))]} onSelectionChange={(value) => onChange(value as SessionDetailMode)} selection={mode}>
        <Text modifiers={[tag('conversation')]}>{t('sessions.conversation')}</Text>
        <Text modifiers={[tag('turn')]}>{t('sessions.turn')}</Text>
      </Picker>
    </Host>
  );
}
