import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StoryContentPreview } from '@task-handoff/protocol/stories';
import { WebView } from 'react-native-webview';
import { EmptyState } from '../components/EmptyState';
import { SafeMarkdown } from '../components/SafeMarkdown';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../i18n';
import { openSystemLink } from '../platform/links';

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);
const HTML_EXTENSIONS = new Set(['htm', 'html']);

export function isHtmlStoryPath(storyPath?: string) {
  return HTML_EXTENSIONS.has(storyPath?.split('.').pop()?.toLocaleLowerCase() || '');
}

export function htmlPreviewNavigationDisposition(url: string): 'local' | 'external' | 'blocked' {
  const normalized = url.trim().toLocaleLowerCase();
  if (normalized.startsWith('about:blank') || normalized.startsWith('data:text/html')) return 'local';
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol) ? 'external' : 'blocked';
  } catch {
    return 'blocked';
  }
}

export function StoryDocumentPreview({ storyId, nodeId, storyPath, title }: { storyId?: string; nodeId?: string; storyPath?: string; title?: string }) {
  const { colors } = useMobileTheme(); const { t } = useI18n(); const runtime = useMobileControlPlaneRuntime(); const [preview, setPreview] = useState<StoryContentPreview>(); const [error, setError] = useState<string>();
  useEffect(() => { if (!runtime.api || !storyId || !nodeId || !storyPath) return; const abort = new AbortController(); void runtime.api.stories.preview(storyId, nodeId, storyPath, abort.signal).then(setPreview).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }); return () => abort.abort(); }, [nodeId, runtime.api, storyId, storyPath]);
  const extension = storyPath?.split('.').pop()?.toLocaleLowerCase() || ''; const content = useMemo(() => { if (!preview) return ''; if (extension !== 'json') return preview.content; try { return JSON.stringify(JSON.parse(preview.content), null, 2); } catch { return preview.content; } }, [extension, preview]);
  if (!preview && !error) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  if (!preview) return <EmptyState icon={{ android: 'error_outline', ios: 'exclamationmark.circle' }} iconColor={colors.error} message={error || t('stories.previewError')} style={styles.loading} />;
  const header = <View style={styles.header}><Text style={[styles.title, { color: colors.text }]}>{title || storyPath}</Text><Text numberOfLines={2} style={[styles.meta, { color: colors.textMuted }]}>{storyPath} · {preview.size} B · {preview.revision.slice(0, 10)}</Text></View>;
  if (isHtmlStoryPath(storyPath)) return <View style={[styles.htmlScreen, { backgroundColor: colors.background }]}><View style={styles.htmlHeader}>{header}</View><WebView
    allowFileAccess={false}
    allowFileAccessFromFileURLs={false}
    allowUniversalAccessFromFileURLs={false}
    cacheEnabled={false}
    domStorageEnabled={false}
    incognito
    javaScriptEnabled={false}
    mixedContentMode="never"
    onShouldStartLoadWithRequest={({ url }) => {
      const disposition = htmlPreviewNavigationDisposition(url);
      if (disposition === 'external') void openSystemLink(url).catch(() => undefined);
      return disposition === 'local';
    }}
    originWhitelist={['*']}
    setSupportMultipleWindows={false}
    sharedCookiesEnabled={false}
    source={{ html: content, baseUrl: 'about:blank' }}
    style={[styles.html, { backgroundColor: colors.background }]}
    testID="story-html-preview"
    thirdPartyCookiesEnabled={false}
  /></View>;
  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.content, { backgroundColor: colors.background }]}>{header}{MARKDOWN_EXTENSIONS.has(extension) ? <SafeMarkdown>{content}</SafeMarkdown> : <Text selectable style={[styles.plain, { color: colors.text }]}>{content}</Text>}</ScrollView>;
}
const styles = StyleSheet.create({ loading: { flex: 1 }, content: { gap: 18, padding: 16, paddingBottom: 32 }, header: { gap: 5 }, htmlHeader: { padding: 16 }, htmlScreen: { flex: 1 }, html: { flex: 1 }, title: { fontSize: 20, fontWeight: '600' }, meta: { fontSize: 13 }, plain: { fontFamily: 'monospace', fontSize: 13, lineHeight: 20 } });
