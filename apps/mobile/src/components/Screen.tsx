import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useMobileTheme } from './theme';

type ScreenProps = PropsWithChildren<{
  alwaysBounceVertical?: boolean;
}>;

export function Screen({ alwaysBounceVertical, children }: ScreenProps) {
  const { colors } = useMobileTheme();

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <ScrollView
        alwaysBounceVertical={alwaysBounceVertical}
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
