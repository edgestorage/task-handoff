import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Swipeable from 'react-native-gesture-handler/Swipeable';

import { Icon } from './Icon';
import type { SwipeAction } from './SwipeActionList.types';
import { useMobileTheme } from './theme';

const ACTION_SEAM_WIDTH = 20;

export function SwipeActions({ actions, children, containerStyle }: {
  actions: readonly SwipeAction[];
  children: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const { colors } = useMobileTheme();
  const enabled = actions.some((action) => !action.disabled);
  const firstAction = actions[0];
  const seamColor = firstAction?.backgroundColor ?? (firstAction?.tone === 'primary' ? colors.primary : colors.error);
  return <Swipeable
    containerStyle={[styles.container, containerStyle]}
    dragOffsetFromRightEdge={12}
    enabled={enabled}
    friction={1.5}
    overshootRight={false}
    renderRightActions={(_progress, _translation, controls) => <View style={styles.actions}>
      <View pointerEvents="none" style={[styles.actionSeam, { backgroundColor: seamColor }]} />
      {actions.map((action, index) => {
        const backgroundColor = action.backgroundColor ?? (action.tone === 'primary' ? colors.primary : colors.error);
        return <Pressable
          accessibilityLabel={action.label}
          accessibilityRole="button"
          accessibilityState={{ disabled: Boolean(action.disabled) }}
          disabled={action.disabled}
          key={`${action.label}:${index}`}
          onPress={() => {
            controls.close();
            action.onPress();
          }}
          style={({ pressed }) => [styles.action, { backgroundColor }, action.disabled && styles.disabled, pressed && styles.pressed]}
        >
          <Icon color="#ffffff" name={action.icon ?? 'close'} size={16} />
          <View style={styles.labelBox}>
            <Text ellipsizeMode="tail" numberOfLines={2} style={styles.label}>{action.label}</Text>
          </View>
        </Pressable>;
      })}
    </View>}
    rightThreshold={36}
  >{children}</Swipeable>;
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
  actions: { flexDirection: 'row', position: 'relative' },
  actionSeam: { bottom: 0, left: -ACTION_SEAM_WIDTH, position: 'absolute', top: 0, width: ACTION_SEAM_WIDTH },
  action: { alignItems: 'center', gap: 4, justifyContent: 'center', paddingHorizontal: 4, width: 84 },
  disabled: { opacity: 0.5 },
  labelBox: { alignItems: 'center', justifyContent: 'center', minHeight: 30 },
  label: { color: '#ffffff', fontSize: 12, fontWeight: '600', lineHeight: 15, textAlign: 'center' },
  pressed: { opacity: 0.78 },
});
