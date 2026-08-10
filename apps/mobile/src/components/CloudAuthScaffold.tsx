import type { PropsWithChildren, ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { Screen } from './Screen';
import { SystemIcon } from './SystemIcon';
import { useMobileTheme } from './theme';

export function CloudAuthScaffold({ children, description, error, title }: PropsWithChildren<{ description: string; error?: string; title: string }>) {
  const { colors } = useMobileTheme();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill} testID="cloud-auth-keyboard-area">
      <Screen alwaysBounceVertical={false} automaticallyAdjustKeyboardInsets={false} contentContainerStyle={styles.screen} testID="cloud-auth-scroll">
        <View style={styles.content}>
        <View style={styles.hero}>
          <Image accessibilityIgnoresInvertColors source={require('../../assets/icon.png')} style={styles.brandIcon} />
          <View style={styles.heroCopy}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text>
            <Text style={[styles.description, { color: colors.textMuted }]}>{description}</Text>
          </View>
        </View>
        {error ? (
          <View accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, borderColor: colors.error }]}>
            <SystemIcon android="error" color={colors.error} ios="exclamationmark.circle.fill" size={18} />
            <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
          </View>
        ) : null}
          {children}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

export function CloudAuthLabel({ children }: { children: ReactNode }) {
  const { colors } = useMobileTheme();
  return <Text style={[styles.label, { color: colors.textMuted }]}>{children}</Text>;
}

export function CloudAuthHint({ children }: { children: ReactNode }) {
  const { colors } = useMobileTheme();
  return <Text style={[styles.hint, { color: colors.textMuted }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { justifyContent: 'center', paddingVertical: 24 },
  content: { alignSelf: 'center', gap: 18, maxWidth: 440, width: '100%' },
  hero: { alignItems: 'center', gap: 14 },
  brandIcon: { borderRadius: 15, height: 58, width: 58 },
  heroCopy: { alignItems: 'center', gap: 7 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.7, lineHeight: 34, textAlign: 'center' },
  description: { fontSize: 14, lineHeight: 20, maxWidth: 360, textAlign: 'center' },
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  hint: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  error: { alignItems: 'flex-start', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 9, paddingHorizontal: 12, paddingVertical: 11 },
  errorText: { flex: 1, fontSize: 13, lineHeight: 19 },
});
