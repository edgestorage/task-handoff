import { useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Minus, Plus, X } from 'lucide-react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';

/** A local URI is shared by the thumbnail and modal; authenticated content is loaded by the owner. */
export function AttachmentImage(props: { uri: string; name: string }) {
  return <LocalAttachmentImage key={props.uri} {...props} />;
}

function LocalAttachmentImage({ uri, name }: { uri: string; name: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return <>
    <Pressable accessibilityLabel={t(failed ? 'common.retry' : 'attachments.previewImage', { name })} accessibilityRole="button" onPress={() => {
      if (failed) { setFailed(false); setAttempt((value) => value + 1); }
      else setOpen(true);
    }} style={({ pressed }) => [styles.thumbnail, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
      {failed ? <Text style={[styles.meta, { color: colors.error }]}>{t('common.retry')}</Text>
        : <Image accessibilityLabel={name} testID="attachment-image-thumbnail" key={`${uri}:${attempt}`} onError={() => setFailed(true)} resizeMode="cover" source={{ uri }} style={styles.image} />}
    </Pressable>
    {open ? <ImagePreview name={name} onClose={() => setOpen(false)} uri={uri} /> : null}
  </>;
}

function ImagePreview({ uri, name, onClose }: { uri: string; name: string; onClose(): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const width = Math.max(1, viewport.width - insets.left - insets.right);
  const height = Math.max(1, viewport.height - insets.top - insets.bottom - 60);
  return <Modal animationType="fade" onRequestClose={onClose} presentationStyle="fullScreen" visible>
    <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={[styles.preview, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={styles.toolbar}>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{name}</Text>
        <Pressable accessibilityLabel={t('attachments.zoomOut')} accessibilityRole="button" accessibilityState={{ disabled: zoom <= 1 }} disabled={zoom <= 1} onPress={() => setZoom((value) => Math.max(1, value - 0.5))} style={({ pressed }) => [styles.control, pressed && styles.pressed, zoom <= 1 && styles.disabled]}><Minus color={colors.text} size={20} /></Pressable>
        <Pressable accessibilityLabel={t('attachments.zoomIn')} accessibilityRole="button" accessibilityState={{ disabled: zoom >= 3 }} disabled={zoom >= 3} onPress={() => setZoom((value) => Math.min(3, value + 0.5))} style={({ pressed }) => [styles.control, pressed && styles.pressed, zoom >= 3 && styles.disabled]}><Plus color={colors.text} size={20} /></Pressable>
        <Pressable accessibilityLabel={t('sessions.close')} accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.control, pressed && styles.pressed]}><X color={colors.text} size={22} /></Pressable>
      </View>
      <View style={styles.stage}>
        <ScrollView bounces={false} centerContent contentContainerStyle={styles.center} style={styles.stage}>
          <ScrollView bounces={false} horizontal contentContainerStyle={styles.center}>
            <Image accessibilityLabel={name} testID="attachment-image-preview" key={attempt} onError={() => { setFailed(true); setLoading(false); }} onLoad={() => setLoading(false)} resizeMode="contain" source={{ uri }} style={{ width: width * zoom, height: height * zoom }} />
          </ScrollView>
        </ScrollView>
        {loading ? <View pointerEvents="none" style={styles.overlay}><ActivityIndicator accessibilityLabel={t('common.loading')} color={colors.primary} /></View> : null}
        {failed ? <View style={styles.overlay}><Text style={[styles.meta, { color: colors.textMuted }]}>{t('attachments.loadFailed')}</Text><Pressable accessibilityRole="button" onPress={() => { setFailed(false); setLoading(true); setAttempt((value) => value + 1); }} style={({ pressed }) => [styles.control, pressed && styles.pressed]}><Text style={{ color: colors.primary }}>{t('common.retry')}</Text></Pressable></View> : null}
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  thumbnail: { width: 64, height: 64, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  preview: { flex: 1 },
  toolbar: { height: 60, flexDirection: 'row', alignItems: 'center', paddingLeft: 16 },
  title: { flex: 1, fontSize: 14, fontWeight: '400' },
  control: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  stage: { flex: 1 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 12 },
  meta: { fontSize: 12 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.35 },
});
