import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import Swipeable from 'react-native-gesture-handler/Swipeable';

import { SystemIcon } from './SystemIcon';
import { useMobileTheme } from './theme';

export function SwipeToClose({ children, containerStyle, disabled = false, label, onClose }: {
  children: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  label: string;
  onClose(): void;
}) {
  const { colors } = useMobileTheme();
  return <Swipeable
    containerStyle={[styles.container, containerStyle]}
    dragOffsetFromRightEdge={12}
    enabled={!disabled}
    friction={1.5}
    overshootRight={false}
    renderRightActions={(_progress, _translation, controls) => <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={() => {
          controls.close();
          onClose();
        }}
        style={({ pressed }) => [styles.action, { backgroundColor: colors.error }, pressed && styles.pressed]}
      >
        <SystemIcon android="close" color="#ffffff" ios="xmark" size={18} />
        <Text style={styles.label}>{label}</Text>
      </Pressable>}
    rightThreshold={36}
  >{children}</Swipeable>;
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
  action: { alignItems: 'center', gap: 6, justifyContent: 'center', width: 84 },
  label: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.78 },
});
