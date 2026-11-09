import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { useMobileTheme } from '../components/theme';

export function SettingsSection({ children, footer, testID, title }: { children: ReactNode; footer?: string; testID?: string; title?: string }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.section} testID={testID}>
      {title ? <Text accessibilityRole="header" style={[styles.sectionLabel, { color: colors.textMuted }]}>{title}</Text> : null}
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>
      {footer ? <Text style={[styles.footnote, { color: colors.textMuted }]}>{footer}</Text> : null}
    </View>
  );
}

export function ValueRow({ color, icon, label, value }: { color?: string; icon: IconName; label: string; value: string }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.row}>
      <RowIcon icon={icon}/>
      <Text style={[styles.rowLabel, styles.grow, { color: colors.text }]}>{label}</Text>
      <Text numberOfLines={1} selectable style={[styles.rowValue, { color: color ?? colors.textMuted }]}>{value}</Text>
    </View>
  );
}

export function FieldRow({ children, icon }: { children: ReactNode; icon: IconName }) {
  return <View style={styles.row}>
    <RowIcon icon={icon}/>
    <View style={styles.fieldCopy}>{children}</View>
  </View>;
}

export function ActionRow({ destructive = false, detail, disabled = false, icon, label, onPress }: {
  destructive?: boolean;
  detail?: string;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onPress(): void;
}) {
  const { colors } = useMobileTheme();
  const tint = disabled ? colors.textMuted : destructive ? colors.error : colors.primary;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && !disabled && { backgroundColor: colors.surfaceHover }, disabled && styles.disabled]}
    >
      <RowIcon icon={icon} tint={tint}/>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowLabel, { color: tint }]}>{label}</Text>
        {detail ? <Text style={[styles.rowDetail, { color: colors.textMuted }]}>{detail}</Text> : null}
      </View>
      <Icon color={colors.textMuted} name="chevron-forward" size={12}/>
    </Pressable>
  );
}

export function CommandRow({ destructive = false, detail, disabled = false, icon, label, onPress, testID }: {
  destructive?: boolean;
  detail?: string;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onPress(): void;
  testID?: string;
}) {
  const { colors } = useMobileTheme();
  const tint = disabled ? colors.textMuted : destructive ? colors.error : colors.primary;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && !disabled && { backgroundColor: colors.surfaceHover }, disabled && styles.disabled]}
      testID={testID}
    >
      <RowIcon icon={icon} tint={tint}/>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowLabel, { color: tint }]}>{label}</Text>
        {detail ? <Text style={[styles.rowDetail, { color: colors.textMuted }]}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

export function TrailingActionRow({ actionLabel, accessibilityLabel, destructive = false, detail, disabled = false, icon, label, onAction }: {
  actionLabel: string;
  accessibilityLabel: string;
  destructive?: boolean;
  detail?: string;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onAction(): void;
}) {
  const { colors } = useMobileTheme();
  return (
    <View style={[styles.row, disabled && styles.disabled]}>
      <RowIcon icon={icon}/>
      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
        {detail ? <Text numberOfLines={1} style={[styles.rowDetail, { color: colors.textMuted }]}>{detail}</Text> : null}
      </View>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        onPress={onAction}
        style={({ pressed }) => [styles.trailingAction, pressed && !disabled && styles.pressed]}
      >
        <Text style={[styles.trailingActionLabel, { color: destructive ? colors.error : colors.primary }]}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

export function SettingsDivider() {
  const { colors } = useMobileTheme();
  return <View style={[styles.divider, { backgroundColor: colors.border }]}/>;
}

function RowIcon({ icon, tint }: { icon: IconName; tint?: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.rowIcon}><Icon color={tint ?? colors.textMuted} name={icon} size={18}/></View>;
}

const styles = StyleSheet.create({
  section: { gap: 7 },
  sectionLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.4, marginLeft: 14 },
  group: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 45 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 11, minHeight: 52, paddingHorizontal: 14 },
  rowIcon: { alignItems: 'center', width: 20 },
  rowCopy: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  grow: { flex: 1 },
  rowDetail: { fontSize: 12, lineHeight: 17 },
  rowValue: { flexShrink: 1, fontSize: 13, textAlign: 'right' },
  fieldCopy: { flex: 1 },
  trailingAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  trailingActionLabel: { fontSize: 15, fontWeight: '600' },
  footnote: { fontSize: 12, lineHeight: 17, marginHorizontal: 14 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
