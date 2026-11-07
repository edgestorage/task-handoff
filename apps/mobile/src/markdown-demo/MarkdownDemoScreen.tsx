import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import NativeMarkdownView, { isTaskHandoffMarkdownAvailable } from '../../modules/task-handoff-markdown';
import { AnimatedSegmentedControl } from '../components/AnimatedSegmentedControl';
import { Icon } from '../components/Icon';
import { MarkdownLinkMenu } from '../components/MarkdownLinkMenu';
import { type FloatingMenuAnchor } from '../components/menu/FloatingMenu';
import { SafeMarkdown } from '../components/SafeMarkdown';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { openSystemLink } from '../platform/links';

type MarkdownDensity = 'standard' | 'compact';
type MarkdownRenderer = 'native' | 'safe';

export const markdownDemoSource = [
  '# Markdown 渲染示例',
  '',
  '这是一段普通正文，包含 **粗体**、*斜体*、~~删除线~~、`inline code` 和 [外部链接](https://example.com)。行内链接会使用主题色和统一的下划线样式。',
  '',
  '## 标题层级',
  '',
  '### 三级标题',
  '',
  '#### 四级标题',
  '',
  '##### 五级标题',
  '',
  '###### 六级标题',
  '',
  '> 引用块用于突出上下文或补充说明。',
  '>',
  '> 第二段引用仍然保持相同的内容缩进。',
  '',
  '### 列表',
  '',
  '- 无序列表第一项',
  '- 无序列表第二项，包含 **加粗文字** 和 `inline code`',
  '  1. 嵌套有序列表',
  '  2. 第二项',
  '- 无序列表第三项',
  '',
  '1. 有序列表第一项',
  '2. 有序列表第二项',
  '3. 有序列表第三项',
  '',
  '### 代码块',
  '',
  '```ts',
  "type SessionState = 'idle' | 'running' | 'waiting';",
  '',
  'export function sessionLabel(state: SessionState) {',
  "  if (state === 'running') return 'Running';",
  "  if (state === 'waiting') return 'Waiting for approval';",
  "  return 'Idle';",
  '}',
  '```',
  '',
  '### 原生图表',
  '',
  '```mermaid',
  'graph TD',
  '  A[User] --> B[Control Plane]',
  '  B --> C[Node Agent]',
  '  C --> D[Controlled Instance]',
  '```',
  '',
  '### 表格',
  '',
  '| 状态 | 含义 | 处理方式 |',
  '| --- | --- | --- |',
  '| Running | 模型正在生成内容 | 保持流式更新 |',
  '| Waiting | 等待用户确认 | 显示审批入口 |',
  '| Idle | 当前没有任务 | 可继续发送消息 |',
  '',
  '---',
  '',
  '### 结束',
  '',
  '页面底部保留最后一行，用来检查段落间距和滚动边界。原生 Markdown 渲染会继续沿用当前会话页的样式与安全链路。',
].join('\n');

