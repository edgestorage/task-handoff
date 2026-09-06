import { useEffect, useRef, useState } from 'react';
import { BlurView } from 'expo-blur';
import { TextInputWrapper, type PasteEventPayload } from 'expo-paste-input';
import { Hand, Pencil, Plus, ShieldAlert, ShieldCheck, X } from 'lucide-react-native';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AI_SESSION_LONG_PASTE_CODE_POINT_THRESHOLD } from '@task-handoff/control-plane-client';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { mobileWebType } from '../components/mobile-web-typography';
import { useI18n, type Translate } from '../i18n';
import {
  SESSION_COMPOSER_ACTION_ICON_SIZE,
  SESSION_COMPOSER_ACTION_RADIUS,
  SESSION_COMPOSER_ACTION_SIZE,
  SESSION_COMPOSER_ATTACHMENT_ICON_SIZE,
  SESSION_COMPOSER_COLLAPSED_HEIGHT,
  SESSION_COMPOSER_EXPANDED_HEIGHT,
  SESSION_COMPOSER_EXPANDED_RADIUS,
  SESSION_COMPOSER_MODEL_MAX_WIDTH,
  SESSION_COMPOSER_PERMISSION_CHEVRON_RIGHT,
  SESSION_COMPOSER_PERMISSION_CHEVRON_SIZE,
  SESSION_COMPOSER_PERMISSION_HEIGHT,
  SESSION_COMPOSER_PERMISSION_ICON_LEFT,
  SESSION_COMPOSER_PERMISSION_ICON_SLOT_SIZE,
  SESSION_COMPOSER_PERMISSION_RADIUS,
  SESSION_COMPOSER_PERMISSION_TEXT_LEFT,
  SESSION_COMPOSER_PERMISSION_TEXT_RIGHT,
  SESSION_COMPOSER_PERMISSION_WIDTH_OVERHEAD,
  SESSION_COMPOSER_TOOLBAR_HEIGHT,
  SESSION_COMPOSER_TOOL_SIZE,
  sessionComposerCollapsedInputRight,
  sessionComposerPermissionIconSize,
} from './composer-metrics';
import { AttachmentMenu, ModelSettingsMenu, PermissionMenu, type PermissionOption } from './SessionComposerMenus';
import type { SessionComposerProps } from './session-composer-types';

