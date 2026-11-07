import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { RepositoryDiff } from '@task-handoff/protocol/repository';

import { Icon } from '../components/Icon';
import type { MobileThemeColors } from '../components/theme';
import { useI18n } from '../i18n';
import { RepositoryCodeText } from './RepositoryCodeText';
import { createSplitRows, diffLineMarker, diffPresentationRows, hunkRange, isPatchHeader, type ContextControl, type ContextControlRow, type DiffPresentationRow, type GapExpansion, type RepositoryDiffViewMode, type SplitRow } from './repositoryDiffPresentation';
import { sourceLanguageForPath } from './sourceLanguage';

const maxRenderedLines = 1_800;
const lineNumberWidth = 44;
const lineMarkerWidth = 20;
const gutterWidth = lineNumberWidth * 2 + lineMarkerWidth;
const splitGutterWidth = lineNumberWidth + lineMarkerWidth;

export function RepositoryDiffView({ colors, diff, expandedGaps, onExpandContext, path, viewMode }: {
  colors: MobileThemeColors;
  diff: RepositoryDiff;
  expandedGaps: ReadonlyMap<string, GapExpansion>;
  onExpandContext(control: ContextControl): void;
  path: string;
  viewMode: RepositoryDiffViewMode;
}) {
  const { t } = useI18n();
  const [viewportWidth, setViewportWidth] = useState(0);
  const rows = useMemo(() => diffPresentationRows(diff, expandedGaps)
    .filter((row) => row.kind === 'context-control' || !isPatchHeader(row))
    .slice(0, maxRenderedLines), [diff, expandedGaps]);
  const language = sourceLanguageForPath(path);

  if (!rows.length) return <View style={styles.empty}><Text style={[styles.emptyText, { color: colors.textMuted }]}>{t('sessionResources.diff.noText')}</Text></View>;
  const limit = rows.length >= maxRenderedLines ? <Text style={[styles.limit, { backgroundColor: colors.notice, color: colors.noticeText }]}>{t('sessionResources.diff.truncatedLines', { count: maxRenderedLines })}</Text> : null;

  if (viewMode === 'split') return <View onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)} style={[styles.frame, { backgroundColor: colors.surface }]}>
    <SplitDiffView colors={colors} language={language} onExpandContext={onExpandContext} rows={rows} viewportWidth={viewportWidth} />
    {limit}
  </View>;

  return <View onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)} style={[styles.frame, { backgroundColor: colors.surface }]}>
    <UnifiedDiffView colors={colors} language={language} onExpandContext={onExpandContext} rows={rows} viewportWidth={viewportWidth} />
    {limit}
  </View>;
}

function UnifiedDiffView({ colors, language, onExpandContext, rows, viewportWidth }: {
  colors: MobileThemeColors;
  language: string;
  onExpandContext(control: ContextControl): void;
  rows: DiffPresentationRow[];
  viewportWidth: number;
}) {
  return <>
    <ScrollView contentContainerStyle={styles.scrollContent} horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ minWidth: viewportWidth }}>
        {rows.map((row, index) => row.kind === 'context-control'
          ? <ContextControlLine colors={colors} key={`context:${index}`} row={row} />
          : <DiffLine colors={colors} key={`line:${index}`} language={language} line={row} width={viewportWidth} />)}
      </View>
    </ScrollView>
    <View pointerEvents="box-none" style={styles.gutter}>
      {rows.map((row, index) => row.kind === 'context-control'
        ? <ContextControlGutter colors={colors} key={`context-gutter:${index}`} onExpandContext={onExpandContext} row={row} />
        : <DiffLineGutter colors={colors} key={`line-gutter:${index}`} line={row} />)}
    </View>
  </>;
}

