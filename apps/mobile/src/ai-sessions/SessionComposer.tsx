import { useEffect, useRef, useState } from 'react';
import { BlurView } from 'expo-blur';
import { Hand, Pencil, Plus, ShieldAlert, ShieldCheck, X } from 'lucide-react-native';
import { ActionSheetIOS, Alert, Animated, Easing, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n, type Translate } from '../i18n';
import {
  SESSION_COMPOSER_ACTION_ICON_SIZE,
  SESSION_COMPOSER_ACTION_RADIUS,
  SESSION_COMPOSER_ACTION_SIZE,
  SESSION_COMPOSER_COLLAPSED_HEIGHT,
  SESSION_COMPOSER_EXPANDED_HEIGHT,
  SESSION_COMPOSER_EXPANDED_RADIUS,
  SESSION_COMPOSER_TOOLBAR_HEIGHT,
} from './composer-metrics';
import type { SessionComposerProps } from './session-composer-types';

export function SessionComposer(props: SessionComposerProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const permissionDanger = props.permissionMode === 'full-access';
  const PermissionIcon = props.permissionMode === 'ask' ? Hand : props.permissionMode === 'auto-review' ? ShieldCheck : ShieldAlert;
  const currentPermissionLabel = permissionLabel(props.permissionMode, t);
  const [permissionLabelMeasurement, setPermissionLabelMeasurement] = useState<{ label: string; width: number }>();
  const [fallbackExpansion] = useState(() => new Animated.Value(props.focused ? 1 : 0));
  const expansion = props.expansion ?? fallbackExpansion;
  const mounted = useRef(false);
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (!props.focusRequestKey) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.focusRequestKey]);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      expansion.setValue(props.focused ? 1 : 0);
      return;
    }
    const animation = Animated.timing(expansion, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      toValue: props.focused ? 1 : 0,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [expansion, props.focused]);
  const animatedContainerStyle = {
    borderRadius: expansion.interpolate({ inputRange: [0, 1], outputRange: [28, SESSION_COMPOSER_EXPANDED_RADIUS] }),
    height: expansion.interpolate({ inputRange: [0, 1], outputRange: [SESSION_COMPOSER_COLLAPSED_HEIGHT, SESSION_COMPOSER_EXPANDED_HEIGHT] }),
  };
  const measuredPermissionWidth = permissionLabelMeasurement?.label === currentPermissionLabel
    ? Math.ceil(permissionLabelMeasurement.width) + 42
    : estimatedPermissionWidth(props.permissionMode);
  const permissionWidth = expansion.interpolate({ inputRange: [0, 1], outputRange: [36, measuredPermissionWidth] });
  const permissionTextOpacity = expansion.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0, 1] });
  return (
    <Animated.View
      accessibilityState={{ expanded: props.focused }}
      onTouchStart={(event) => event.stopPropagation()}
      testID="session-composer"
      style={[
        styles.composer,
        animatedContainerStyle,
        { backgroundColor: 'transparent', borderColor: colors.border },
      ]}
    >
      <BlurView
        intensity={70}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        testID="session-composer-blur"
        tint={dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
      />
      <TextInput
        ref={inputRef}
        accessibilityLabel={t('composer.message')}
        editable={props.editable}
        multiline
        onBlur={() => props.onFocusChange(false)}
        onChangeText={props.onValueChange}
        onFocus={() => props.onFocusChange(true)}
        placeholder={t('composer.placeholder')}
        placeholderTextColor={colors.textMuted}
        scrollEnabled={props.focused}
        style={[styles.input, props.focused ? styles.inputFocused : styles.inputCollapsed, !props.focused && !props.permissionEnabled && styles.inputCollapsedWithoutPermission, { color: colors.text }]}
        textAlignVertical={props.focused ? 'top' : 'center'}
        testID="session-message-input"
        value={props.value}
      />
      <View pointerEvents="box-none" style={styles.toolbar}>
        {props.editingLabel ? <View style={styles.editingState}>
          <Pencil color={colors.textMuted} size={16} strokeWidth={1.8} />
          <Text numberOfLines={1} style={[styles.editingLabel, { color: colors.textMuted }]}>{props.editingLabel}</Text>
          <Pressable accessibilityLabel={t('composer.cancelEdit')} accessibilityRole="button" hitSlop={6} onPress={props.onCancelEdit} style={({ pressed }) => [styles.cancelEditButton, pressed && styles.pressed]}>
            <X color={colors.textMuted} size={17} strokeWidth={1.9} />
          </Pressable>
        </View> : <View style={styles.leadingTools}>
          <Pressable
            accessibilityLabel={t('composer.addAttachment')}
            accessibilityRole="button"
            disabled={props.imageDisabled && props.fileDisabled && props.runtimeFileDisabled}
            hitSlop={4}
            onPress={() => showAttachmentMenu(props, t)}
            style={({ pressed }) => [styles.toolButton, pressed && styles.pressed, props.imageDisabled && props.fileDisabled && props.runtimeFileDisabled && styles.disabled]}
          >
            <Plus color={colors.textMuted} size={ATTACHMENT_ICON_SIZE} strokeWidth={1.9} />
          </Pressable>
          {props.permissionEnabled ? <Animated.View style={[styles.permissionButtonFrame, { width: permissionWidth }]}>
            <Pressable
              accessibilityLabel={t('composer.permissionModeValue', { mode: permissionLabel(props.permissionMode, t) })}
              accessibilityRole="button"
              onPress={() => showPermissionMenu(props, t)}
              style={({ pressed }) => [styles.permissionButton, pressed && { backgroundColor: colors.surfaceMuted }]}
            >
              <View style={styles.permissionIconSlot}>
                <PermissionIcon color={permissionDanger ? colors.error : colors.textMuted} size={permissionIconSize(props.permissionMode)} strokeWidth={1.8} />
              </View>
              <Animated.Text numberOfLines={1} style={[styles.permissionText, { color: permissionDanger ? colors.error : colors.textMuted, opacity: permissionTextOpacity }]}>
                {currentPermissionLabel}
              </Animated.Text>
            </Pressable>
          </Animated.View> : null}
          {props.permissionEnabled ? <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onLayout={(event) => setPermissionLabelMeasurement({ label: currentPermissionLabel, width: event.nativeEvent.layout.width })}
            style={styles.permissionTextMeasurement}
          >
            {currentPermissionLabel}
          </Text> : null}
        </View>}
        <Pressable
          accessibilityLabel={actionLabel(props.action, t)}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.actionDisabled }}
          disabled={props.actionDisabled}
          onPress={props.onAction}
          testID="session-composer-action"
          style={({ pressed }) => [styles.actionButton, { backgroundColor: props.action === 'stop' ? colors.destructiveButton : colors.primaryButton }, pressed && styles.pressed, props.actionDisabled && styles.disabled]}
        >
          <SystemIcon android={props.action === 'stop' ? 'stop' : props.action === 'save' ? 'check' : 'arrow_upward'} color="#ffffff" ios={props.action === 'stop' ? 'stop.fill' : props.action === 'save' ? 'checkmark' : 'arrow.up'} size={SESSION_COMPOSER_ACTION_ICON_SIZE} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

