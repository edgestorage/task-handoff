import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  adaptiveContentContainerStyle,
  useAdaptiveContentLayout,
} from './adaptive-layout';
import { useMobileTheme } from './theme';

type ScreenProps = PropsWithChildren<{
  alwaysBounceVertical?: boolean;
  automaticallyAdjustKeyboardInsets?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  maxContentWidth?: number;
  testID?: string;
}>;

export function Screen({ alwaysBounceVertical, automaticallyAdjustKeyboardInsets = true, children, contentContainerStyle, maxContentWidth, testID }: ScreenProps) {
  const { colors } = useMobileTheme();
  const adaptive = useAdaptiveContentLayout(maxContentWidth);

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <ScrollView
        alwaysBounceVertical={alwaysBounceVertical}
        automaticallyAdjustKeyboardInsets={automaticallyAdjustKeyboardInsets}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={adaptiveContentContainerStyle([
          styles.content,
          { backgroundColor: colors.background },
          contentContainerStyle,
        ], adaptive.contentInsets)}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        scrollIndicatorInsets={adaptive.scrollIndicatorInsets}
        style={styles.fill}
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