function SplitDiffView({ colors, language, onExpandContext, rows, viewportWidth }: {
  colors: MobileThemeColors;
  language: string;
  onExpandContext(control: ContextControl): void;
  rows: DiffPresentationRow[];
  viewportWidth: number;
}) {
  const splitRows = useMemo(() => createSplitRows(rows), [rows]);
  const paneWidth = Math.max(160, Math.floor((viewportWidth || 320) / 2));
  return <View style={[styles.splitFrame, { backgroundColor: colors.workbenchCardBorder }]}>
    <SplitPane colors={colors} language={language} onExpandContext={onExpandContext} rows={splitRows} side="old" width={paneWidth} />
    <View style={[styles.splitDivider, { backgroundColor: colors.workbenchCardBorder }]} />
    <SplitPane colors={colors} language={language} onExpandContext={onExpandContext} rows={splitRows} side="new" width={paneWidth} />
  </View>;
}

function SplitPane({ colors, language, onExpandContext, rows, side, width }: {
  colors: MobileThemeColors;
  language: string;
  onExpandContext(control: ContextControl): void;
  rows: SplitRow[];
  side: 'old' | 'new';
  width: number;
}) {
  return <View style={styles.splitPane}>
    <ScrollView contentContainerStyle={styles.scrollContent} horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ minWidth: width }}>
        {rows.map((row, index) => <SplitLine colors={colors} key={`${side}:${index}`} language={language} row={row} side={side} width={width} />)}
      </View>
    </ScrollView>
    <View pointerEvents="box-none" style={styles.splitGutter}>
      {rows.map((row, index) => <SplitGutter colors={colors} key={`${side}-gutter:${index}`} onExpandContext={onExpandContext} row={row} side={side} />)}
    </View>
  </View>;
}

function SplitLine({ colors, language, row, side, width }: {
  colors: MobileThemeColors;
  language: string;
  row: SplitRow;
  side: 'old' | 'new';
  width: number;
}) {
  if (row.kind === 'control') return <View style={[styles.splitContextLine, { backgroundColor: colors.primarySoft, minWidth: width, paddingLeft: splitGutterWidth }]}><Text style={[styles.hunkText, { color: colors.primary }]}>{row.control.hunk?.content || ' '}</Text></View>;
  const line = row.kind === 'full' ? row.line : side === 'old' ? row.oldLine : row.newLine;
  const background = lineBackground(colors, line, row.kind === 'pair' && !line);
  const foreground = line?.kind === 'metadata' ? colors.textMuted : line?.kind === 'hunk' ? colors.primary : colors.text;
  return <View style={[styles.splitLine, { backgroundColor: background, minWidth: width, paddingLeft: splitGutterWidth }]} testID={`repository-diff-${side}-${line?.kind || 'empty'}`}>
    {row.kind === 'full' ? null : <RepositoryCodeText
      colors={colors}
      content={line?.content || ''}
      language={line && (line.kind === 'context' || line.kind === 'addition' || line.kind === 'deletion') ? language : ''}
      style={[styles.code, { color: foreground }]}
    />}
    {row.kind === 'full' ? <Text style={[styles.fullCode, { color: foreground }]}>{line?.content || ' '}</Text> : null}
  </View>;
}

function SplitGutter({ colors, onExpandContext, row, side }: {
  colors: MobileThemeColors;
  onExpandContext(control: ContextControl): void;
  row: SplitRow;
  side: 'old' | 'new';
}) {
  const { t } = useI18n();
  if (row.kind === 'control') return <View pointerEvents="box-none" style={[styles.splitGutterLine, { backgroundColor: colors.primarySoft }]}>
    {side === 'old' ? <View pointerEvents="box-none" style={[styles.splitContextControls, { borderRightColor: colors.workbenchCardBorder }]}>
      {row.control.controls.map((control) => {
        const label = t(control.direction === 'up' ? 'sessionResources.diff.expandEarlier' : 'sessionResources.diff.expandLater', { count: control.lineCount });
        return <Pressable accessibilityLabel={label} accessibilityRole="button" key={`${control.gapId}:${control.direction}`} onPress={() => onExpandContext(control)} style={({ pressed }) => [styles.contextButton, pressed && styles.pressed]}>
          <Icon color={colors.primary} name={control.direction === 'up' ? 'chevron-up' : 'chevron-down'} size={14} />
        </Pressable>;
      })}
    </View> : null}
  </View>;
  const line = row.kind === 'full' ? row.line : side === 'old' ? row.oldLine : row.newLine;
  const background = lineBackground(colors, line, row.kind === 'pair' && !line);
  return <View pointerEvents="none" style={[styles.splitGutterLine, { backgroundColor: background }]}>
    <Text style={[styles.splitLineNumber, { borderRightColor: colors.workbenchCardBorder, color: colors.textMuted }]}>{line ? (side === 'old' ? line.oldLine : line.newLine) || '' : ''}</Text>
    <Text style={[styles.marker, { color: line?.kind === 'addition' ? colors.sessionActive : line?.kind === 'deletion' ? colors.error : colors.textMuted }]}>{line ? splitLineMarker(line.kind, side) : ''}</Text>
  </View>;
}