function showAttachmentMenu(props: SessionComposerProps, t: Translate) {
  const options = [t('composer.photo'), t('composer.deviceFile'), t('composer.workspaceFile'), t('common.cancel')];
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({
      options,
      cancelButtonIndex: 3,
      disabledButtonIndices: [props.imageDisabled ? 0 : -1, props.fileDisabled ? 1 : -1, props.runtimeFileDisabled ? 2 : -1].filter((index) => index >= 0),
    }, (index) => {
      if (index === 0) props.onAddImage();
      else if (index === 1) props.onAddFile();
      else if (index === 2) props.onAddRuntimeFile();
    });
    return;
  }
  Alert.alert(t('composer.addAttachment'), undefined, [
    { text: t('composer.photo'), onPress: props.onAddImage },
    { text: t('composer.deviceFile'), onPress: props.onAddFile },
    { text: t('composer.workspaceFile'), onPress: props.onAddRuntimeFile },
    { text: t('common.cancel'), style: 'cancel' },
  ]);
}

function showPermissionMenu(props: SessionComposerProps, t: Translate) {
  const select = (index: number) => {
    if (index === 0) props.onPermissionModeChange('ask');
    else if (index === 1) props.onPermissionModeChange('auto-review');
    else if (index === 2) props.onPermissionModeChange('full-access');
  };
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ options: [t('composer.askBeforeChanges'), t('composer.autoReview'), t('composer.fullAccess'), t('common.cancel')], cancelButtonIndex: 3, destructiveButtonIndex: 2 }, select);
    return;
  }
  Alert.alert(t('composer.permissionMode'), undefined, [
    { text: t('composer.askBeforeChanges'), onPress: () => select(0) },
    { text: t('composer.autoReview'), onPress: () => select(1) },
    { text: t('composer.fullAccess'), style: 'destructive', onPress: () => select(2) },
    { text: t('common.cancel'), style: 'cancel' },
  ]);
}

