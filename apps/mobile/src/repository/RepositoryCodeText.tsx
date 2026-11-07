import { useMemo } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { common, createLowlight } from 'lowlight';

import type { MobileThemeColors } from '../components/theme';

const highlighter = createLowlight(common);
type HighlightNode = ReturnType<typeof highlighter.highlight>['children'][number];

export function RepositoryCodeText({ colors, content, language, style }: {
  colors: MobileThemeColors;
  content: string;
  language?: string;
  style: StyleProp<TextStyle>;
}) {
  const highlighted = useMemo(() => {
    if (!language || !highlighter.registered(language)) return undefined;
    try {
      return highlighter.highlight(language, content, { prefix: 'hljs-' }).children;
    } catch {
      return undefined;
    }
  }, [content, language]);
  return <Text selectable style={style}>{highlighted ? highlighted.map((node, index) => renderNode(node, `token:${index}`, colors)) : content || ' '}</Text>;
}

function renderNode(node: HighlightNode, key: string, colors: MobileThemeColors): React.ReactNode {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return null;
  const classNames = Array.isArray(node.properties.className)
    ? node.properties.className.filter((value): value is string => typeof value === 'string')
    : [];
  return <Text key={key} style={tokenStyle(classNames, colors)}>
    {node.children.map((child, index) => renderNode(child, `${key}:${index}`, colors))}
  </Text>;
}

function tokenStyle(classNames: string[], colors: MobileThemeColors): TextStyle {
  for (const className of classNames) {
    const scope = className.replace(/^hljs-/, '');
    if (['comment', 'quote', 'meta'].includes(scope)) return { color: colors.syntaxComment };
    if (['keyword', 'selector-tag', 'doctag'].includes(scope)) return { color: colors.syntaxKeyword };
    if (['string', 'regexp', 'attribute'].includes(scope)) return { color: colors.syntaxString };
    if (['number', 'literal', 'symbol', 'bullet'].includes(scope)) return { color: colors.syntaxNumber };
    if (['title', 'section', 'selector-id', 'selector-class'].includes(scope)) return { color: colors.syntaxTitle };
    if (['built_in', 'type', 'class'].includes(scope)) return { color: colors.syntaxType };
    if (scope === 'emphasis') return { fontStyle: 'italic' };
    if (scope === 'strong') return { fontWeight: '600' };
  }
  return {};
}