function DiffLine({ colors, language, line, width }: {
  colors: MobileThemeColors;
  language: string;
  line: RepositoryDiff['lines'][number];
  width: number;
}) {
  const background = lineBackground(colors, line);
  const foreground = line.kind === 'metadata' ? colors.textMuted
    : line.kind === 'hunk' ? colors.primary : colors.text;
  return <View style={[styles.line, { backgroundColor: background, minWidth: width, paddingLeft: gutterWidth }]} testID={`repository-diff-${line.kind}`}>
    <RepositoryCodeText
      colors={colors}
      content={line.content}
      language={line.kind === 'context' || line.kind === 'addition' || line.kind === 'deletion' ? language : ''}
      style={[styles.code, { color: foreground }]}
    />
  </View>;
}

function DiffLineGutter({ colors, line }: {
  colors: MobileThemeColors;
  line: RepositoryDiff['lines'][number];
}) {
  return <View pointerEvents="none" style={[styles.gutterLine, { backgroundColor: lineBackground(colors, line) }]}>
    <Text style={[styles.lineNumber, { borderRightColor: colors.workbenchCardBorder, color: colors.textMuted }]}>{line.oldLine || ''}</Text>
    <Text style={[styles.lineNumber, { borderRightColor: colors.workbenchCardBorder, color: colors.textMuted }]}>{line.newLine || ''}</Text>
    <Text style={[styles.marker, { color: line.kind === 'addition' ? colors.sessionActive : line.kind === 'deletion' ? colors.error : colors.textMuted }]}>{diffLineMarker(line.kind)}</Text>
  </View>;
}

function ContextControlLine({ colors, row }: {
  colors: MobileThemeColors;
  row: ContextControlRow;
}) {
  const { t } = useI18n();
  const hunkTitle = hunkAccessibilityLabel(row.hunk, t);
  return <View accessibilityLabel={hunkTitle} style={[styles.contextLine, { backgroundColor: colors.primarySoft, paddingLeft: gutterWidth }]}>
    <Text style={[styles.hunkText, { color: colors.primary }]}>{row.hunk?.content || ' '}</Text>
  </View>;
}

function ContextControlGutter({ colors, onExpandContext, row }: {
  colors: MobileThemeColors;
  onExpandContext(control: ContextControl): void;
  row: ContextControlRow;
}) {
  const { t } = useI18n();
  return <View pointerEvents="box-none" style={[styles.contextGutter, { backgroundColor: colors.primarySoft }]}>
    <View pointerEvents="box-none" style={[styles.contextControls, { borderRightColor: colors.workbenchCardBorder }]}>
      {row.controls.map((control) => {
        const label = t(control.direction === 'up' ? 'sessionResources.diff.expandEarlier' : 'sessionResources.diff.expandLater', { count: control.lineCount });
        return <Pressable
          accessibilityLabel={label}
          accessibilityRole="button"
          key={`${control.gapId}:${control.direction}`}
          onPress={() => onExpandContext(control)}
          style={({ pressed }) => [styles.contextButton, pressed && styles.pressed]}
        ><Icon color={colors.primary} name={control.direction === 'up' ? 'chevron-up' : 'chevron-down'} size={14} /></Pressable>;
      })}
    </View>
  </View>;
}

