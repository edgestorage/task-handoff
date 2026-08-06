import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, PixelRatio, Platform, ScrollView, StyleSheet, Text, View, type TextLayoutEvent, type TextStyle } from 'react-native';
import Markdown, { AstRenderer, MarkdownIt, renderRules, type ASTNode, type RenderRules } from 'react-native-markdown-renderer';
import { common, createLowlight } from 'lowlight';

import { openSystemLink } from '../platform/links';
import { useMobileTheme, type MobileThemeColors } from './theme';
import { useStreamingMarkdown } from './useStreamingMarkdown';

// Keep one parser configuration for snapshots and streaming updates. Raw HTML is
// deliberately disabled: session output is untrusted and must remain text.
const markdownParser = MarkdownIt({
  breaks: true,
  html: false,
  linkify: false,
  typographer: true,
});
const codeHighlighter = createLowlight(common);

export function safeMarkdownLink(raw: string) {
  try {
    const url = new URL(raw);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize protocol text before parsing. HTML safety is enforced by the
 * MarkdownIt configuration instead of a tag-shaped regex, which could corrupt
 * ordinary text such as generic type parameters.
 */
export function sanitizeMarkdown(markdown: string) {
  return markdown.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
}

type MarkdownToken = { children?: MarkdownToken[] | null; content?: string; type: string };

export function markdownPlainText(markdown: string) {
  const output: string[] = [];
  const visit = (tokens: readonly MarkdownToken[]) => {
    for (const token of tokens) {
      if (token.children?.length) visit(token.children);
      else if (['text', 'code_inline', 'code_block', 'fence'].includes(token.type) && token.content) output.push(token.content);
      if (['softbreak', 'hardbreak', 'paragraph_close', 'heading_close', 'list_item_close'].includes(token.type)) output.push('\n');
    }
  };
  visit(markdownParser.parse(sanitizeMarkdown(markdown), {}) as MarkdownToken[]);
  return output.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function SafeMarkdown({
  children,
  compact = false,
  streamKey,
  streaming = false,
  trimEnd = false,
}: {
  children: string;
  compact?: boolean;
  streamKey?: string;
  streaming?: boolean;
  trimEnd?: boolean;
}) {
  const { colors } = useMobileTheme();
  const styles = useMemo(() => markdownStyles(colors, compact), [colors, compact]);
  const reducedMotion = useReduceMotion(Boolean(streamKey));
  const paced = useStreamingMarkdown(sanitizeMarkdown(children), streaming, streamKey);
  const rules = useMemo(() => createRules(paced.revealEnabled, reducedMotion, trimEnd), [paced.revealEnabled, reducedMotion, trimEnd]);
  const renderer = useMemo(() => new AstRenderer(
    { ...renderRules, ...rules },
    styles,
    {
      defaultImageHandler: null,
      onLinkPress: (raw) => {
        const url = safeMarkdownLink(raw);
        if (url) void openSystemLink(url);
        return false;
      },
    },
  ), [rules, styles]);
  const renderStableTree = useMemo(() => function StableMarkdownTree(nodes: ASTNode[]) {
    stabilizeAstKeys(nodes);
    return <View style={styles.root}>{nodes.map((node) => renderer.renderNode(node, []))}</View>;
  }, [renderer, styles.root]);

  return (
    <Markdown
      markdownit={markdownParser}
      renderer={renderStableTree}
    >
      {paced.visible}
    </Markdown>
  );
}

type SafeMarkdownStyles = ReturnType<typeof markdownStyles>;
type SafeRenderRule = (node: ASTNode, children: ReactNode[], parentNodes: ASTNode[], styles: SafeMarkdownStyles) => ReactNode;

export const CHARACTER_FADE_MS = 150;
type RevealSegment = { id: number; opacity: Animated.Value; settled: boolean; text: string };
type RevealState = { pending: RevealSegment[]; settled: string };

export function StreamingMarkdownText({ animate, content }: { animate: boolean; content: string }) {
  const [state, setState] = useState<RevealState>({ pending: [], settled: animate ? '' : content });
  const stateRef = useRef(state);
  const animations = useRef(new Map<number, Animated.CompositeAnimation>());
  const nextId = useRef(0);

  const publish = useCallback((next: RevealState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopPending = useCallback(() => {
    for (const animation of animations.current.values()) animation.stop();
    animations.current.clear();
  }, []);

  const settle = useCallback((id: number) => {
    animations.current.delete(id);
    const current = stateRef.current;
    const pending = current.pending.map((segment) => segment.id === id ? { ...segment, settled: true } : segment);
    let settled = current.settled;
    let settledCount = 0;
    while (settledCount < pending.length && pending[settledCount].settled) {
      settled += pending[settledCount].text;
      settledCount += 1;
    }
    publish({ settled, pending: pending.slice(settledCount) });
  }, [publish]);

  useEffect(() => {
    const current = stateRef.current;
    const rendered = current.settled + current.pending.map((segment) => segment.text).join('');
    if (!animate) {
      stopPending();
      if (rendered !== content || current.pending.length) publish({ pending: [], settled: content });
      return;
    }
    if (!content.startsWith(rendered)) {
      stopPending();
      publish({ pending: [], settled: content });
      return;
    }

    const addition = content.slice(rendered.length);
    if (!addition) return;
    const segments = splitGraphemes(addition).map((text) => ({
      id: ++nextId.current,
      opacity: new Animated.Value(0),
      settled: false,
      text,
    }));
    publish({ ...current, pending: [...current.pending, ...segments] });
    for (const segment of segments) {
      const animation = Animated.timing(segment.opacity, {
        duration: CHARACTER_FADE_MS,
        easing: Easing.out(Easing.ease),
        isInteraction: false,
        toValue: 1,
        useNativeDriver: true,
      });
      animations.current.set(segment.id, animation);
      animation.start(() => settle(segment.id));
    }
  }, [animate, content, publish, settle, stopPending]);

  useEffect(() => () => stopPending(), [stopPending]);

  return <>{state.settled}{state.pending.map((segment) => (
    <Animated.Text key={segment.id} style={{ opacity: segment.opacity }}>{segment.text}</Animated.Text>
  ))}</>;
}

function splitGraphemes(value: string) {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string | string[], options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;
  return Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value), (entry) => entry.segment)
    : Array.from(value);
}

function useReduceMotion(active: boolean) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setEnabled(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setEnabled);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [active]);
  return active && enabled;
}

function stabilizeAstKeys(nodes: ASTNode[], parentPath = 'root') {
  nodes.forEach((node, index) => {
    node.key = `${parentPath}.${index}:${node.type}`;
    if (parentPath === 'root') {
      node.attributes.__safeTopLevelFirst = index === 0 ? 'true' : 'false';
      node.attributes.__safeTopLevelLast = index === nodes.length - 1 ? 'true' : 'false';
    }
    stabilizeAstKeys(node.children, node.key);
  });
}

function createRules(revealEnabled: boolean, reducedMotion: boolean, trimEnd: boolean): RenderRules {
  const rules: Record<string, SafeRenderRule> = {
    ...flowRules,
    text: (node, _children, parentNodes) => (
      <Text key={node.key}>
        <StreamingMarkdownText
          animate={shouldAnimateMarkdownText(revealEnabled, reducedMotion, parentNodes.map((parent) => parent.type))}
          content={node.content}
        />
      </Text>
    ),
  };
  if (trimEnd) rules.paragraph = trimEndParagraph;
  return rules as unknown as RenderRules;
}

export function shouldAnimateMarkdownText(revealEnabled: boolean, reducedMotion: boolean, parentTypes: readonly string[]) {
  return revealEnabled && !reducedMotion && !parentTypes.some((type) => ['table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(type));
}

const flowRules: Record<string, SafeRenderRule> = {
  heading1: (node, children, parentNodes, styles) => renderHeading(node, children, parentNodes, styles, 'heading1'),
  heading2: (node, children, parentNodes, styles) => renderHeading(node, children, parentNodes, styles, 'heading2'),
  heading3: (node, children, parentNodes, styles) => renderHeading(node, children, parentNodes, styles, 'heading3'),
  heading4: (node, children, parentNodes, styles) => renderHeading(node, children, parentNodes, styles, 'heading4'),
  heading5: (node, children, parentNodes, styles) => renderHeading(node, children, parentNodes, styles, 'heading5'),
  heading6: (node, children, parentNodes, styles) => renderHeading(node, children, parentNodes, styles, 'heading6'),
  code_inline: renderInlineCode,
  code_block: renderCodeBlock,
  fence: renderCodeBlock,
  table: (node, children, _parentNodes, styles) => (
    <ScrollView
      contentContainerStyle={styles.tableScrollContent}
      horizontal
      key={node.key}
      showsHorizontalScrollIndicator={false}
      style={styles.tableScroll}
      testID="markdown-table-scroll"
    >
      <View style={styles.table}>{children}</View>
    </ScrollView>
  ),
  tr: (node, children, parentNodes, styles) => {
    const parent = parentNodes[0];
    const isBodyRow = parent?.type === 'tbody';
    const isLastRow = parent?.children.at(-1)?.key === node.key;
    return <View key={node.key} style={[styles.tr, isBodyRow && node.index % 2 === 1 && styles.tableStripeRow, isLastRow && styles.tableLastRow]}>{children}</View>;
  },
  th: (node, children, parentNodes, styles) => renderTableCell(node, children, parentNodes, styles, true),
  td: (node, children, parentNodes, styles) => renderTableCell(node, children, parentNodes, styles, false),
  list_item: (node, children, parentNodes, styles) => {
    const bulletList = parentNodes.find((parent) => parent.type === 'bullet_list');
    if (bulletList) return (
      <View key={node.key} style={styles.list_item}>
        <Text accessible={false} style={styles.bullet_list_icon}>{'\u2022'}</Text>
        <View style={styles.bullet_list_content} testID="markdown-list-item-content">{children}</View>
      </View>
    );
    const orderedList = parentNodes.find((parent) => parent.type === 'ordered_list');
    if (orderedList) {
      const start = Number.parseInt(orderedList.attributes.start ?? '1', 10) || 1;
      return (
        <View key={node.key} style={styles.list_item}>
          <Text style={styles.ordered_list_icon}>{start + node.index}{node.markup}</Text>
          <View style={styles.ordered_list_content} testID="markdown-list-item-content">{children}</View>
        </View>
      );
    }
    return <View key={node.key} style={styles.list_item}>{children}</View>;
  },
};

function renderInlineCode(
  node: ASTNode,
  _children: ReactNode[],
  _parentNodes: ASTNode[],
  styles: SafeMarkdownStyles,
) {
  return <InlineCode content={node.content} key={node.key} styles={styles} />;
}

function InlineCode({ content, styles }: { content: string; styles: SafeMarkdownStyles }) {
  const [bodyBaseline, setBodyBaseline] = useState<number>();
  const [codeBaseline, setCodeBaseline] = useState<number>();
  const handleBodyLayout = useCallback((event: TextLayoutEvent) => {
    if (Platform.OS !== 'ios') return;
    const line = event.nativeEvent.lines[0];
    if (line) setBodyBaseline(line.y + line.ascender);
  }, []);
  const handleCodeLayout = useCallback((event: TextLayoutEvent) => {
    if (Platform.OS !== 'ios') return;
    const line = event.nativeEvent.lines[0];
    if (line) setCodeBaseline(line.y + line.ascender);
  }, []);
  // Both Text boxes start at the row's top. Align their measured baselines,
  // while moving the complete rounded box so its internal centering is intact.
  const baselineOffset = bodyBaseline !== undefined && codeBaseline !== undefined
    ? bodyBaseline - codeBaseline
    : 0;
  return (
    <View
      style={[styles.codeInlineContainer, baselineOffset !== 0 && { transform: [{ translateY: baselineOffset }] }]}
      testID="markdown-inline-code"
    >
      {Platform.OS === 'ios' && (
        <Text
          accessible={false}
          onTextLayout={handleBodyLayout}
          style={[styles.text, styles.codeInlineBaselineProbe]}
          testID="markdown-inline-code-baseline-probe"
        >
          Ag
        </Text>
      )}
      <Text onTextLayout={handleCodeLayout} style={styles.codeInlineText} testID="markdown-inline-code-text">{content}</Text>
    </View>
  );
}

type HighlightNode = ReturnType<typeof codeHighlighter.highlight>['children'][number];

function renderCodeBlock(
  node: ASTNode,
  _children: ReactNode[],
  _parentNodes: ASTNode[],
  styles: SafeMarkdownStyles,
) {
  const content = typeof node.content === 'string' ? node.content.replace(/\n$/, '') : '';
  // A horizontal ScrollView needs an explicit cross-axis size inside a
  // virtualized list. Include the current accessibility font scale so the
  // explicit height never clips enlarged code text.
  const blockHeight = Math.ceil(Math.max(1, content.split('\n').length) * 20 * PixelRatio.getFontScale() + 24);
  const language = String((node as typeof node & { sourceInfo?: unknown }).sourceInfo ?? '').trim().split(/\s+/, 1)[0].toLowerCase();
  let highlighted: HighlightNode[] | undefined;
  if (language && codeHighlighter.registered(language)) {
    try {
      highlighted = codeHighlighter.highlight(language, content, { prefix: 'hljs-' }).children;
    } catch {
      highlighted = undefined;
    }
  }
  return (
    <View key={node.key} style={styles.codeBlockContainer}>
      <ScrollView contentContainerStyle={styles.codeBlockScrollContent} horizontal showsHorizontalScrollIndicator={false} style={{ height: blockHeight }} testID="markdown-code-scroll">
        <Text selectable style={styles.codeBlockText}>
          {highlighted ? highlighted.map((child, index) => renderHighlightNode(child, `${node.key}:${index}`, styles)) : content}
        </Text>
      </ScrollView>
    </View>
  );
}

function renderHighlightNode(
  node: HighlightNode,
  key: string,
  styles: SafeMarkdownStyles,
): React.ReactNode {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return null;
  const classNames = Array.isArray(node.properties.className) ? node.properties.className.filter((value): value is string => typeof value === 'string') : [];
  return (
    <Text key={key} style={highlightTokenStyles(classNames, styles)}>
      {node.children.map((child, index) => renderHighlightNode(child, `${key}:${index}`, styles))}
    </Text>
  );
}

function highlightTokenStyles(classNames: string[], styles: SafeMarkdownStyles) {
  const result: TextStyle[] = [];
  for (const className of classNames) {
    const scope = className.replace(/^hljs-/, '');
    if (['comment', 'quote', 'meta'].includes(scope)) result.push(styles.syntaxComment);
    else if (['keyword', 'selector-tag', 'doctag', 'deletion'].includes(scope)) result.push(styles.syntaxKeyword);
    else if (['string', 'regexp', 'addition', 'attribute'].includes(scope)) result.push(styles.syntaxString);
    else if (['number', 'literal', 'symbol', 'bullet'].includes(scope)) result.push(styles.syntaxNumber);
    else if (['title', 'section', 'selector-id', 'selector-class'].includes(scope)) result.push(styles.syntaxTitle);
    else if (['built_in', 'type', 'class'].includes(scope)) result.push(styles.syntaxType);
    else if (scope === 'emphasis') result.push(styles.syntaxEmphasis);
    else if (scope === 'strong') result.push(styles.syntaxStrong);
  }
  return result;
}

function renderTableCell(
  node: ASTNode,
  children: ReactNode[],
  parentNodes: ASTNode[],
  styles: SafeMarkdownStyles,
  header: boolean,
) {
  const parent = parentNodes[0];
  const isLastColumn = parent?.children.at(-1)?.key === node.key;
  return (
    <View key={node.key} style={[header ? styles.th : styles.td, node.index === 0 && styles.tableFirstColumn, isLastColumn && styles.tableLastColumn]}>
      {children}
    </View>
  );
}

const trimEndParagraph: SafeRenderRule = (node, children, _parentNodes, styles) => {
  const isFinalTopLevelParagraph = node.attributes.__safeTopLevelLast === 'true';
  return <View key={node.key} style={[styles.paragraph, isFinalTopLevelParagraph && styles.flushEnd]}>{children}</View>;
};

function renderHeading(
  node: ASTNode,
  children: ReactNode[],
  _parentNodes: ASTNode[],
  styles: SafeMarkdownStyles,
  styleName: 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6',
) {
  const isFirstTopLevelNode = node.attributes.__safeTopLevelFirst === 'true';
  return <View key={node.key} style={[styles[styleName], isFirstTopLevelNode && styles.flushStart]}>{children}</View>;
}

function markdownStyles(colors: MobileThemeColors, compact: boolean) {
  const codeFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  const bodySize = compact ? 13 : 15;
  const bodyLineHeight = compact ? 20 : 23;
  return StyleSheet.create({
    root: {},
    body: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight },
    text: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight },
    textgroup: { color: colors.text },
    paragraph: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: compact ? 4 : 9, marginTop: 0 },
    flushStart: { marginTop: 0 },
    flushEnd: { marginBottom: 0 },
    heading1: { color: colors.text, flexDirection: 'row', fontSize: compact ? 17 : 25, fontWeight: '700', lineHeight: compact ? 22 : 32, marginBottom: compact ? 5 : 7, marginTop: compact ? 8 : 15 },
    heading2: { color: colors.text, flexDirection: 'row', fontSize: compact ? 16 : 21, fontWeight: '700', lineHeight: compact ? 21 : 28, marginBottom: compact ? 5 : 7, marginTop: compact ? 8 : 15 },
    heading3: { color: colors.text, flexDirection: 'row', fontSize: compact ? 15 : 18, fontWeight: '700', lineHeight: compact ? 20 : 25, marginBottom: compact ? 5 : 7, marginTop: compact ? 8 : 15 },
    heading4: { color: colors.text, flexDirection: 'row', fontSize: 16, fontWeight: '700', lineHeight: 23, marginBottom: 7, marginTop: 15 },
    heading5: { color: colors.text, flexDirection: 'row', fontSize: 15, fontWeight: '700', lineHeight: 23, marginBottom: 7, marginTop: 15 },
    heading6: { color: colors.textMuted, flexDirection: 'row', fontSize: 15, fontWeight: '700', lineHeight: 23, marginBottom: 7, marginTop: 15 },
    strong: { fontWeight: '700' },
    em: { fontStyle: 'italic' },
    s: { textDecorationLine: 'line-through' },
    strikethrough: { textDecorationLine: 'line-through' },
    link: { color: colors.primary, textDecorationLine: 'underline' },
    blocklink: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
    blockquote: { borderLeftColor: colors.border, borderLeftWidth: 3, marginBottom: 11, marginLeft: 0, paddingHorizontal: 13, paddingVertical: 7 },
    list: { marginBottom: 9 },
    list_item: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'flex-start', marginBottom: 3 },
    bullet_list_icon: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight, marginLeft: 2, marginRight: 9 },
    bullet_list_content: { flex: 0, flexShrink: 1 },
    ordered_list_icon: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight, marginLeft: 0, marginRight: 9 },
    ordered_list_content: { flex: 0, flexShrink: 1 },
    code_inline: {},
    codeInline: {},
    codeInlineContainer: { alignSelf: 'flex-start', backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, flexShrink: 1, maxWidth: '100%', overflow: 'hidden', paddingHorizontal: 4 },
    codeInlineBaselineProbe: { opacity: 0, position: 'absolute' },
    codeInlineText: { color: colors.text, flexShrink: 1, fontFamily: codeFont, fontSize: 13, lineHeight: 20 },
    code_block: {},
    fence: {},
    codeBlockContainer: { backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, marginBottom: 11, overflow: 'hidden' },
    codeBlockScrollContent: { paddingHorizontal: 14, paddingVertical: 12 },
    codeBlockText: { color: colors.text, fontFamily: codeFont, fontSize: 13, lineHeight: 20 },
    syntaxComment: { color: colors.syntaxComment, fontStyle: 'italic' },
    syntaxKeyword: { color: colors.syntaxKeyword, fontWeight: '600' },
    syntaxString: { color: colors.syntaxString },
    syntaxNumber: { color: colors.syntaxNumber },
    syntaxTitle: { color: colors.syntaxTitle, fontWeight: '600' },
    syntaxType: { color: colors.syntaxType },
    syntaxEmphasis: { fontStyle: 'italic' },
    syntaxStrong: { fontWeight: '700' },
    pre: { marginBottom: 11 },
    hr: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginBottom: 15, marginTop: 6 },
    tableScroll: { marginBottom: 11, maxWidth: '100%' },
    tableScrollContent: { flexGrow: 1 },
    table: { alignSelf: 'flex-start', borderColor: colors.border, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    thead: { backgroundColor: colors.surfaceMuted },
    tbody: {},
    th: { borderRightColor: colors.border, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 9, width: 112 },
    tr: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
    td: { borderRightColor: colors.border, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 9, width: 112 },
    tableFirstColumn: { width: 148 },
    tableLastColumn: { borderRightWidth: 0 },
    tableLastRow: { borderBottomWidth: 0 },
    tableStripeRow: { backgroundColor: colors.tableStripe },
    image: { borderRadius: 8 },
    hardbreak: { height: 1, width: '100%' },
    softbreak: {},
    inline: {},
    span: {},
  });
}
