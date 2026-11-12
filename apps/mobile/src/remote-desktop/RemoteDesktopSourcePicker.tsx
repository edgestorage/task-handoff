import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import type { DesktopSource, RemoteDesktopCapabilities } from '@task-handoff/protocol/remote-desktop';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { persistedCaptureTarget, type PersistedCaptureTarget } from './preferences';
import { sourceKindLabel } from './source-label';

type SourceSection = { kind: string; title: string; data: DesktopSource[] };

type Props = {
  capability?: RemoteDesktopCapabilities;
  loadSources(signal?: AbortSignal): Promise<DesktopSource[]>;
  onClose(): void;
  onSelect(target: PersistedCaptureTarget): void;
  target: PersistedCaptureTarget;
  visible: boolean;
};

export function RemoteDesktopSourcePicker({ capability, loadSources, onClose, onSelect, target, visible }: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const available = capability?.sourceProviders.some((provider) => provider.available) === true;
  const sections = useMemo<SourceSection[]>(() => {
    const groups = new Map<string, DesktopSource[]>();
    for (const source of sources) {
      const group = groups.get(source.kind) ?? [];
      group.push(source);
      groups.set(source.kind, group);
    }
    return [...groups].map(([kind, data]) => ({ kind, title: sourceKindLabel(kind, t), data }));
  }, [sources, t]);

  const refresh = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted) return;
    setLoading(true);
    setError(false);
    try {
      const items = await loadSources(signal);
      if (!signal.aborted) setSources(items);
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [loadSources]);

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

  const selectSource = (source: DesktopSource) => {
    onSelect(persistedCaptureTarget(source));
    onClose();
  };

  return <Modal animationType="slide" onRequestClose={onClose} onShow={() => { if (available) beginLoad(); }} presentationStyle="pageSheet" visible={visible}>
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <Pressable accessibilityLabel={t('common.cancel')} accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
          <Text style={[styles.headerAction, { color: colors.primary }]}>{t('common.cancel')}</Text>
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{t('remoteDesktop.chooseSource')}</Text>
        <Pressable accessibilityLabel={t('remoteDesktop.refreshSources')} accessibilityRole="button" disabled={!available || loading} onPress={beginLoad} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
          {loading ? <ActivityIndicator color={colors.primary} size="small" /> : <Icon color={available ? colors.primary : colors.textMuted} name="refresh" size={18} />}
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: colors.textMuted }]}>{t('remoteDesktop.sourcePickerHint')}</Text>
      {!available ? <View style={styles.state}><Text style={[styles.stateText, { color: colors.textMuted }]}>{t('remoteDesktop.sourceCaptureUnavailable')}</Text></View>
        : loading && !sources.length ? <View style={styles.state}><ActivityIndicator color={colors.primary} /><Text style={[styles.stateText, { color: colors.textMuted }]}>{t('remoteDesktop.loadingSources')}</Text></View>
          : error ? <View style={styles.state}><Text style={[styles.stateText, { color: colors.error }]}>{t('remoteDesktop.errorGeneric')}</Text></View>
            : !sources.length ? <View style={styles.state}><Text style={[styles.stateText, { color: colors.textMuted }]}>{t('remoteDesktop.noSources')}</Text></View>
              : <SectionList<DesktopSource, SourceSection>
                contentContainerStyle={styles.list}
                keyExtractor={(item) => `${item.kind}:${item.sourceRef}`}
                renderItem={({ item }) => {
                  const selected = target.kind === item.kind && target.sourceRef === item.sourceRef;
                  const title = item.title || sourceKindLabel(item.kind, t);
                  const detail = item.subtitle || sourceKindLabel(item.kind, t);
                  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !item.capturable, selected }} disabled={!item.capturable} onPress={() => selectSource(item)} style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: selected ? colors.primary : colors.border }, !item.capturable && styles.disabled, pressed && styles.pressed]}>
                    <View style={[styles.icon, { backgroundColor: selected ? colors.primarySoft : colors.surfaceInset }]}><Icon color={selected ? colors.primary : colors.textMuted} name={sourceIcon(item.kind)} size={20} /></View>
                    <View style={styles.copy}>
                      <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
                      <Text numberOfLines={1} style={[styles.rowMeta, { color: colors.textMuted }]}>{detail || '—'} · {item.width} × {item.height}{item.capturable ? '' : ` · ${item.reason || t('remoteDesktop.sourceUnavailable')}`}</Text>
                    </View>
                    {selected ? <Icon color={colors.primary} name="checkmark-circle" size={22} /> : null}
                  </Pressable>;
                }}
                renderSectionHeader={({ section }) => <View accessibilityRole="header" style={styles.groupHeader} testID={`remote-desktop-source-group-${section.kind}`}>
                  <Text style={[styles.groupTitle, { color: colors.textMuted }]}>{section.title}</Text>
                  <Text style={[styles.groupCount, { color: colors.textMuted }]}>{section.data.length}</Text>
                </View>}
                sections={sections}
                stickySectionHeadersEnabled={false}
              />}
    </View>
  </Modal>;
}

function sourceIcon(kind: string): 'desktop-outline' | 'copy-outline' | 'scan-outline' {
  if (kind === 'display') return 'desktop-outline';
  if (kind === 'window') return 'copy-outline';
  return 'scan-outline';
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 52, paddingHorizontal: 8 },
  headerButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 64, paddingHorizontal: 8 },
  headerAction: { fontSize: 16 },
  title: { flex: 1, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  hint: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 12 },
  groupHeader: { alignItems: 'baseline', flexDirection: 'row', gap: 8, justifyContent: 'space-between', paddingBottom: 4, paddingHorizontal: 4, paddingTop: 8 },
  groupTitle: { fontSize: 12, lineHeight: 16 },
  groupCount: { fontSize: 12, lineHeight: 16 },
  row: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 11, marginBottom: 8, minHeight: 58, paddingHorizontal: 12, paddingVertical: 9 },
  icon: { alignItems: 'center', borderRadius: 9, height: 36, justifyContent: 'center', width: 36 },
  copy: { flex: 1, gap: 2, minWidth: 0 },
  rowTitle: { fontSize: 15, fontWeight: '500', lineHeight: 20 },
  rowMeta: { fontSize: 12, lineHeight: 17 },
  state: { alignItems: 'center', gap: 8, justifyContent: 'center', minHeight: 120, padding: 20 },
  stateText: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  list: { paddingBottom: 40, paddingHorizontal: 16 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.62 },
});