export function SessionComposer(props: SessionComposerProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const attachmentDisabled = props.actionBusy || props.imageDisabled && props.fileDisabled && props.runtimeFileDisabled;
  const permissionOptions: PermissionOption[] = ([
    { value: 'ask', label: t('composer.ask'), description: t('composer.askDescription'), systemImage: 'hand.raised' },
    { value: 'auto-review', label: t('composer.autoReview'), description: t('composer.autoReviewDescription'), systemImage: 'checkmark.shield' },
    { value: 'full-access', label: t('composer.fullAccess'), description: t('composer.fullAccessDescription'), systemImage: 'exclamationmark.shield', danger: true },
  ] satisfies PermissionOption[]).filter((option) => props.permissionModes.includes(option.value));
  const effectivePermissionMode = permissionOptions.find((option) => option.value === props.permissionMode)?.value || permissionOptions[0]?.value || props.permissionMode;
  const permissionDanger = effectivePermissionMode === 'full-access';
  const PermissionIcon = effectivePermissionMode === 'ask' ? Hand : effectivePermissionMode === 'auto-review' ? ShieldCheck : ShieldAlert;
  const currentPermissionLabel = permissionLabel(effectivePermissionMode, t);
  const modelGroups = props.modelGroups || [];
  const modelControlsVisible = Boolean(modelGroups.length || props.reasoningEffortEnabled);
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
    ? Math.ceil(permissionLabelMeasurement.width) + SESSION_COMPOSER_PERMISSION_WIDTH_OVERHEAD
    : estimatedPermissionWidth(effectivePermissionMode);
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
      <TextInputWrapper
        interceptTextPasteAbove={
          props.editingLabel ? undefined : AI_SESSION_LONG_PASTE_CODE_POINT_THRESHOLD
        }
        onPaste={(payload: PasteEventPayload) => {
          if (payload.type === 'images') props.onPasteImages(payload.uris);
          else if (payload.type === 'text' && payload.intercepted) props.onPasteText(payload.value);
        }}
        pointerEvents="box-none"
        style={StyleSheet.absoluteFill}
        testID="session-message-paste-input"
      >
        <TextInput
          ref={inputRef}
          accessibilityLabel={t('composer.message')}
          editable={props.editable && !props.actionBusy}
          multiline
          onBlur={() => props.onFocusChange(false)}
          onChangeText={props.onValueChange}
          onFocus={() => props.onFocusChange(true)}
          placeholder={t('composer.placeholder')}
          placeholderTextColor={colors.textPlaceholder}
          scrollEnabled={props.focused}
          style={[styles.input, props.focused ? styles.inputFocused : [styles.inputCollapsed, { right: sessionComposerCollapsedInputRight(modelControlsVisible) }], !props.focused && !permissionOptions.length && styles.inputCollapsedWithoutPermission, { color: colors.text }]}
          textAlignVertical={props.focused ? 'top' : 'center'}
          testID="session-message-input"
          value={props.value}
        />
      </TextInputWrapper>
      <View pointerEvents="box-none" style={styles.toolbar}>
        {props.editingLabel ? <View style={styles.editingState}>
          <Pencil color={colors.textMuted} size={16} strokeWidth={1.8} />
          <Text numberOfLines={1} style={[styles.editingLabel, { color: colors.textMuted }]}>{props.editingLabel}</Text>
          <Pressable accessibilityLabel={t('composer.cancelEdit')} accessibilityRole="button" accessibilityState={{ disabled: props.actionBusy }} disabled={props.actionBusy} hitSlop={6} onPress={props.onCancelEdit} style={({ pressed }) => [styles.cancelEditButton, props.actionBusy && styles.disabled, pressed && styles.pressed]}>
            <X color={colors.textMuted} size={17} strokeWidth={1.9} />
          </Pressable>
        </View> : <View style={styles.leadingTools}>
          <AttachmentMenu
            cancelLabel={t('common.cancel')}
            fileDisabled={props.fileDisabled}
            fileLabel={t('composer.deviceFile')}
            imageDisabled={props.imageDisabled}
            imageLabel={t('composer.photo')}
            onAddFile={props.onAddFile}
            onAddImage={props.onAddImage}
            onAddRuntimeFile={props.onAddRuntimeFile}
            runtimeFileDisabled={props.runtimeFileDisabled}
            runtimeFileLabel={t('composer.workspaceFile')}
            title={t('composer.addAttachment')}
          >
            {(onPress) => <Pressable
              accessibilityLabel={t('composer.addAttachment')}
              accessibilityRole="button"
              accessibilityState={{ disabled: attachmentDisabled }}
              disabled={attachmentDisabled}
              hitSlop={4}
              onPress={onPress}
              style={({ pressed }) => [styles.toolButton, pressed && styles.pressed, attachmentDisabled && styles.disabled]}
            >
              <Plus color={colors.textMuted} size={SESSION_COMPOSER_ATTACHMENT_ICON_SIZE} strokeWidth={1.9} />
            </Pressable>}
          </AttachmentMenu>
          {permissionOptions.length ? <Animated.View style={[styles.permissionButtonFrame, { width: permissionWidth }]} testID="session-permission-button-frame">
            <PermissionMenu
              cancelLabel={t('common.cancel')}
              disabled={props.actionBusy}
              mode={effectivePermissionMode}
              onChange={props.onPermissionModeChange}
              options={permissionOptions}
              title={t('composer.permissionMode')}
            >
              {(onPress) => <Animated.View style={[styles.permissionMenuTriggerFrame, { width: permissionWidth }]} testID="session-permission-menu-trigger-frame">
                <Pressable
                  accessibilityLabel={t('composer.permissionModeValue', { mode: currentPermissionLabel })}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: props.actionBusy }}
                  disabled={props.actionBusy}
                  onPress={onPress}
                  style={({ pressed }) => [styles.permissionButton, props.actionBusy && styles.disabled, pressed && { backgroundColor: colors.surfaceMuted }]}
                >
                  <View style={styles.permissionIconSlot}>
                    <PermissionIcon color={permissionDanger ? colors.error : colors.textMuted} size={sessionComposerPermissionIconSize(effectivePermissionMode)} strokeWidth={1.8} />
                  </View>
                  <Animated.Text numberOfLines={1} style={[styles.permissionText, { color: permissionDanger ? colors.error : colors.textMuted, opacity: permissionTextOpacity }]}>
                    {currentPermissionLabel}
                  </Animated.Text>
                  <Animated.View pointerEvents="none" style={[styles.permissionChevron, { opacity: permissionTextOpacity }]} testID="session-permission-chevron">
                    <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={10} />
                  </Animated.View>
                </Pressable>
              </Animated.View>}
            </PermissionMenu>
          </Animated.View> : null}
          {permissionOptions.length ? <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onLayout={(event) => setPermissionLabelMeasurement({ label: currentPermissionLabel, width: event.nativeEvent.layout.width })}
            style={styles.permissionTextMeasurement}
          >
            {currentPermissionLabel}
          </Text> : null}
        </View>}
        <View style={styles.trailingTools}>
        {modelControlsVisible ? <ModelSettingsMenu provider={props.provider} cancelLabel={t('common.cancel')} disabled={Boolean(props.actionBusy || props.modelSelectionBusy || props.reasoningEffortBusy)} formatModelGroupSummary={(model, count) => t('sessions.modelGroupSummary', { model, count })} modelGroups={modelGroups} modelSelection={props.modelSelection} onModelChange={(selection) => props.onModelSelectionChange?.(selection)} onReasoningChange={(effort) => props.onReasoningEffortChange?.(effort)} reasoningEffort={props.reasoningEffort} reasoningEnabled={Boolean(props.reasoningEffortEnabled)} reasoningTitle={t('sessions.reasoningEffort')} title={t('sessions.model')}>
          {(onPress) => <Pressable accessibilityLabel={props.modelSelection?.modelName || t('sessions.model')} accessibilityRole="button" disabled={props.actionBusy || props.modelSelectionBusy} onPress={onPress} style={({ pressed }) => [styles.modelButton, pressed && styles.pressed]}>
            {props.modelSelectionBusy || props.reasoningEffortBusy ? <ActivityIndicator color={colors.textMuted} size="small" /> : <Text numberOfLines={1} style={[styles.modelText, { color: colors.textMuted }]}>{props.modelSelection?.modelName || t('sessions.model')}</Text>}
            <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={10} />
          </Pressable>}
        </ModelSettingsMenu> : null}
        <Pressable
          accessibilityLabel={actionLabel(props.action, t, props.actionBusy)}
          accessibilityRole="button"
          accessibilityState={{ busy: props.actionBusy, disabled: props.actionDisabled }}
          disabled={props.actionDisabled}
          onPress={props.onAction}
          testID="session-composer-action"
          style={({ pressed }) => [styles.actionButton, { backgroundColor: props.action === 'stop' ? colors.destructiveButton : colors.primaryButton }, pressed && styles.pressed, props.actionDisabled && styles.disabled]}
        >
          {props.actionBusy
            ? <ActivityIndicator color="#ffffff" size="small" testID="session-composer-action-loading" />
            : <SystemIcon android={props.action === 'stop' ? 'stop' : props.action === 'save' ? 'check' : 'arrow_upward'} color="#ffffff" ios={props.action === 'stop' ? 'stop.fill' : props.action === 'save' ? 'checkmark' : 'arrow.up'} size={SESSION_COMPOSER_ACTION_ICON_SIZE} />}
        </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

