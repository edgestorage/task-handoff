import { useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { ImagePreviewControls } from './ImagePreviewControls';
import { constrainImagePreview, fitImagePreview, IMAGE_PREVIEW_MAX_SCALE, IMAGE_PREVIEW_MIN_SCALE, imagePreviewScale, pinchImagePreview, type ImagePreviewSize, type ImagePreviewTransform } from './image-preview-transform';

type AttachmentImageProps = { uri: string; name: string; compact?: boolean };

/** A local URI is shared by the thumbnail and modal; authenticated content is loaded by the owner. */
export function AttachmentImage(props: AttachmentImageProps) {
  return <LocalAttachmentImage key={props.uri} {...props} />;
}

function LocalAttachmentImage({ uri, name, compact }: AttachmentImageProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return <>
    <Pressable accessibilityLabel={t(failed ? 'common.retry' : 'attachments.previewImage', { name })} accessibilityRole="button" onPress={() => {
      if (failed) { setFailed(false); setAttempt((value) => value + 1); }
      else setOpen(true);
    }} style={({ pressed }) => [styles.thumbnail, compact && styles.compactThumbnail, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
      {failed ? <Text style={[styles.meta, { color: colors.error }]}>{t('common.retry')}</Text>
        : <Image accessibilityLabel={name} testID="attachment-image-thumbnail" key={`${uri}:${attempt}`} onError={() => setFailed(true)} resizeMode="cover" source={{ uri }} style={styles.image} />}
    </Pressable>
    {open ? <ImagePreview name={name} onClose={() => setOpen(false)} uri={uri} /> : null}
  </>;
}

function ImagePreview({ uri, name, onClose }: { uri: string; name: string; onClose(): void }) {
  const { colors } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const width = Math.max(1, viewport.width - insets.left - insets.right);
  const height = Math.max(1, viewport.height - insets.top - insets.bottom - 60);
  return <Modal animationType="fade" onRequestClose={onClose} presentationStyle="fullScreen" visible>
    <GestureHandlerRootView style={styles.preview}>
      <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={[styles.preview, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
        <ImagePreviewContent key={`${width}:${height}`} height={height} name={name} onClose={onClose} uri={uri} width={width} />
      </View>
    </GestureHandlerRootView>
  </Modal>;
}

function ImagePreviewContent({ uri, name, onClose, width, height }: { uri: string; name: string; onClose(): void; width: number; height: number }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [image, setImage] = useState<ImagePreviewSize>({ width, height });
  const viewport = { width, height };
  const transform = useSharedValue<ImagePreviewTransform>({ scale: 1, x: 0, y: 0 });
  const pinching = useSharedValue(false);
  const panSample = useSharedValue<{ x: number; y: number } | null>(null);
  const pinchStart = useSharedValue<(ImagePreviewTransform & { focalX: number; focalY: number; gestureScale: number; pointers: number }) | null>(null);
  const pinch = Gesture.Pinch().withTestId('attachment-image-pinch').enabled(!loading && !failed)
    .onStart((event) => {
      pinching.set(true);
      panSample.set(null);
      pinchStart.set({ ...transform.get(), focalX: event.focalX - width / 2, focalY: event.focalY - height / 2, gestureScale: event.scale, pointers: event.numberOfPointers });
    })
    .onUpdate((event) => {
      // Touch-count changes move the recognizer's centroid without moving the image.
      if (event.numberOfPointers < 2) {
        pinchStart.set(null);
        return;
      }
      const start = pinchStart.get();
      if (!start || start.pointers !== event.numberOfPointers) {
        pinchStart.set({ ...transform.get(), focalX: event.focalX - width / 2, focalY: event.focalY - height / 2, gestureScale: event.scale, pointers: event.numberOfPointers });
        return;
      }
      transform.set(constrainImagePreview(pinchImagePreview(start, event.scale / start.gestureScale, { x: start.focalX, y: start.focalY }, { x: event.focalX - width / 2, y: event.focalY - height / 2 }), image, viewport));
    })
    .onFinalize(() => {
      pinching.set(false);
      pinchStart.set(null);
      panSample.set(null);
      scheduleOnRN(setZoom, transform.get().scale);
    });
  const pan = Gesture.Pan().withTestId('attachment-image-pan').enabled(!loading && !failed).maxPointers(1).minDistance(8).averageTouches(true)
    .onStart((event) => {
      panSample.set(event.numberOfPointers === 1 && !pinching.get() ? { x: event.translationX, y: event.translationY } : null);
    })
    .onUpdate((event) => {
      const previous = panSample.get();
      const next = event.numberOfPointers === 1 && !pinching.get() ? { x: event.translationX, y: event.translationY } : null;
      panSample.set(next);
      // The first sample after a pinch or pointer change establishes a new origin.
      if (!previous || !next) return;
      const current = transform.get();
      transform.set(constrainImagePreview({ ...current, x: current.x + next.x - previous.x, y: current.y + next.y - previous.y }, image, viewport));
    })
    .onFinalize(() => {
      panSample.set(null);
    });
  const tap = Gesture.Tap().withTestId('attachment-image-dismiss').enabled(!failed).maxDistance(8)
    .onTouchesDown((event, manager) => {
      if (event.numberOfTouches > 1) manager.fail();
    })
    .onEnd((_event, success) => {
      if (success) scheduleOnRN(onClose);
    });
  const imageStyle = useAnimatedStyle(() => {
    const current = transform.get();
    return { transform: [{ translateX: current.x }, { translateY: current.y }, { scale: current.scale }] };
  });
  const changeZoom = (delta: number) => {
    const current = transform.get();
    const scale = imagePreviewScale(current.scale + delta);
    transform.set(scale === IMAGE_PREVIEW_MIN_SCALE ? { scale, x: 0, y: 0 } : constrainImagePreview({ scale, x: current.x * scale / current.scale, y: current.y * scale / current.scale }, image, viewport));
    setZoom(scale);
  };
  return <>
      <View style={styles.toolbar}>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{name}</Text>
        <ImagePreviewControls canZoomIn={zoom < IMAGE_PREVIEW_MAX_SCALE} canZoomOut={zoom > IMAGE_PREVIEW_MIN_SCALE} onClose={onClose} onZoomIn={() => changeZoom(0.5)} onZoomOut={() => changeZoom(-0.5)} />
      </View>
      <View style={styles.stage}>
        <GestureDetector gesture={Gesture.Race(Gesture.Simultaneous(pinch, pan), tap)}>
          <View collapsable={false} style={styles.canvas} testID="attachment-image-canvas">
            <Animated.Image accessibilityLabel={name} testID="attachment-image-preview" key={attempt} onError={() => { setFailed(true); setLoading(false); }} onLoad={(event) => {
              const source = event.nativeEvent.source;
              if (source.width > 0 && source.height > 0) setImage(fitImagePreview(source, viewport));
              setLoading(false);
            }} resizeMode="contain" source={{ uri }} style={[image, imageStyle]} />
          </View>
        </GestureDetector>
        {loading ? <View pointerEvents="none" style={styles.overlay}><ActivityIndicator accessibilityLabel={t('common.loading')} color={colors.primary} /></View> : null}
        {failed ? <View style={styles.overlay}><Text style={[styles.meta, { color: colors.textMuted }]}>{t('attachments.loadFailed')}</Text><Pressable accessibilityRole="button" onPress={() => { setFailed(false); setLoading(true); setAttempt((value) => value + 1); }} style={({ pressed }) => [styles.control, pressed && styles.pressed]}><Text style={{ color: colors.primary }}>{t('common.retry')}</Text></Pressable></View> : null}
      </View>
  </>;
}

const styles = StyleSheet.create({
  thumbnail: { width: 64, height: 64, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  compactThumbnail: { width: 48, height: 48, borderRadius: 8 },
  image: { width: '100%', height: '100%' },
  preview: { flex: 1 },
  toolbar: { height: 60, flexDirection: 'row', alignItems: 'center', paddingLeft: 16 },
  title: { flex: 1, fontSize: 14, fontWeight: '400' },
  control: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  stage: { flex: 1 },
  canvas: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 12 },
  meta: { fontSize: 12 },
  pressed: { opacity: 0.65 },
});