function actionLabel(action: SessionComposerProps['action'], t: Translate) {
  return action === 'stop' ? t('composer.stop') : action === 'save' ? t('composer.saveEdit') : t('composer.send');
}

function permissionLabel(mode: SessionComposerProps['permissionMode'], t: Translate) {
  return mode === 'ask' ? t('composer.ask') : mode === 'auto-review' ? t('composer.autoReview') : t('composer.fullAccess');
}

function estimatedPermissionWidth(mode: SessionComposerProps['permissionMode']) {
  return mode === 'ask' ? 70 : mode === 'auto-review' ? 136 : 126;
}

function permissionIconSize(mode: SessionComposerProps['permissionMode']) {
  return mode === 'ask' ? 21 : 22;
}

const ATTACHMENT_ICON_SIZE = 25;

const styles = StyleSheet.create({
  composer: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
  },
  input: { fontSize: 16, lineHeight: 23 },
  inputCollapsed: { bottom: 0, left: 84, paddingHorizontal: 4, paddingVertical: 15, position: 'absolute', right: 52, top: 0 },
  inputCollapsedWithoutPermission: { left: 48 },
  inputFocused: { bottom: 50, left: 0, paddingBottom: 8, paddingHorizontal: 14, paddingTop: 14, position: 'absolute', right: 0, top: 0 },
  toolbar: { alignItems: 'center', bottom: 0, flexDirection: 'row', height: SESSION_COMPOSER_TOOLBAR_HEIGHT, justifyContent: 'space-between', left: 0, paddingHorizontal: 8, position: 'absolute', right: 0 },
  leadingTools: { alignItems: 'center', flexDirection: 'row' },
  editingState: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 7, minWidth: 0, paddingLeft: 8, paddingRight: 6 },
  editingLabel: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
  cancelEditButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  toolButton: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  permissionButtonFrame: { borderRadius: 19, height: 38, overflow: 'hidden' },
  permissionButton: { alignItems: 'center', borderRadius: 19, flex: 1, flexDirection: 'row' },
  permissionIconSlot: { alignItems: 'center', height: 20, justifyContent: 'center', left: 8, position: 'absolute', width: 20 },
  permissionText: { fontSize: 13, fontWeight: '600', marginLeft: 34, marginRight: 8 },
  permissionTextMeasurement: { fontSize: 13, fontWeight: '600', opacity: 0, position: 'absolute' },
  actionButton: { alignItems: 'center', borderRadius: SESSION_COMPOSER_ACTION_RADIUS, height: SESSION_COMPOSER_ACTION_SIZE, justifyContent: 'center', width: SESSION_COMPOSER_ACTION_SIZE },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
