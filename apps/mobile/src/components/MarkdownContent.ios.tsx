import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

import type { TaskHandoffMarkdownViewProps, TaskHandoffMarkdownTheme } from '../../modules/task-handoff-markdown/src/TaskHandoffMarkdownView';
import { useI18n } from '../i18n';
import { openSystemLink } from '../platform/links';
import { mobileMarkdownLinkTarget } from './markdown-link-target';
import { MarkdownLinkMenu } from './MarkdownLinkMenu';
import type { MarkdownContentProps } from './MarkdownContent.types';
import type { FloatingMenuAnchor } from './menu/FloatingMenu';
import { SafeMarkdown } from './SafeMarkdown';
import { useMobileTheme } from './theme';

const nativeMarkdownAvailable = requireOptionalNativeModule('TaskHandoffMarkdown') !== null;
const NativeMarkdownView = nativeMarkdownAvailable
  ? requireNativeView<TaskHandoffMarkdownViewProps>('TaskHandoffMarkdown')
  : undefined;

export function MarkdownContent(props: MarkdownContentProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const openFile = props.onOpenFile;
  const [markdownWidth, setMarkdownWidth] = useState(0);
  const [linkMenu, setLinkMenu] = useState<{ anchor: FloatingMenuAnchor; url: string }>();

  const labels = useMemo(() => ({
    addToConversation: props.onAddToConversation ? t('sessions.addToConversation') : '',
    copied: t('sessions.codeCopied'),
    copy: t('sessions.copyCode'),
    plainText: t('sessions.plainText'),
  }), [props.onAddToConversation, t]);
  const theme = useMemo<TaskHandoffMarkdownTheme>(() => ({
    background: colors.background,
    border: colors.border,
    codeBackground: colors.surface,
    codeForeground: colors.text,
    link: colors.primary,
    muted: colors.textMuted,
    surface: colors.surface,
    surfaceHover: colors.surfaceHover,
    surfaceInset: colors.surfaceInset,
    surfaceRaised: colors.surfaceRaised,
    syntaxNumber: colors.syntaxNumber,
    tableBackground: colors.tableBackground,
    tableBorder: colors.tableBorder,
    tableHeaderBackground: colors.tableHeaderBackground,
    tableStripe: colors.tableStripe,
    tableText: colors.tableText,
    text: colors.text,
  }), [colors]);

  const openLink = useCallback((raw: string) => {
    const target = mobileMarkdownLinkTarget(raw);
    if (target?.kind === 'file' && openFile) void openFile(raw);
    else if (target?.kind === 'web') void openSystemLink(target.url);
  }, [openFile]);

  if (!NativeMarkdownView || props.nativeSelectable === false) {
    return <SafeMarkdown
      compact={props.compact}
      nativeSelectable={props.nativeSelectable}
      onOpenBuiltinBrowser={props.onOpenBuiltinBrowser}
      onOpenFile={openFile}
      streamKey={props.streamKey}
      streaming={props.streaming}
      trimEnd={props.trimEnd}
    >{props.children}</SafeMarkdown>;
  }

  return <View
    onLayout={(event) => {
      const width = event.nativeEvent.layout.width;
      setMarkdownWidth((current) => Math.abs(current - width) > 0.5 ? width : current);
    }}
    style={styles.root}
  >
    <NativeMarkdownView
      compact={props.compact}
      labels={labels}
      markdown={props.children}
      onAddToConversation={props.onAddToConversation
        ? ({ nativeEvent }) => props.onAddToConversation?.(nativeEvent.text)
        : undefined}
      onLinkLongPress={({ nativeEvent }) => setLinkMenu({
        anchor: {
          height: nativeEvent.height,
          width: nativeEvent.width,
          x: nativeEvent.x,
          y: nativeEvent.y,
        },
        url: nativeEvent.url,
      })}
      onLinkPress={({ nativeEvent }) => openLink(nativeEvent.url)}
      streamKey={props.streamKey}
      streaming={props.streaming}
      style={[styles.native, markdownWidth > 0 ? { width: markdownWidth } : undefined]}
      theme={theme}
      trimEnd={props.trimEnd}
    />
    {linkMenu ? <MarkdownLinkMenu
      anchor={linkMenu.anchor}
      onDismiss={() => setLinkMenu(undefined)}
      onOpenBuiltinBrowser={props.onOpenBuiltinBrowser}
      onOpenFile={openFile}
      url={linkMenu.url}
    /> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { alignSelf: 'stretch', minWidth: 0 },
  native: { alignSelf: 'stretch', minHeight: 1, width: '100%' },
});
