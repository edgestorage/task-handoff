import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SystemIcon } from './SystemIcon';
import { useMobileTheme } from './theme';

export type MobileToastInput = {
  detail?: string;
  durationMs?: number;
  title: string;
  tone?: 'error' | 'success' | 'warning';
};

type MobileToastMessage = MobileToastInput & { id: number };
type MobileToastContextValue = { show(input: MobileToastInput): void };

const Context = createContext<MobileToastContextValue>({ show: () => undefined });
const DEFAULT_DURATION_MS = 4_500;

export function MobileToastProvider({ children }: { children: ReactNode }) {
  const { colors } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const sequence = useRef(0);
  const [progress] = useState(() => new Animated.Value(0));
  const [toast, setToast] = useState<MobileToastMessage>();

  const dismiss = useCallback((id: number) => {
    Animated.timing(progress, { duration: 160, toValue: 0, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setToast((current) => current?.id === id ? undefined : current);
    });
  }, [progress]);
  const show = useCallback((input: MobileToastInput) => {
    setToast((current) => {
      if (current?.title === input.title && current.detail === input.detail && current.tone === input.tone) return current;
      return { ...input, id: ++sequence.current };
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    progress.setValue(0);
    Animated.spring(progress, { damping: 22, mass: 0.7, stiffness: 260, toValue: 1, useNativeDriver: true }).start();
    const timer = setTimeout(() => dismiss(toast.id), toast.durationMs ?? DEFAULT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [dismiss, progress, toast]);

  const value = useMemo(() => ({ show }), [show]);
  const tone = toast?.tone ?? 'error';
  const foreground = tone === 'error' ? colors.error : tone === 'warning' ? colors.noticeText : colors.sessionActive;
  const background = tone === 'error' ? colors.errorSoft : tone === 'warning' ? colors.notice : colors.sessionActiveSoft;
  const icon = tone === 'error'
    ? { android: 'error' as const, ios: 'xmark.circle.fill' as const }
    : tone === 'warning'
      ? { android: 'warning' as const, ios: 'exclamationmark.triangle.fill' as const }
      : { android: 'check_circle' as const, ios: 'checkmark.circle.fill' as const };

  return <Context.Provider value={value}>
    <View style={styles.root}>
      {children}
      {toast ? <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[
            styles.position,
            {
              opacity: progress,
              top: Math.max(insets.top, 8) + 8,
              transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
            },
          ]}
        >
          <Pressable
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            onPress={() => dismiss(toast.id)}
            style={[styles.toast, { backgroundColor: background, borderColor: foreground }]}
            testID="mobile-toast"
          >
            <SystemIcon android={icon.android} color={foreground} ios={icon.ios} size={20} />
            <View style={styles.copy}>
              <Text style={[styles.title, { color: foreground }]}>{toast.title}</Text>
              {toast.detail ? <Text numberOfLines={3} style={[styles.detail, { color: colors.text }]}>{toast.detail}</Text> : null}
            </View>
          </Pressable>
        </Animated.View>
      </View> : null}
    </View>
  </Context.Provider>;
}

export function useMobileToast() {
  return useContext(Context);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  position: { alignItems: 'center', left: 16, position: 'absolute', right: 16, zIndex: 1000 },
  toast: { alignItems: 'flex-start', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, elevation: 8, flexDirection: 'row', gap: 10, maxWidth: 520, paddingHorizontal: 14, paddingVertical: 12, shadowColor: '#000', shadowOffset: { height: 3, width: 0 }, shadowOpacity: 0.18, shadowRadius: 10, width: '100%' },
  copy: { flex: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  detail: { fontSize: 13, lineHeight: 18 },
});