function lineBackground(colors: MobileThemeColors, line: RepositoryDiff['lines'][number] | undefined, empty = false) {
  if (empty) return colors.surfaceInset;
  if (line?.kind === 'addition') return colors.sessionActiveSoft;
  if (line?.kind === 'deletion') return colors.errorSoft;
  if (line?.kind === 'hunk') return colors.primarySoft;
  return colors.surface;
}

function splitLineMarker(kind: RepositoryDiff['lines'][number]['kind'], side: 'old' | 'new') {
  if (side === 'old') return kind === 'deletion' ? '−' : '';
  return kind === 'addition' ? '+' : '';
}

function hunkAccessibilityLabel(line: RepositoryDiff['lines'][number] | undefined, t: ReturnType<typeof useI18n>['t']) {
  if (!line) return undefined;
  if (line.oldStart === undefined || line.oldCount === undefined || line.newStart === undefined || line.newCount === undefined) return line.content;
  return t('sessionResources.diff.hunk', {
    new: hunkRange(line.newStart, line.newCount, t('sessionResources.diff.none')),
    old: hunkRange(line.oldStart, line.oldCount, t('sessionResources.diff.none')),
  });
}

const styles = StyleSheet.create({
  frame: { width: '100%' },
  scrollContent: { paddingBottom: 6 },
  gutter: { bottom: 0, left: 0, position: 'absolute', top: 0, width: gutterWidth },
  line: { alignItems: 'stretch', flexDirection: 'row', height: 20 },
  gutterLine: { alignItems: 'stretch', flexDirection: 'row', height: 20 },
  lineNumber: { borderRightWidth: StyleSheet.hairlineWidth, flexShrink: 0, fontSize: 12, lineHeight: 20, paddingHorizontal: 7, textAlign: 'right', width: lineNumberWidth },
  marker: { flexShrink: 0, fontSize: 12, lineHeight: 20, textAlign: 'center', width: lineMarkerWidth },
  code: { flexGrow: 0, flexShrink: 0, fontFamily: 'Menlo', fontSize: 12, lineHeight: 20, paddingRight: 18 },
  fullCode: { flexGrow: 0, flexShrink: 0, fontFamily: 'Menlo', fontSize: 12, lineHeight: 20, paddingRight: 18 },
  contextLine: { alignItems: 'stretch', flexDirection: 'row', height: 22 },
  contextGutter: { alignItems: 'stretch', flexDirection: 'row', height: 22 },
  contextControls: { alignItems: 'center', borderRightWidth: StyleSheet.hairlineWidth, flexDirection: 'row', flexShrink: 0, width: lineNumberWidth * 2 },
  contextButton: { alignItems: 'center', height: 22, justifyContent: 'center', width: lineNumberWidth },
  hunkText: { flexShrink: 0, fontFamily: 'Menlo', fontSize: 12, lineHeight: 22, paddingLeft: 18, paddingRight: 16 },
  splitFrame: { flexDirection: 'row', width: '100%' },
  splitPane: { flex: 1, minWidth: 0, position: 'relative' },
  splitDivider: { width: StyleSheet.hairlineWidth },
  splitGutter: { bottom: 0, left: 0, position: 'absolute', top: 0, width: splitGutterWidth },
  splitLine: { alignItems: 'stretch', flexDirection: 'row', height: 20 },
  splitContextLine: { alignItems: 'stretch', flexDirection: 'row', height: 22 },
  splitGutterLine: { alignItems: 'stretch', flexDirection: 'row', height: 20 },
  splitLineNumber: { borderRightWidth: StyleSheet.hairlineWidth, flexShrink: 0, fontSize: 12, lineHeight: 20, paddingHorizontal: 7, textAlign: 'right', width: lineNumberWidth },
  splitContextControls: { alignItems: 'center', borderRightWidth: StyleSheet.hairlineWidth, flexDirection: 'row', flexShrink: 0, width: lineNumberWidth },
  empty: { alignItems: 'center', justifyContent: 'center', minHeight: 120, padding: 20 },
  emptyText: { fontSize: 12, lineHeight: 18 },
  limit: { fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingVertical: 7 },
  pressed: { opacity: 0.55 },
});
