import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { MarkdownContent } from '../components/MarkdownContent';
import type { MobileThemeColors } from '../components/theme';
import { useI18n } from '../i18n';
import { RepositoryCodeText } from './RepositoryCodeText';
import { repositoryMarkdownBasePath } from './repositoryChangePresentation';
import { sourceLanguageForPath } from './sourceLanguage';

export type RepositoryMarkdownView = 'preview' | 'source';

export function isRepositoryMarkdownPath(path: string) {
  return /\.(?:md|markdown)$/i.test(path);
}

export function RepositoryFilePreview({ colors, content, line, markdownView, onOpenBuiltinBrowser, onOpenFile, path }: {
  colors: MobileThemeColors;
  content: string;
  line?: number;
  markdownView: RepositoryMarkdownView;
  onOpenBuiltinBrowser?(url: string): void | Promise<void>;
  onOpenFile(href: string, basePath: string): void | Promise<void>;
  path: string;
}) {
  const { t } = useI18n();
  const [width, setWidth] = useState(0);
  const markdown = isRepositoryMarkdownPath(path);
  const sourceLines = useMemo(() => content.split('\n'), [content]);
  const language = sourceLanguageForPath(path);

  if (markdown && markdownView === 'preview') return <ScrollView
    contentContainerStyle={[styles.markdownContent, { paddingHorizontal: width > 0 && width < 480 ? 16 : 24 }]}
    keyboardShouldPersistTaps="handled"
    onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    style={[styles.markdownScroll, { backgroundColor: colors.background }]}
    testID="repository-markdown-preview"
  >
    <View style={styles.markdownDocument}>
      <MarkdownContent
        onOpenBuiltinBrowser={onOpenBuiltinBrowser}
        onOpenFile={(href) => onOpenFile(href, repositoryMarkdownBasePath(path))}
      >{content}</MarkdownContent>
    </View>
  </ScrollView>;

  return <ScrollView
    contentContainerStyle={styles.sourceVerticalContent}
    keyboardShouldPersistTaps="handled"
    style={[styles.sourceScroll, { backgroundColor: colors.background }]}
    testID="repository-source-preview"
  >
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.sourceBody}>
        {sourceLines.map((source, index) => <View key={index} style={[styles.sourceLine, line === index + 1 && { backgroundColor: colors.primarySoft }]}>
          <Text style={[styles.lineNumber, { borderRightColor: colors.workbenchCardBorder, color: line === index + 1 ? colors.primary : colors.textMuted }]}>{index + 1}</Text>
          <RepositoryCodeText colors={colors} content={source} language={language} style={[styles.sourceText, { color: colors.text }]} />
        </View>)}
        {!content ? <Text style={[styles.empty, { color: colors.textMuted }]}>{t('sessionResources.emptyFile')}</Text> : null}
      </View>
    </ScrollView>
  </ScrollView>;
}

const styles = StyleSheet.create({
  markdownScroll: { flex: 1 },
  markdownContent: { alignItems: 'center', paddingBottom: 24, paddingTop: 18 },
  markdownDocument: { maxWidth: 900, width: '100%' },
  sourceScroll: { flex: 1 },
  sourceVerticalContent: { minHeight: '100%', paddingBottom: 16, paddingTop: 10 },
  sourceBody: { minWidth: '100%', paddingRight: 14 },
  sourceLine: { flexDirection: 'row', minHeight: 20 },
  lineNumber: { borderRightWidth: StyleSheet.hairlineWidth, flexShrink: 0, fontSize: 12, lineHeight: 20, paddingHorizontal: 8, textAlign: 'right', width: 44 },
  sourceText: { flexGrow: 0, flexShrink: 0, fontFamily: 'Menlo', fontSize: 12, lineHeight: 20, paddingLeft: 12 },
  empty: { fontSize: 13, lineHeight: 19, padding: 20, textAlign: 'center' },
});
