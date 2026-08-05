import { Button, Host } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled as disabledModifier, frame, tint } from '@expo/ui/swift-ui/modifiers';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

export type NativeActionButtonProps = {
  compact?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  icon?: { android: AndroidSymbol; ios: SFSymbol };
  label: string;
  onPress(): void;
};

export function NativeActionButton({ compact, destructive, disabled, icon, label, onPress }: NativeActionButtonProps) {
  const modifiers = [
    buttonStyle(compact ? 'borderless' : destructive ? 'bordered' : 'borderedProminent'),
    controlSize(compact ? 'regular' : 'large'),
    tint(destructive ? '#ff3b30' : '#007aff'),
    ...(disabled ? [disabledModifier(true)] : []),
    ...(compact ? [] : [frame({ maxWidth: 10_000 })]),
  ];

  return (
    <Host
      matchContents={compact ? true : { vertical: true }}
      seedColor={destructive ? '#ff3b30' : '#007aff'}
      style={compact ? { alignSelf: 'flex-start' } : { alignSelf: 'stretch', minHeight: 50 }}
    >
      <Button
        label={label}
        modifiers={modifiers}
        onPress={onPress}
        role={destructive ? 'destructive' : 'default'}
        systemImage={icon?.ios}
      />
    </Host>
  );
}
