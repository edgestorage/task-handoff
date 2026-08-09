import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, PixelRatio, Platform, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { UITextView as SelectableText } from '@bsky.app/react-native-uitextview';
import * as Clipboard from 'expo-clipboard';
import { Check, Copy } from 'lucide-react-native';
import Markdown, { AstRenderer, MarkdownIt, renderRules, type ASTNode, type RenderRules } from 'react-native-markdown-renderer';
import { common, createLowlight } from 'lowlight';

import { useI18n } from '../i18n';
import { openSystemLink } from '../platform/links';
import { splitGraphemes } from './graphemes';
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

export function hasUnclosedMarkdownFence(markdown: string) {
  let open: { marker: '`' | '~'; length: number } | undefined;
  for (const line of markdown.split('\n')) {
    if (open) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === open.marker && closing[1].length >= open.length) open = undefined;
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!opening) continue;
    const marker = opening[1][0] as '`' | '~';
    // CommonMark does not allow backticks in the info string of a backtick fence.
    if (marker === '`' && opening[2].includes('`')) continue;
    open = { marker, length: opening[1].length };
  }
  return open !== undefined;
}

type MarkdownToken = {
  block?: boolean;
  children?: MarkdownToken[] | null;
  content?: string;
  level?: number;
  map?: [number, number] | null;
  nesting?: number;
  type: string;
};

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

export function streamingMarkdownStableCutoff(markdown: string) {
  const tokens = markdownParser.parse(markdown, {}) as MarkdownToken[];
  const starts = tokens
    .filter((token) => token.block && token.level === 0 && token.map && token.nesting !== -1)
    .map((token) => token.map![0])
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1]);
  if (starts.length < 2) return 0;
  const cutoffLine = starts.at(-1)!;
  let cutoff = 0;
  for (let line = 0; line < cutoffLine; line += 1) {
    const newline = markdown.indexOf('\n', cutoff);
    if (newline < 0) return 0;
    cutoff = newline + 1;
  }
  // Reference definitions are document-scoped and can change the meaning of
  // earlier bracket syntax. Keep such content in the mutable tail.
  return markdown.slice(0, cutoff).includes('[') ? 0 : cutoff;
}

type StreamingMarkdownBlock = { id: number; source: string };
type StreamingBlockState = {
  nextId: number;
  source: string;
  stable: StreamingMarkdownBlock[];
  tail: StreamingMarkdownBlock;
};

export function advanceStreamingMarkdownBlocks(previous: StreamingBlockState, source: string): StreamingBlockState {
  if (!source.startsWith(previous.source)) return {
    nextId: previous.nextId + 1,
    source,
    stable: [],
    tail: { id: previous.nextId, source },
  };
  let tail = previous.tail.source + source.slice(previous.source.length);
  const cutoff = streamingMarkdownStableCutoff(tail);
  if (!cutoff) return { ...previous, source, tail: { ...previous.tail, source: tail } };
  const stable = [...previous.stable, { ...previous.tail, source: tail.slice(0, cutoff) }];
  tail = tail.slice(cutoff);
  return {
    nextId: previous.nextId + 1,
    source,
    stable,
    tail: { id: previous.nextId, source: tail },
  };
}

class StreamingMarkdownBlockAccumulator {
  private value: StreamingBlockState = {
    nextId: 1,
    source: '',
    stable: [],
    tail: { id: 0, source: '' },
  };

  constructor(readonly streamKey?: string) {}

  advance(source: string) {
    this.value = advanceStreamingMarkdownBlocks(this.value, source);
    return this.value;
  }
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
  const blockAccumulator = useMemo(() => new StreamingMarkdownBlockAccumulator(streamKey), [streamKey]);
  const blocks = streaming
    ? blockAccumulator.advance(paced.visible)
    : undefined;
  const sources: StreamingMarkdownBlock[] = blocks
    ? [...blocks.stable, blocks.tail]
    : [{ id: 0, source: paced.visible }];
  const deferFinalCodeHighlight = streaming && hasUnclosedMarkdownFence(blocks?.tail.source ?? paced.visible);
  // The map is intentionally replaced when the authoritative stream identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const textStreamState = useMemo(() => new Map<string, string>(), [streamKey]);
  const rules = useMemo(
    () => createRules(paced.revealEnabled, reducedMotion, trimEnd, deferFinalCodeHighlight, streamKey, textStreamState),
    [deferFinalCodeHighlight, paced.revealEnabled, reducedMotion, streamKey, textStreamState, trimEnd],
  );
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
  return (
    <View style={styles.root}>
      {sources.map((block, index) => (
        <MarkdownChunk
          first={index === 0}
          key={block.id}
          last={index === sources.length - 1}
          renderer={renderer}
          source={block.source}
          treeKey={`block:${block.id}`}
        />
      ))}
    </View>
  );
}