export function MarkdownDemoScreen() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [density, setDensity] = useState<MarkdownDensity>('standard');
  const [renderer, setRenderer] = useState<MarkdownRenderer>('native');
  const [markdownValue, setMarkdownValue] = useState(markdownDemoSource);
  const [streaming, setStreaming] = useState(false);
  const [streamKey, setStreamKey] = useState('markdown-demo-static');
  const [markdownWidth, setMarkdownWidth] = useState(0);
  const [nativeLinkMenu, setNativeLinkMenu] = useState<{ anchor: FloatingMenuAnchor; url: string }>();
  const scrollRef = useRef<ScrollView>(null);
  const streamTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const labels = useMemo(() => ({
    copied: t('sessions.codeCopied'),
    copy: t('sessions.copyCode'),
    plainText: t('sessions.plainText'),
  }), [t]);
  const theme = useMemo(() => ({
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

  useEffect(() => () => {
    if (streamTimer.current) clearTimeout(streamTimer.current);
  }, []);

  const startStreaming = useCallback(() => {
    if (streamTimer.current) clearTimeout(streamTimer.current);
    const graphemes = Array.from(markdownDemoSource);
    let cursor = 0;
    setMarkdownValue('');
    setStreamKey(`markdown-demo-${Date.now()}`);
    setStreaming(true);
    setNativeLinkMenu(undefined);
    scrollRef.current?.scrollTo({ animated: false, y: 0 });

    const appendChunk = () => {
      cursor = Math.min(graphemes.length, cursor + 6);
      setMarkdownValue(graphemes.slice(0, cursor).join(''));
      if (cursor >= graphemes.length) {
        streamTimer.current = undefined;
        setStreaming(false);
        return;
      }
      streamTimer.current = setTimeout(appendChunk, 28);
    };
    streamTimer.current = setTimeout(appendChunk, 120);
  }, []);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(148, insets.bottom + 132) }]}
        ref={scrollRef}
        style={styles.screen}
        testID="markdown-demo-screen"
      >
        <View style={[styles.intro, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.eyebrow, { color: colors.textMuted }]}>NATIVE / REACT NATIVE COMPARISON</Text>
          <Text style={[styles.title, { color: colors.text }]}>Markdown 渲染效果</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>
            使用同一份内容、主题和排版密度，在原生 TaskHandoffMarkdown 与 React Native SafeMarkdown 之间实时切换。
          </Text>
          <AnimatedSegmentedControl<MarkdownDensity>
            accessibilityLabel="Markdown 排版密度"
            labelStyle={styles.segmentLabel}
            onChange={setDensity}
            options={[
              { label: '标准', testID: 'markdown-demo-standard', value: 'standard' },
              { label: '紧凑', testID: 'markdown-demo-compact', value: 'compact' },
            ]}
            testID="markdown-demo-density"
            value={density}
          />
        </View>

        <View style={[styles.preview, { backgroundColor: colors.background, borderColor: colors.border }]} testID="markdown-demo-preview">
          <View style={[styles.previewHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
            <Text style={[styles.previewTitle, { color: colors.text }]}>Assistant response</Text>
            <Text style={[styles.previewMeta, { color: colors.textMuted }]}>
              {streaming ? 'Streaming' : renderer === 'native' ? 'Native iOS' : 'SafeMarkdown'} · {density === 'standard' ? '16 pt' : '13 pt'}
            </Text>
          </View>
          <View
            onLayout={(event) => setMarkdownWidth(Math.max(1, event.nativeEvent.layout.width - 32))}
            style={styles.markdown}
          >
            {renderer === 'native' ? (isTaskHandoffMarkdownAvailable ? <NativeMarkdownView
              compact={density === 'compact'}
              labels={labels}
              markdown={markdownValue}
              onLinkPress={({ nativeEvent }) => { void openSystemLink(nativeEvent.url); }}
              onLinkLongPress={({ nativeEvent }) => {
                setNativeLinkMenu({
                  anchor: {
                    height: nativeEvent.height,
                    width: nativeEvent.width,
                    x: nativeEvent.x,
                    y: nativeEvent.y,
                  },
                  url: nativeEvent.url,
                });
              }}
              streamKey={streamKey}
              streaming={streaming}
              style={[styles.nativeMarkdown, markdownWidth ? { width: markdownWidth } : undefined]}
              theme={theme}
              trimEnd
            /> : <Text style={[styles.unavailable, { color: colors.textMuted }]}>原生 iOS Markdown 模块不可用，请重新构建包含 TaskHandoffMarkdown 的应用。</Text>)
              : <SafeMarkdown compact={density === 'compact'} streamKey={streamKey} streaming={streaming} trimEnd>{markdownValue}</SafeMarkdown>}
          </View>
        </View>
      </ScrollView>

      {nativeLinkMenu && renderer === 'native' ? <MarkdownLinkMenu
        anchor={nativeLinkMenu.anchor}
        onDismiss={() => setNativeLinkMenu(undefined)}
        url={nativeLinkMenu.url}
      /> : null}

      <View pointerEvents="box-none" style={[styles.floatingControls, { bottom: Math.max(12, insets.bottom + 8) }]}>
        <View style={[styles.controlsCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <AnimatedSegmentedControl<MarkdownRenderer>
            accessibilityLabel="Markdown 渲染实现"
            labelStyle={styles.segmentLabel}
            onChange={setRenderer}
            options={[
              { label: '原生 iOS', testID: 'markdown-demo-renderer-native', value: 'native' },
              { label: 'SafeMarkdown', testID: 'markdown-demo-renderer-safe', value: 'safe' },
            ]}
            testID="markdown-demo-renderer"
            value={renderer}
          />
          <Pressable
            accessibilityLabel={streaming ? '正在流式输出' : '播放流式效果'}
            accessibilityRole="button"
            accessibilityState={{ disabled: streaming }}
            disabled={streaming}
            onPress={startStreaming}
            style={({ pressed }) => [styles.streamButton, { backgroundColor: colors.primaryButton, opacity: streaming ? 0.72 : pressed ? 0.86 : 1 }]}
            testID="markdown-demo-stream"
          >
            {streaming ? <ActivityIndicator color="#ffffff" size="small" /> : <Icon color="#ffffff" name="play" size={16} />}
            <Text style={styles.streamButtonText}>{streaming ? '正在流式输出…' : '播放流式效果'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { gap: 14, paddingHorizontal: 16, paddingTop: 16 },
  intro: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 16 },
  eyebrow: { fontSize: 12, fontWeight: '500', letterSpacing: 0.7, lineHeight: 16 },
  title: { fontSize: 24, fontWeight: '700', lineHeight: 30 },
  description: { fontSize: 14, lineHeight: 20 },
  segmentLabel: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
  preview: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  previewHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: 16,
  },
  previewTitle: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
  previewMeta: { fontSize: 12, lineHeight: 16 },
  markdown: { padding: 16 },
  nativeMarkdown: { alignSelf: 'stretch', minHeight: 1, width: '100%' },
  unavailable: { fontSize: 14, lineHeight: 20 },
  floatingControls: { left: 16, position: 'absolute', right: 16 },
  controlsCard: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    padding: 10,
    shadowColor: '#000000',
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
  },
  streamButton: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 42, paddingHorizontal: 14 },
  streamButtonText: { color: '#ffffff', fontSize: 14, fontWeight: '500', lineHeight: 20 },
});
