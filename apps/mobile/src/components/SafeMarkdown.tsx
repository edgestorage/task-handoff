import { useMemo } from 'react';
import { Platform, StyleSheet } from 'react-native';
import Markdown, { MarkdownIt } from 'react-native-markdown-display';

import { openSystemLink } from '../platform/links';
import { useMobileTheme, type MobileThemeColors } from './theme';

// Keep one parser configuration for snapshots and streaming updates. Raw HTML is
// deliberately disabled: session output is untrusted and must remain text.
const markdownParser = MarkdownIt({
  breaks: true,
  html: false,
  linkify: false,
  typographer: true,
});

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

export function SafeMarkdown({ children, compact = false }: { children: string; compact?: boolean }) {
  const { colors } = useMobileTheme();
  const styles = useMemo(() => markdownStyles(colors, compact), [colors, compact]);

  return (
    <Markdown
      markdownit={markdownParser}
      mergeStyle={false}
      onLinkPress={(raw) => {
        const url = safeMarkdownLink(raw);
        if (url) void openSystemLink(url);
        // Returning false prevents the renderer from opening the unvalidated URL.
        return false;
      }}
      style={styles}
    >
      {sanitizeMarkdown(children)}
    </Markdown>
  );
}

function markdownStyles(colors: MobileThemeColors, compact: boolean) {
  const codeFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  const bodySize = compact ? 13 : 15;
  const bodyLineHeight = compact ? 18 : 22;
  return StyleSheet.create({
    body: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight },
    text: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight },
    textgroup: { color: colors.text },
    paragraph: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: compact ? 3 : 8, marginTop: 0 },
    heading1: { color: colors.text, flexDirection: 'row', fontSize: compact ? 16 : 22, fontWeight: '700', lineHeight: compact ? 20 : 28, marginBottom: compact ? 3 : 8, marginTop: compact ? 0 : 4 },
    heading2: { color: colors.text, flexDirection: 'row', fontSize: compact ? 15 : 20, fontWeight: '700', lineHeight: compact ? 19 : 26, marginBottom: compact ? 3 : 7, marginTop: compact ? 0 : 4 },
    heading3: { color: colors.text, flexDirection: 'row', fontSize: compact ? 14 : 18, fontWeight: '700', lineHeight: compact ? 18 : 24, marginBottom: compact ? 2 : 6, marginTop: compact ? 0 : 3 },
    heading4: { color: colors.text, flexDirection: 'row', fontSize: 16, fontWeight: '700', lineHeight: 22, marginBottom: 5, marginTop: 3 },
    heading5: { color: colors.text, flexDirection: 'row', fontSize: 15, fontWeight: '700', lineHeight: 21, marginBottom: 4, marginTop: 2 },
    heading6: { color: colors.textMuted, flexDirection: 'row', fontSize: 14, fontWeight: '700', lineHeight: 20, marginBottom: 4, marginTop: 2 },
    strong: { fontWeight: '700' },
    em: { fontStyle: 'italic' },
    s: { textDecorationLine: 'line-through' },
    link: { color: colors.primary, textDecorationLine: 'underline' },
    blocklink: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
    blockquote: { backgroundColor: colors.surfaceMuted, borderLeftColor: colors.border, borderLeftWidth: 3, marginBottom: 8, marginLeft: 0, paddingHorizontal: 11, paddingVertical: 6 },
    bullet_list: { marginBottom: 8 },
    ordered_list: { marginBottom: 8 },
    list_item: { flexDirection: 'row', justifyContent: 'flex-start', marginBottom: 3 },
    bullet_list_icon: { marginLeft: 4, marginRight: 8 },
    bullet_list_content: { flex: 1 },
    ordered_list_icon: { marginLeft: 2, marginRight: 8 },
    ordered_list_content: { flex: 1 },
    code_inline: { backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, color: colors.text, fontFamily: codeFont, fontSize: 13, paddingHorizontal: 4, paddingVertical: 1 },
    code_block: { backgroundColor: colors.code, borderColor: colors.border, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, color: colors.codeText, fontFamily: codeFont, fontSize: 12, lineHeight: 18, marginBottom: 9, padding: 12 },
    fence: { backgroundColor: colors.code, borderColor: colors.border, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, color: colors.codeText, fontFamily: codeFont, fontSize: 12, lineHeight: 18, marginBottom: 9, padding: 12 },
    pre: { marginBottom: 8 },
    hr: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginBottom: 10, marginTop: 4 },
    table: { borderColor: colors.border, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, marginBottom: 9 },
    thead: { backgroundColor: colors.surfaceMuted },
    tbody: {},
    th: { flex: 1, padding: 7 },
    tr: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
    td: { flex: 1, padding: 7 },
    image: { borderRadius: 8 },
    hardbreak: { height: 1, width: '100%' },
    softbreak: {},
    inline: {},
    span: {},
  });
}