const MarkdownChunk = memo(function MarkdownChunk({
  first,
  last,
  renderer,
  source,
  treeKey,
}: {
  first: boolean;
  last: boolean;
  renderer: AstRenderer;
  source: string;
  treeKey: string;
}) {
  const renderTree = useMemo(() => function StableMarkdownTree(nodes: ASTNode[]) {
    stabilizeAstKeys(nodes, treeKey, first, last);
    return <>{nodes.map((node) => renderer.renderNode(node, []))}</>;
  }, [first, last, renderer, treeKey]);
  return <Markdown markdownit={markdownParser} renderer={renderTree}>{source}</Markdown>;
});

type SafeMarkdownStyles = ReturnType<typeof markdownStyles>;
type SafeRenderRule = (node: ASTNode, children: ReactNode[], parentNodes: ASTNode[], styles: SafeMarkdownStyles, ...args: unknown[]) => ReactNode;

export const CHARACTER_FADE_MS = 150;
type RevealSegment = { id: number; opacity: Animated.Value; text: string };
type RevealState = { pending: RevealSegment[]; settled: string };

export function initialStreamingText(content: string, animate: boolean, persisted?: string) {
  return persisted && content.startsWith(persisted) ? persisted : animate ? '' : content;
}

export function StreamingMarkdownText({
  animate,
  content,
  sharedState,
  stateKey,
}: {
  animate: boolean;
  content: string;
  sharedState?: Map<string, string>;
  stateKey?: string;
}) {
  const initialPersisted = stateKey ? sharedState?.get(stateKey) : undefined;
  const [state, setState] = useState<RevealState>({
    pending: [],
    settled: initialStreamingText(content, animate, initialPersisted),
  });
  const stateRef = useRef(state);
  const animations = useRef(new Map<number, Animated.CompositeAnimation>());
  const completedSegments = useRef(new Set<number>());
  const settleFrame = useRef<number | undefined>(undefined);
  const renderedContent = useRef(state.settled);
  const nextId = useRef(0);
  const activeStateKey = useRef(stateKey);

  const publish = useCallback((next: RevealState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopPending = useCallback(() => {
    for (const animation of animations.current.values()) animation.stop();
    animations.current.clear();
    completedSegments.current.clear();
    if (settleFrame.current !== undefined) cancelAnimationFrame(settleFrame.current);
    settleFrame.current = undefined;
  }, []);

  const flushSettled = useCallback(() => {
    settleFrame.current = undefined;
    const current = stateRef.current;
    let settled = current.settled;
    let settledCount = 0;
    while (
      settledCount < current.pending.length
      && completedSegments.current.has(current.pending[settledCount].id)
    ) {
      const segment = current.pending[settledCount];
      completedSegments.current.delete(segment.id);
      settled += segment.text;
      settledCount += 1;
    }
    if (settledCount) publish({ settled, pending: current.pending.slice(settledCount) });
  }, [publish]);

  const settle = useCallback((id: number) => {
    animations.current.delete(id);
    completedSegments.current.add(id);
    if (settleFrame.current === undefined) settleFrame.current = requestAnimationFrame(flushSettled);
  }, [flushSettled]);

  useEffect(() => {
    let current = stateRef.current;
    if (activeStateKey.current !== stateKey) {
      stopPending();
      activeStateKey.current = stateKey;
      const persisted = stateKey ? sharedState?.get(stateKey) : undefined;
      current = {
        pending: [],
        settled: initialStreamingText(content, animate, persisted),
      };
      renderedContent.current = current.settled;
      publish(current);
    }
    const rendered = renderedContent.current;
    if (!animate) {
      stopPending();
      if (rendered !== content || current.pending.length) {
        renderedContent.current = content;
        publish({ pending: [], settled: content });
      }
      if (stateKey) sharedState?.set(stateKey, content);
      return;
    }
    if (!content.startsWith(rendered)) {
      stopPending();
      renderedContent.current = content;
      publish({ pending: [], settled: content });
      if (stateKey) sharedState?.set(stateKey, content);
      return;
    }

    const addition = content.slice(rendered.length);
    if (!addition) {
      if (stateKey) sharedState?.set(stateKey, content);
      return;
    }
    const segments = splitGraphemes(addition).map((text) => ({
      id: ++nextId.current,
      opacity: new Animated.Value(0),
      text,
    }));
    renderedContent.current += addition;
    publish({ ...current, pending: [...current.pending, ...segments] });
    for (const segment of segments) {
      const animation = Animated.timing(segment.opacity, {
        duration: CHARACTER_FADE_MS,
        easing: Easing.out(Easing.ease),
        isInteraction: false,
        toValue: 1,
        // Nested React Native Text renders as virtual text. Its opacity is a
        // text attribute, so the native view driver cannot update the glyphs
        // reliably across platforms; keep this animation on the JS driver.
        useNativeDriver: false,
      });
      animations.current.set(segment.id, animation);
      animation.start(({ finished }) => {
        if (finished) settle(segment.id);
        else animations.current.delete(segment.id);
      });
    }
    if (stateKey) sharedState?.set(stateKey, content);
  }, [animate, content, publish, settle, sharedState, stateKey, stopPending]);

  useEffect(() => () => stopPending(), [stopPending]);

  return <>{state.settled}{state.pending.map((segment) => (
    <Animated.Text key={segment.id} style={{ opacity: segment.opacity }}>{segment.text}</Animated.Text>
  ))}</>;
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

function stabilizeAstKeys(
  nodes: ASTNode[],
  parentPath = 'root',
  markFirst = true,
  markLast = true,
  topLevel = true,
  mutableTail = markLast,
) {
  nodes.forEach((node, index) => {
    node.key = `${parentPath}.${index}:${node.type}`;
    node.attributes.__safeMutableTail = mutableTail ? 'true' : 'false';
    if (topLevel) {
      node.attributes.__safeTopLevelFirst = markFirst && index === 0 ? 'true' : 'false';
      node.attributes.__safeTopLevelLast = markLast && index === nodes.length - 1 ? 'true' : 'false';
    }
    stabilizeAstKeys(node.children, node.key, false, false, false, mutableTail);
  });
}

function createRules(
  revealEnabled: boolean,
  reducedMotion: boolean,
  trimEnd: boolean,
  deferFinalCodeHighlight: boolean,
  streamKey?: string,
  textStreamState?: Map<string, string>,
): RenderRules {
  const rules: Record<string, SafeRenderRule> = {
    ...flowRules,
    code_block: (node, children, parentNodes, styles) => renderCodeBlock(
      node,
      children,
      parentNodes,
      styles,
      deferFinalCodeHighlight && node.attributes.__safeMutableTail === 'true',
    ),
    fence: (node, children, parentNodes, styles) => renderCodeBlock(
      node,
      children,
      parentNodes,
      styles,
      deferFinalCodeHighlight && node.attributes.__safeMutableTail === 'true',
    ),
    text: (node, _children, parentNodes) => (
      <SelectableText key={node.key} selectable uiTextView>
        <StreamingMarkdownText
          animate={shouldAnimateMarkdownText(revealEnabled, reducedMotion, parentNodes.map((parent) => parent.type))}
          content={node.content}
          sharedState={textStreamState}
          stateKey={streamKey ? `${streamKey}:${node.key}` : undefined}
        />
      </SelectableText>
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
  paragraph: (node, children, _parentNodes, styles) => (
    <SelectableText key={node.key} selectable style={styles.paragraph} testID="markdown-selectable-text" uiTextView>{children}</SelectableText>
  ),
  textgroup: (node, children, _parentNodes, styles) => (
    <SelectableText key={node.key} selectable style={styles.text} uiTextView>{children}</SelectableText>
  ),
  inline: (node, children) => <SelectableText key={node.key} selectable uiTextView>{children}</SelectableText>,
  span: (node, children) => <SelectableText key={node.key} selectable uiTextView>{children}</SelectableText>,
  strong: (node, children, _parentNodes, styles) => (
    <SelectableText key={node.key} selectable style={styles.strong} uiTextView>{children}</SelectableText>
  ),
  s: (node, children, _parentNodes, styles) => (
    <SelectableText key={node.key} selectable style={styles.strikethrough} uiTextView>{children}</SelectableText>
  ),
  em: (node, children, _parentNodes, styles) => (
    <SelectableText key={node.key} selectable style={styles.em} uiTextView>{children}</SelectableText>
  ),
  u: (node, children) => <SelectableText key={node.key} selectable uiTextView>{children}</SelectableText>,
  link: (node, children, _parentNodes, styles, onLinkPress) => (
    <SelectableText
      key={node.key}
      onPress={() => (onLinkPress as ((raw: string) => boolean | void) | undefined)?.(node.attributes.href)}
      selectable
      style={styles.link}
      uiTextView
    >
      {children}
    </SelectableText>
  ),
  hardbreak: (node) => <SelectableText key={node.key} selectable uiTextView>{'\n'}</SelectableText>,
  softbreak: (node) => <SelectableText key={node.key} selectable uiTextView>{'\n'}</SelectableText>,
  code_inline: renderInlineCode,
  code_block: (node, children, parentNodes, styles) => renderCodeBlock(node, children, parentNodes, styles),
  fence: (node, children, parentNodes, styles) => renderCodeBlock(node, children, parentNodes, styles),
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
  return <SelectableText key={node.key} selectable style={styles.codeInlineText} testID="markdown-inline-code" uiTextView>{node.content}</SelectableText>;
}

type HighlightNode = ReturnType<typeof codeHighlighter.highlight>['children'][number];

function renderCodeBlock(
  node: ASTNode,
  _children: ReactNode[],
  _parentNodes: ASTNode[],
  styles: SafeMarkdownStyles,
  deferHighlight = false,
) {
  const content = typeof node.content === 'string' ? node.content.replace(/\n$/, '') : '';
  const language = String((node as typeof node & { sourceInfo?: unknown }).sourceInfo ?? '').trim().split(/\s+/, 1)[0].toLowerCase();
  return <MarkdownCodeBlock content={content} deferHighlight={deferHighlight} key={node.key} language={language} styles={styles} />;
}

function MarkdownCodeBlock({ content, deferHighlight, language, styles }: { content: string; deferHighlight: boolean; language: string; styles: SafeMarkdownStyles }) {
  const { t } = useI18n();
  const [copiedContent, setCopiedContent] = useState<string>();
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copied = copiedContent === content;
  // A horizontal ScrollView needs an explicit cross-axis size inside a
  // virtualized list. Include the current accessibility font scale so the
  // explicit height never clips enlarged code text.
  const blockHeight = Math.ceil(Math.max(1, content.split('\n').length) * 20 * PixelRatio.getFontScale() + 24);
  const highlighted = useMemo(() => {
    if (deferHighlight || !language || !codeHighlighter.registered(language)) return undefined;
    try {
      return codeHighlighter.highlight(language, content, { prefix: 'hljs-' }).children;
    } catch {
      return undefined;
    }
  }, [content, deferHighlight, language]);
  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);
  const copyCode = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(content);
    } catch {
      return;
    }
    setCopiedContent(content);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopiedContent(undefined), 1600);
  }, [content]);
  const copyLabel = copied ? t('sessions.codeCopied') : t('sessions.copyCode');
  return (
    <View style={styles.codeBlockContainer}>
      <View style={styles.codeBlockToolbar} testID="markdown-code-toolbar">
        <Text numberOfLines={1} style={styles.codeBlockLanguage}>{language || t('sessions.plainText')}</Text>
        <Pressable accessibilityLabel={copyLabel} accessibilityRole="button" hitSlop={6} onPress={() => void copyCode()} style={({ pressed }) => [styles.codeBlockCopy, pressed && styles.codeBlockCopyPressed]} testID="markdown-code-copy">
          {copied ? <Check color={styles.codeBlockCopyText.color} size={14} /> : <Copy color={styles.codeBlockCopyText.color} size={14} />}
          <Text style={styles.codeBlockCopyText}>{copyLabel}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.codeBlockScrollContent} horizontal showsHorizontalScrollIndicator={false} style={{ height: blockHeight }} testID="markdown-code-scroll">
        <SelectableText selectable style={styles.codeBlockText} uiTextView>
          {highlighted ? highlighted.map((child, index) => renderHighlightNode(child, `code:${index}`, styles)) : content}
        </SelectableText>
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
    <SelectableText key={key} style={highlightTokenStyles(classNames, styles)}>
      {node.children.map((child, index) => renderHighlightNode(child, `${key}:${index}`, styles))}
    </SelectableText>
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
  return <SelectableText key={node.key} selectable style={[styles.paragraph, isFinalTopLevelParagraph && styles.flushEnd]} testID="markdown-selectable-text" uiTextView>{children}</SelectableText>;
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
  const bodySize = compact ? 13 : 16;
  const bodyLineHeight = compact ? 20 : 24;
  return StyleSheet.create({
    root: {},
    body: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight },
    text: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight },
    textgroup: { color: colors.text },
    paragraph: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight, marginBottom: compact ? 4 : 9, marginTop: 0 },
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
    codeInlineText: { color: colors.syntaxNumber, fontFamily: codeFont, fontSize: bodySize, lineHeight: bodyLineHeight },
    code_block: {},
    fence: {},
    codeBlockContainer: { backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, marginBottom: 11, overflow: 'hidden' },
    codeBlockToolbar: { alignItems: 'center', borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 36, paddingLeft: 12, paddingRight: 6 },
    codeBlockLanguage: { color: colors.textMuted, flexShrink: 1, fontSize: 12, lineHeight: 16, marginRight: 12 },
    codeBlockCopy: { alignItems: 'center', borderRadius: 6, flexDirection: 'row', gap: 5, minHeight: 30, paddingHorizontal: 7 },
    codeBlockCopyPressed: { backgroundColor: colors.surface },
    codeBlockCopyText: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
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
