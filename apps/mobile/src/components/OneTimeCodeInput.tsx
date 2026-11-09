import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { normalizeOneTimeCode } from './one-time-code';
import { useMobileTheme } from './theme';

export { normalizeOneTimeCode } from './one-time-code';

export function OneTimeCodeInput({
  accessibilityLabel,
  autoFocus = false,
  disabled = false,
  focusKey = 0,
  length = 6,
  onChangeText,
  onComplete,
  value,
}: {
  accessibilityLabel: string;
  autoFocus?: boolean;
  disabled?: boolean;
  focusKey?: number;
  length?: number;
  onChangeText: (value: string) => void;
  onComplete?: (value: string) => void;
  value: string;
}) {
  const { colors } = useMobileTheme();
  const input = useRef<TextInput>(null);
  const previousFocusKey = useRef(focusKey);
  const [focused, setFocused] = useState(false);
  const normalized = normalizeOneTimeCode(value, length);
  const activeIndex = Math.min(normalized.length, length - 1);

  useEffect(() => {
    if (focusKey === previousFocusKey.current) return;
    previousFocusKey.current = focusKey;
    if (!disabled) input.current?.focus();
  }, [disabled, focusKey]);

  return (
    <Pressable
      accessible={false}
      disabled={disabled}
      onPress={() => input.current?.focus()}
      style={styles.container}
      testID="one-time-code-boxes"
    >
      <TextInput
        accessibilityLabel={accessibilityLabel}
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        caretHidden
        editable={!disabled}
        inputMode="numeric"
        keyboardType="number-pad"
        onBlur={() => setFocused(false)}
        onChangeText={(next) => {
          const normalizedNext = normalizeOneTimeCode(next, length);
          onChangeText(normalizedNext);
          if (normalizedNext.length === length && normalized.length < length) onComplete?.(normalizedNext);
        }}
        onFocus={() => setFocused(true)}
        ref={input}
        style={styles.hiddenInput}
        textContentType="oneTimeCode"
        value={normalized}
      />
      <View accessibilityElementsHidden accessible={false} style={styles.boxRow}>
        {Array.from({ length }, (_, index) => {
          const active = focused && index === activeIndex && normalized.length < length;
          const filled = index < normalized.length;
          return (
            <View
              key={index}
              style={[
                styles.box,
                { backgroundColor: colors.surface, borderColor: active ? colors.primary : colors.border },
                active && styles.activeBox,
              ]}
            >
              <Text style={[styles.digit, { color: colors.text }]}>{normalized[index] ?? ''}</Text>
              {active && !filled ? <View style={[styles.cursor, { backgroundColor: colors.primary }]} /> : null}
            </View>
          );
        })}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative' },
  hiddenInput: { height: 1, left: 0, opacity: 0.01, position: 'absolute', top: 0, width: 1 },
  boxRow: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  box: { alignItems: 'center', borderRadius: 12, borderWidth: 1, height: 56, justifyContent: 'center', maxWidth: 52, minWidth: 42, flex: 1 },
  activeBox: { borderWidth: 2 },
  digit: { fontSize: 24, fontVariant: ['tabular-nums'], fontWeight: '600', lineHeight: 30 },
  cursor: { borderRadius: 1, height: 26, position: 'absolute', width: 2 },
});
