import { Host, Picker, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, pickerStyle, tag, tint } from '@expo/ui/swift-ui/modifiers';

import { useMobileTheme } from '../components/theme';
import type { SessionDetailMode } from './SessionDetail';

export function NativeSessionModePicker({ mode, onChange }: { mode: SessionDetailMode; onChange(mode: SessionDetailMode): void }) {
  const { colors, dark } = useMobileTheme();
  return (
    <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ height: 36, width: 210 }}>
      <Picker label="Session view" modifiers={[pickerStyle('segmented'), tint(colors.primary), accessibilityLabel('Session view mode')]} onSelectionChange={(value) => onChange(value as SessionDetailMode)} selection={mode}>
        <Text modifiers={[tag('conversation')]}>Conversation</Text>
        <Text modifiers={[tag('turn')]}>Turn</Text>
      </Picker>
    </Host>
  );
}