function actionLabel(action: SessionComposerProps['action'], t: Translate, busy: boolean) {
  if (busy) return action === 'stop' ? t('composer.stopping') : action === 'save' ? t('composer.saving') : t('composer.sending');
  return action === 'stop' ? t('composer.stop') : action === 'save' ? t('composer.saveEdit') : t('composer.send');
}

function permissionLabel(mode: SessionComposerProps['permissionMode'], t: Translate) {
  return mode === 'ask' ? t('composer.ask') : mode === 'auto-review' ? t('composer.autoReview') : t('composer.fullAccess');
}

function estimatedPermissionWidth(mode: SessionComposerProps['permissionMode']) {
  return mode === 'ask' ? 158 : mode === 'auto-review' ? 148 : 142;
}

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
  inputCollapsed: { bottom: 0, left: 84, paddingHorizontal: 4, paddingVertical: 15, position: 'absolute', top: 0 },
  inputCollapsedWithoutPermission: { left: 48 },
  inputFocused: { bottom: 50, left: 0, paddingBottom: 8, paddingHorizontal: 14, paddingTop: 14, position: 'absolute', right: 0, top: 0 },
  toolbar: { alignItems: 'center', bottom: 0, flexDirection: 'row', height: SESSION_COMPOSER_TOOLBAR_HEIGHT, justifyContent: 'space-between', left: 0, paddingHorizontal: 8, position: 'absolute', right: 0 },
  leadingTools: { alignItems: 'center', flexDirection: 'row' },
  trailingTools: { alignItems: 'center', flexDirection: 'row', gap: 4, minWidth: 0 },
  modelButton: { alignItems: 'center', flexDirection: 'row', gap: 4, maxWidth: SESSION_COMPOSER_MODEL_MAX_WIDTH, minHeight: 40, paddingHorizontal: 5 },
  modelText: { flexShrink: 1, fontSize: mobileWebType.meta, fontWeight: '500' },
  editingState: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 7, minWidth: 0, paddingLeft: 8, paddingRight: 6 },
  editingLabel: { flexShrink: 1, fontSize: mobileWebType.meta, fontWeight: '600' },
  cancelEditButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  toolButton: { alignItems: 'center', height: SESSION_COMPOSER_TOOL_SIZE, justifyContent: 'center', width: SESSION_COMPOSER_TOOL_SIZE },
  permissionButtonFrame: { borderRadius: SESSION_COMPOSER_PERMISSION_RADIUS, height: SESSION_COMPOSER_PERMISSION_HEIGHT, overflow: 'hidden' },
  permissionMenuTriggerFrame: { height: SESSION_COMPOSER_PERMISSION_HEIGHT },
  permissionButton: { alignItems: 'center', borderRadius: SESSION_COMPOSER_PERMISSION_RADIUS, flex: 1, flexDirection: 'row' },
  permissionIconSlot: { alignItems: 'center', height: SESSION_COMPOSER_PERMISSION_ICON_SLOT_SIZE, justifyContent: 'center', left: SESSION_COMPOSER_PERMISSION_ICON_LEFT, position: 'absolute', width: SESSION_COMPOSER_PERMISSION_ICON_SLOT_SIZE },
  permissionText: { fontSize: mobileWebType.meta, fontWeight: '600', marginLeft: SESSION_COMPOSER_PERMISSION_TEXT_LEFT, marginRight: SESSION_COMPOSER_PERMISSION_TEXT_RIGHT },
  permissionChevron: { alignItems: 'center', height: SESSION_COMPOSER_PERMISSION_ICON_SLOT_SIZE, justifyContent: 'center', position: 'absolute', right: SESSION_COMPOSER_PERMISSION_CHEVRON_RIGHT, width: SESSION_COMPOSER_PERMISSION_CHEVRON_SIZE },
  permissionTextMeasurement: { fontSize: mobileWebType.meta, fontWeight: '600', opacity: 0, position: 'absolute' },
  actionButton: { alignItems: 'center', borderRadius: SESSION_COMPOSER_ACTION_RADIUS, height: SESSION_COMPOSER_ACTION_SIZE, justifyContent: 'center', width: SESSION_COMPOSER_ACTION_SIZE },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
