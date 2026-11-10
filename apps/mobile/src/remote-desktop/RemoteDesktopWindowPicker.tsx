import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { RemoteDesktopCapabilities, DesktopWindow } from '@task-handoff/protocol/remote-desktop';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { PersistedCaptureTarget } from './preferences';

type Props = {
  capability?: RemoteDesktopCapabilities;
  loadWindows(signal?: AbortSignal): Promise<DesktopWindow[]>;
  onClose(): void;
  onSelect(target: PersistedCaptureTarget): void;
  target: PersistedCaptureTarget;
  visible: boolean;
};

export function RemoteDesktopWindowPicker({ capability, loadWindows, onClose, onSelect, target, visible }: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [windows, setWindows] = useState<DesktopWindow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const available = capability?.windowCapture.available === true;

  const refresh = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted) return;
    setLoading(true);
    setError(false);
    try {
      const items = await loadWindows(signal);
      if (!signal.aborted) setWindows(items);
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [loadWindows]);

  const beginLoad = useCallback(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void refresh(controller.signal).finally(() => {
      if (requestRef.current === controller) requestRef.current = undefined;
    });
  }, [refresh]);

  useEffect(() => {
    if (visible) return;
    requestRef.current?.abort();
    requestRef.current = undefined;
  }, [visible]);
  useEffect(() => () => { requestRef.current?.abort(); }, []);

  const selectTarget = (next: PersistedCaptureTarget) => {
    onSelect(next);
    onClose();
  };

  return <Modal animationType="slide" onRequestClose={onClose} onShow={() => { if (available) beginLoad(); }} presentationStyle="pageSheet" visible={visible}>
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <Pressable accessibilityLabel={t('common.cancel')} accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
          <Text style={[styles.headerAction, { color: colors.primary }]}>{t('common.cancel')}</Text>
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{t('remoteDesktop.chooseWindow')}</Text>
        <View style={styles.headerButton} />
      </View>
      <Text style={[styles.hint, { color: colors.textMuted }]}>{t('remoteDesktop.windowPickerHint')}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ selected: target.kind === 'display' }} onPress={() => selectTarget({ kind: 'display' })} style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: target.kind === 'display' ? colors.primary : colors.border }, pressed && styles.pressed]}>
        <View style={[styles.icon, { backgroundColor: colors.primarySoft }]}><Icon color={colors.primary} name="desktop-outline" size={21} /></View>
        <View style={styles.copy}><Text style={[styles.rowTitle, { color: colors.text }]}>{t('remoteDesktop.entireDesktop')}</Text></View>
        {target.kind === 'display' ? <Icon color={colors.primary} name="checkmark-circle" size={22} /> : null}
      </Pressable>
      <View style={styles.listHeader}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('remoteDesktop.singleWindow')}</Text>
        {available ? <Pressable accessibilityLabel={t('remoteDesktop.refreshWindows')} accessibilityRole="button" disabled={loading} onPress={() => {
          beginLoad();
        }} style={({ pressed }) => [styles.refresh, pressed && styles.pressed]}>
          {loading ? <ActivityIndicator color={colors.primary} size="small" /> : <Icon color={colors.primary} name="refresh" size={18} />}
        </Pressable> : null}
      </View>
      {!available ? <View style={styles.state}><Text style={[styles.stateText, { color: colors.textMuted }]}>{t('remoteDesktop.windowCaptureUnavailable')}</Text></View>
        : loading && !windows.length ? <View style={styles.state}><ActivityIndicator color={colors.primary} /><Text style={[styles.stateText, { color: colors.textMuted }]}>{t('remoteDesktop.loadingWindows')}</Text></View>
          : error ? <View style={styles.state}><Text style={[styles.stateText, { color: colors.error }]}>{t('remoteDesktop.errorGeneric')}</Text></View>
            : !windows.length ? <View style={styles.state}><Text style={[styles.stateText, { color: colors.textMuted }]}>{t('remoteDesktop.noWindows')}</Text></View>
              : <FlatList data={windows} keyExtractor={(item) => item.windowRef} contentContainerStyle={styles.list} renderItem={({ item }) => {
                const selected = target.kind === 'window' && target.windowRef === item.windowRef;
                return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !item.capturable, selected }} disabled={!item.capturable} onPress={() => selectTarget({ kind: 'window', windowRef: item.windowRef, ...(item.title ? { title: item.title } : {}), ...(item.applicationName ? { applicationName: item.applicationName } : {}) })} style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: selected ? colors.primary : colors.border }, !item.capturable && styles.disabled, pressed && styles.pressed]}>
                  <View style={[styles.icon, { backgroundColor: colors.surfaceInset }]}><Icon color={colors.textMuted} name="copy-outline" size={19} /></View>
                  <View style={styles.copy}>
                    <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.text }]}>{item.title || t('remoteDesktop.windowUnavailable')}</Text>
                    <Text numberOfLines={1} style={[styles.rowMeta, { color: colors.textMuted }]}>{item.applicationName || '—'} · {item.width} × {item.height}{item.capturable ? '' : ` · ${item.reason || t('remoteDesktop.windowUnavailable')}`}</Text>
                  </View>
                  {selected ? <Icon color={colors.primary} name="checkmark-circle" size={22} /> : null}
                </Pressable>;
              }} />}
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 52, paddingHorizontal: 8 },
  headerButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 64, paddingHorizontal: 8 },
  headerAction: { fontSize: 16 },
  title: { flex: 1, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  hint: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 12 },
  row: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 11, minHeight: 58, paddingHorizontal: 12, paddingVertical: 9 },
  icon: { alignItems: 'center', borderRadius: 9, height: 36, justifyContent: 'center', width: 36 },
  copy: { flex: 1, gap: 2, minWidth: 0 },
  rowTitle: { fontSize: 15, fontWeight: '500', lineHeight: 20 },
  rowMeta: { fontSize: 12, lineHeight: 17 },
  listHeader: { alignItems: 'center', flexDirection: 'row', marginBottom: 6, marginTop: 18, paddingHorizontal: 16 },
  sectionTitle: { flex: 1, fontSize: 12, fontWeight: '500', letterSpacing: 0.2, textTransform: 'uppercase' },
  refresh: { alignItems: 'center', height: 36, justifyContent: 'center', width: 40 },
  state: { alignItems: 'center', gap: 8, justifyContent: 'center', minHeight: 120, padding: 20 },
  stateText: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  list: { gap: 8, paddingBottom: 40, paddingHorizontal: 16 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.62 },
});
