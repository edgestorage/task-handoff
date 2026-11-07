import { Minus, Plus, X } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';

export type ImagePreviewControlsProps = {
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn(): void;
  onZoomOut(): void;
  onClose(): void;
};

export function ImagePreviewControls(props: ImagePreviewControlsProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <View style={styles.controls}>
    {[
      { label: t('attachments.zoomOut'), Icon: Minus, disabled: !props.canZoomOut, onPress: props.onZoomOut },
      { label: t('attachments.zoomIn'), Icon: Plus, disabled: !props.canZoomIn, onPress: props.onZoomIn },
      { label: t('sessions.close'), Icon: X, disabled: false, onPress: props.onClose },
    ].map(({ label, Icon, disabled, onPress }) => <Pressable key={label} accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.control, pressed && styles.pressed, disabled && styles.disabled]}><Icon color={colors.text} size={20} /></Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  controls: { flexDirection: 'row' },
  control: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.35 },
});
