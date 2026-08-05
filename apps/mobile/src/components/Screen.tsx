import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useMobileTheme } from './theme';

export function Screen({ children }: PropsWithChildren) {
  const { colors } = useMobileTheme();

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.content,
          { backgroundColor: colors.background },
        ]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    flexGrow: 1,
    gap: 16,
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
});
