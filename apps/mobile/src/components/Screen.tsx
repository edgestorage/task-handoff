import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useMobileTheme } from './theme';

type ScreenProps = PropsWithChildren<{
  alwaysBounceVertical?: boolean;
  automaticallyAdjustKeyboardInsets?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}>;

export function Screen({ alwaysBounceVertical, automaticallyAdjustKeyboardInsets = true, children, contentContainerStyle, testID }: ScreenProps) {
  const { colors } = useMobileTheme();

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <ScrollView
        alwaysBounceVertical={alwaysBounceVertical}
        automaticallyAdjustKeyboardInsets={automaticallyAdjustKeyboardInsets}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.content,
          { backgroundColor: colors.background },
          contentContainerStyle,
        ]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        testID={testID}
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
