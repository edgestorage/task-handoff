import { Button, HStack, Host } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, frame, labelStyle, tint } from '@expo/ui/swift-ui/modifiers';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { ImagePreviewControlsProps } from './ImagePreviewControls';

export function ImagePreviewControls(props: ImagePreviewControlsProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const iconButton = (isDisabled: boolean) => [buttonStyle('borderless'), controlSize('regular'), labelStyle('iconOnly'), tint(colors.text), disabled(isDisabled), frame({ minWidth: 48, minHeight: 48 })];
  return <Host colorScheme={dark ? 'dark' : 'light'} ignoreSafeArea="all" seedColor={colors.text} style={{ width: 144, height: 48 }}>
    <HStack spacing={0}>
      <Button label={t('attachments.zoomOut')} systemImage="minus.magnifyingglass" modifiers={iconButton(!props.canZoomOut)} onPress={props.onZoomOut} />
      <Button label={t('attachments.zoomIn')} systemImage="plus.magnifyingglass" modifiers={iconButton(!props.canZoomIn)} onPress={props.onZoomIn} />
      <Button label={t('sessions.close')} systemImage="xmark" role="cancel" modifiers={iconButton(false)} onPress={props.onClose} />
    </HStack>
  </Host>;
}
