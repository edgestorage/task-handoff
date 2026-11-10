const fs = require('node:fs');
const path = require('node:path');

const mobileRoot = path.resolve(__dirname, '..');
const swiftSource = fs.readFileSync(
  path.join(mobileRoot, 'modules/task-handoff-markdown/ios/TaskHandoffMarkdownView.swift'),
  'utf8',
);
const nativeBlocksSource = fs.readFileSync(
  path.join(mobileRoot, 'plugins/native-markdown/TaskHandoffNativeMarkdownBlocks.swift'),
  'utf8',
);
const nativePluginSource = fs.readFileSync(
  path.join(mobileRoot, 'plugins/with-task-handoff-native-markdown.js'),
  'utf8',
);
const demoSource = fs.readFileSync(
  path.join(mobileRoot, 'src/markdown-demo/MarkdownDemoScreen.tsx'),
  'utf8',
);
const profilesSource = fs.readFileSync(
  path.join(mobileRoot, 'app/profiles.tsx'),
  'utf8',
);
const nativeProfilesSource = fs.readFileSync(
  path.join(mobileRoot, 'src/control-plane/NativeProfilesScreen.ios.tsx'),
  'utf8',
);
const nativeModuleSource = fs.readFileSync(
  path.join(mobileRoot, 'modules/task-handoff-markdown/ios/TaskHandoffMarkdownModule.swift'),
  'utf8',
);
const nativeViewTypesSource = fs.readFileSync(
  path.join(mobileRoot, 'modules/task-handoff-markdown/src/TaskHandoffMarkdownView.tsx'),
  'utf8',
);
const safeMarkdownSource = fs.readFileSync(
  path.join(mobileRoot, 'src/components/SafeMarkdown.tsx'),
  'utf8',
);
const themeSource = fs.readFileSync(
  path.join(mobileRoot, 'src/components/theme.ts'),
  'utf8',
);
const markdownLinkMenuSource = fs.readFileSync(
  path.join(mobileRoot, 'src/components/MarkdownLinkMenu.tsx'),
  'utf8',
);
const markdownContentSource = fs.readFileSync(
  path.join(mobileRoot, 'src/components/MarkdownContent.ios.tsx'),
  'utf8',
);
const sessionDetailSource = fs.readFileSync(
  path.join(mobileRoot, 'src/ai-sessions/SessionDetail.tsx'),
  'utf8',
);

test('iOS Markdown uses one selectable non-scrolling native text view', () => {
  expect(swiftSource).toContain('UITextView(usingTextLayoutManager: true)');
  expect(swiftSource).toContain('textView.isEditable = false');
  expect(swiftSource).toContain('textView.isScrollEnabled = false');
  expect(swiftSource).toContain('textView.isSelectable = true');
  expect(swiftSource).not.toContain('WKWebView');
});

test('iOS code blocks and Mermaid use native renderers', () => {
  expect(swiftSource).toContain('NativeMarkdownBlockAttachment');
  expect(swiftSource).toContain('TaskHandoffNativeBlockFactoryProtocol');
  expect(swiftSource).toContain('language?.lowercased() == "mermaid"');
  expect(nativeBlocksSource).toContain('import Highlighter');
  expect(nativeBlocksSource).toContain('highlighter.highlight(source, as: normalized)');
  expect(nativeBlocksSource).toContain('import BeautifulMermaid');
  expect(nativeBlocksSource).toContain('MermaidView(frame:');
  expect(nativeBlocksSource).not.toContain('WKWebView');
});

test('native code and table chrome follows the SafeMarkdown visual tokens', () => {
  expect(nativeBlocksSource).toContain('NativeMarkdownCopyButton');
  expect(nativeBlocksSource).toContain('NativeMarkdownCopyIconView');
  expect(nativeBlocksSource).not.toContain('doc.on.doc');
  expect(nativeBlocksSource).toContain('backgroundColor = UIColor(markdownHex: appearance["codeBackground"])');
  expect(nativeBlocksSource).toContain('let header = UIColor(markdownHex: appearance["tableHeaderBackground"])');
  expect(nativeBlocksSource).toContain('let background = UIColor(markdownHex: appearance["tableBackground"])');
  expect(nativeBlocksSource).toContain('baseLineHeight: CGFloat = compact ? 20 : 25');
  expect(nativeBlocksSource).not.toContain('boldFont');
});

test('native and SafeMarkdown tables share fixed columns and wrapping metrics', () => {
  expect(swiftSource).toContain('public static let firstColumnWidth: CGFloat = 148');
  expect(swiftSource).toContain('public static let columnWidth: CGFloat = 112');
  expect(swiftSource).toContain('public static let horizontalInset: CGFloat = 13');
  expect(swiftSource).toContain('public static let verticalInset: CGFloat = 10');
  expect(swiftSource).toContain('public static let shadowInset: CGFloat = 4');
  expect(swiftSource).toContain('public static let shadowOffset = CGSize(width: 0, height: 1)');
  expect(swiftSource).toContain('public static let shadowOpacity: Float = 0.12');
  expect(swiftSource).toContain('public static let shadowRadius: CGFloat = 3');
  expect(swiftSource).toContain('paragraph.lineBreakMode = .byWordWrapping');
  expect(swiftSource).toContain('attributes: [.font: font, .paragraphStyle: paragraph]');
  expect(nativeBlocksSource).toContain('TaskHandoffMarkdownTableMetrics.totalWidth(columnCount: columnCount)');
  expect(nativeBlocksSource).toContain('TaskHandoffMarkdownTableMetrics.width(forColumn: column)');
  expect(safeMarkdownSource).toContain('const TABLE_FIRST_COLUMN_WIDTH = 148');
  expect(safeMarkdownSource).toContain('const TABLE_COLUMN_WIDTH = 112');
  expect(safeMarkdownSource).toContain('const width = markdownTableWidth(markdownTableColumnCount(node))');
  expect(safeMarkdownSource).toContain('<View style={[styles.tableShadow, { width: width + 2 }]}>');
  expect(safeMarkdownSource).toContain('<View style={styles.table}>{children}</View>');
});

test('native and SafeMarkdown tables match the Web border, row fills, and shadow', () => {
  expect(swiftSource).toContain('fragment.textLineFragments.last.map');
  expect(swiftSource).toContain('fragment.layoutFragmentFrame.minY + $0.typographicBounds.maxY');
  expect(swiftSource).toContain('fragment.layoutFragmentFrame.maxY - fragment.bottomMargin');
  expect(nativeBlocksSource).toContain('table.layer.borderWidth = 1');
  expect(nativeBlocksSource).toContain('tableContainer.layer.shadowOffset = TaskHandoffMarkdownTableMetrics.shadowOffset');
  expect(nativeBlocksSource).toContain('tableContainer.layer.shadowOpacity = TaskHandoffMarkdownTableMetrics.shadowOpacity');
  expect(nativeBlocksSource).toContain('tableContainer.layer.shadowRadius = TaskHandoffMarkdownTableMetrics.shadowRadius');
  expect(nativeBlocksSource).toContain('scrollView.addSubview(tableContainer)');
  expect(nativeBlocksSource).toContain('let tableHeight = (payload["tableHeight"]');
  expect(nativeBlocksSource).toContain('CGSize(width: tableWidth + shadowInset * 2');
  expect(nativeBlocksSource).toContain('addSeparator(to: rowView, frame: CGRect(x: 0, y: rowHeight - 1');
  expect(nativeBlocksSource).toContain('gradient.colors = [header.cgColor, header.withAlphaComponent(0.78).cgColor]');
  expect(nativeBlocksSource).toContain('rowView.backgroundColor = background');
  expect(safeMarkdownSource).toContain('tableShadow: { alignSelf: ');
  expect(safeMarkdownSource).toContain("tableScrollContent: { alignItems: 'flex-start', flexGrow: 0, padding: 4 }");
  expect(safeMarkdownSource).toContain("shadowColor: '#000000'");
  expect(safeMarkdownSource).toContain('shadowOpacity: 0.12, shadowRadius: 3');
  expect(safeMarkdownSource).toContain('borderWidth: 1, overflow: \'hidden\'');
  expect(safeMarkdownSource).toContain('backgroundColor: colors.tableBackground');
  expect(safeMarkdownSource).toContain('borderColor: colors.tableBorder');
  expect(safeMarkdownSource).toContain('backgroundColor: colors.tableHeaderBackground');
  expect(safeMarkdownSource).toContain('th: { backgroundColor: colors.tableHeaderBackground');
  expect(safeMarkdownSource).toContain('thGradient: { backgroundColor: colors.tableBackground');
});

test('native and SafeMarkdown tables fade both clipped edges while more content remains', () => {
  expect(nativeBlocksSource).toContain('private let fadeWidth: CGFloat = 18');
  expect(nativeBlocksSource).toContain('private let leftFadeLayer = CAGradientLayer()');
  expect(nativeBlocksSource).toContain('private let rightFadeLayer = CAGradientLayer()');
  expect(nativeBlocksSource).toContain('scrollView.delegate = self');
  expect(nativeBlocksSource).toContain('leftFadeLayer.colors = [fadeColor.cgColor, fadeColor.withAlphaComponent(0).cgColor]');
  expect(nativeBlocksSource).toContain('rightFadeLayer.colors = [fadeColor.withAlphaComponent(0).cgColor, fadeColor.cgColor]');
  expect(nativeBlocksSource).toContain('leftFadeView.isHidden = maxOffset <= 0.5 || scrollView.contentOffset.x <= 0.5');
  expect(nativeBlocksSource).toContain('rightFadeView.isHidden = maxOffset <= 0.5 || scrollView.contentOffset.x >= maxOffset - 0.5');
  expect(safeMarkdownSource).toContain('function MarkdownTableScroll');
  expect(safeMarkdownSource).toContain('const TABLE_FADE_WIDTH = 18');
  expect(safeMarkdownSource).toContain('const showLeftFade = maxOffset > 0.5 && offsetX > 0.5');
  expect(safeMarkdownSource).toContain('const showRightFade = maxOffset > 0.5 && offsetX < maxOffset - 0.5');
  expect(safeMarkdownSource).toContain('testID="markdown-table-left-fade"');
  expect(safeMarkdownSource).toContain('testID="markdown-table-right-fade"');
  expect(safeMarkdownSource).toContain('onContentSizeChange={(value) => setContentWidth(value)}');
});

test('Markdown table tokens use the Web control-plane color values', () => {
  expect(swiftSource).toContain('var tableBackground = UIColor.systemBackground');
  expect(swiftSource).toContain('var tableBorder = UIColor.separator');
  expect(swiftSource).toContain('var tableHeaderBackground = UIColor.secondarySystemBackground');
  expect(swiftSource).toContain('var tableText = UIColor.label');
  expect(nativeBlocksSource).toContain('appearance["tableBorder"]');
  expect(nativeBlocksSource).toContain('appearance["tableBackground"]');
  expect(nativeBlocksSource).toContain('appearance["tableHeaderBackground"]');
  expect(nativeBlocksSource).toContain('appearance["tableText"]');
});

test('native Markdown consumes Web-aligned semantic surface tokens', () => {
  expect(swiftSource).toContain('var surfaceHover = UIColor.secondarySystemBackground');
  expect(swiftSource).toContain('var surfaceInset = UIColor.systemBackground');
  expect(swiftSource).toContain('var surfaceRaised = UIColor.systemBackground');
  expect(nativeBlocksSource).toContain('appearance["codeBackground"]');
  expect(nativeBlocksSource).toContain('appearance["surfaceHover"]');
  expect(nativeBlocksSource).toContain('appearance["tableBackground"]');
  expect(nativeBlocksSource).toContain('appearance["tableHeaderBackground"]');
  expect(safeMarkdownSource).toContain('codeBlockContainer: { backgroundColor: colors.surface');
  expect(safeMarkdownSource).toContain('codeBlockCopyPressed: { backgroundColor: colors.surfaceHover');
});

test('Markdown table tokens are explicit for light and dark themes', () => {
  expect(themeSource).toContain("tableBackground: '#ffffff', tableBorder: '#d1d1d6', tableHeaderBackground: '#f8f8fa', tableText: '#1c1c1e'");
  expect(themeSource).toContain("tableBackground: '#17181c', tableBorder: '#2a2c32', tableHeaderBackground: '#101012', tableText: '#f2f2f7'");
  expect(themeSource).toContain("tableStripe: '#fcfcfc'");
  expect(themeSource).toContain("tableStripe: '#242426'");
});

test('native and SafeMarkdown tables use the Web header treatment', () => {
  expect(swiftSource).toContain('let headerFont = UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: baseSize, weight: .bold))');
  expect(nativeBlocksSource).toContain('rowIndex < headerRowCount');
  expect(safeMarkdownSource).toContain("<Text style={styles.thText}>{children}</Text>");
  expect(safeMarkdownSource).toContain("fontWeight: '700'");
});

test('Mermaid diagrams open a native zoomable full-screen preview', () => {
  expect(nativeBlocksSource).toContain('NativeMermaidPreviewViewController');
  expect(nativeBlocksSource).toContain('scrollView.maximumZoomScale = 4');
  expect(nativeBlocksSource).toContain('func viewForZooming(in scrollView: UIScrollView) -> UIView?');
  expect(nativeBlocksSource).toContain('UITapGestureRecognizer(target: self, action: #selector(showMermaidPreview))');
  expect(nativeBlocksSource).toContain('diagram.accessibilityHint = "Opens an enlarged preview"');
});

test('native copy labels are supplied by React Native localization', () => {
  expect(swiftSource).toContain('func setLabels(_ value: TaskHandoffMarkdownLabels)');
  expect(swiftSource).toContain('"plainText": labels.plainText');
  expect(demoSource).toContain("t('sessions.copyCode')");
  expect(demoSource).toContain("t('sessions.codeCopied')");
  expect(demoSource).toContain("t('sessions.plainText')");
});

test('AI session detail uses native Markdown for responses while keeping user bubbles on RN', () => {
  expect(sessionDetailSource).toContain("import { MarkdownContent } from '../components/MarkdownContent';");
  expect(sessionDetailSource).toContain("if (item.role === 'user') return <View style={styles.userMessage}>");
  expect(sessionDetailSource).toContain('conversation ? styles.conversationUser : styles.promptBlock');
  expect(sessionDetailSource).toContain('<SafeMarkdown nativeSelectable={false} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} trimEnd>{item.text}</SafeMarkdown>');
  expect(sessionDetailSource).toContain("if (conversation && item.role === 'assistant') return <View style={styles.assistantMessage}><View style={styles.conversationResponse}><MarkdownContent");
  expect(sessionDetailSource).toContain("if (item.role === 'assistant') return <View style={styles.assistantMessage}><View style={styles.responseBlock}><MarkdownContent");
  expect(sessionDetailSource).toContain("<MarkdownContent onAddToConversation={onAddToConversation} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile}>{item.text ?? ''}</MarkdownContent>");
  expect(sessionDetailSource).toContain('onAddToConversation={onAddToConversation} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} streamKey={item.streamKey}');
  expect(sessionDetailSource).toContain('streamKey={item.streamKey} streaming={item.streaming} trimEnd={timelineNested || trimEnd}');
});

test('native Markdown wrapper owns link gestures and falls back without the module', () => {
  expect(markdownContentSource).toContain("requireOptionalNativeModule('TaskHandoffMarkdown') !== null");
  expect(markdownContentSource).toContain("requireNativeView<TaskHandoffMarkdownViewProps>('TaskHandoffMarkdown')");
  expect(markdownContentSource).toContain('onLinkLongPress={({ nativeEvent }) => setLinkMenu({');
  expect(markdownContentSource).toContain('onLinkPress={({ nativeEvent }) => openLink(nativeEvent.url)}');
  expect(markdownContentSource).toContain('<MarkdownLinkMenu');
  expect(markdownContentSource).toContain('onOpenBuiltinBrowser={props.onOpenBuiltinBrowser}');
  expect(markdownContentSource).toContain('onOpenFile={openFile}');
  expect(markdownContentSource).toContain('if (!NativeMarkdownView || props.nativeSelectable === false)');
  expect(markdownContentSource).toContain('<SafeMarkdown');
});

test('native Markdown preserves local file links for the shared link menu', () => {
  expect(swiftSource).toContain('private let nativeMarkdownLocalLinkScheme = "taskhandoff-local-link"');
  expect(swiftSource).toContain('if scheme == "file" { return url.absoluteString }');
  expect(swiftSource).toContain('return target.isEmpty || target.hasPrefix("#") ? nil : target');
  expect(swiftSource).toContain('fileprivate static func linkTarget(from url: URL) -> String?');
  expect(markdownContentSource).toContain('const target = mobileMarkdownLinkTarget(raw);');
  expect(markdownContentSource).toContain("if (target?.kind === 'file' && openFile) void openFile(raw);");
  expect(markdownContentSource).toContain('onOpenFile={openFile}');
});

test('native links use the same long-press menu as SafeMarkdown', () => {
  expect(nativeModuleSource).toContain('Events("onAddToConversation", "onLinkPress", "onLinkLongPress")');
  expect(swiftSource).toContain('let onLinkLongPress = EventDispatcher()');
  expect(swiftSource).toContain('interaction == .presentActions');
  expect(swiftSource).toContain('textView.selectionRects(for: textRange)');
  expect(nativeViewTypesSource).toContain('onLinkLongPress?:');
  expect(demoSource).toContain('onLinkLongPress={');
  expect(demoSource).toContain('<MarkdownLinkMenu');
  expect(safeMarkdownSource).toContain('<MarkdownLinkMenu');
  expect(markdownLinkMenuSource).toContain("t('sessions.linkActions.openBuiltinBrowser')");
  expect(markdownLinkMenuSource).toContain("t('sessions.linkActions.openFile')");
  expect(markdownLinkMenuSource).toContain('openFileValue(target.href)');
  expect(markdownLinkMenuSource).toContain("t('sessions.linkActions.openDefaultBrowser')");
  expect(markdownLinkMenuSource).toContain("t('sessions.linkActions.copyLink')");
});

test('native text selection can add text to the active conversation', () => {
  expect(swiftSource).toContain('editMenuForTextIn range: NSRange');
  expect(swiftSource).toContain('suggestedActions: [UIMenuElement]');
  expect(swiftSource).toContain('title: title,');
  expect(swiftSource).toContain('self.onAddToConversation(["text": selectedText])');
  expect(swiftSource).toContain('.replacingOccurrences(of: "\\u{FFFC}", with: "")');
  expect(markdownContentSource).toContain("addToConversation: props.onAddToConversation ? t('sessions.addToConversation') : ''");
  expect(markdownContentSource).toContain('onAddToConversation={props.onAddToConversation');
  expect(sessionDetailSource).toContain('onAddToConversation={onAddToConversation}');
});

test('native text selection dismisses when the user taps outside a selection', () => {
  expect(swiftSource).toContain('window.addGestureRecognizer(tap)');
  expect(swiftSource).toContain('tap.cancelsTouchesInView = false');
  expect(swiftSource).toContain('func textViewDidBeginEditing');
  expect(swiftSource).toContain('func textViewDidEndEditing');
  expect(swiftSource).toContain('guard textView.isFirstResponder || textView.selectedRange.length > 0 else');
  expect(swiftSource).toContain('textView.selectedRange = NSRange(location: location, length: 0)');
  expect(swiftSource).toContain('textView.resignFirstResponder()');
  expect(swiftSource).toContain('removeSelectionDismissTap()');
});

test('hanging-indent tab stops stay ahead of TextKit 2 head indent', () => {
  expect(swiftSource.match(/location: paragraph\.headIndent \+ 1/g)).toHaveLength(2);
});

test('native top-level lists keep bottom spacing before the next block', () => {
  expect(swiftSource).toContain('var listIdentities: [Int] = []');
  expect(swiftSource).toContain('result.listIdentities.append(component.identity)');
  expect(swiftSource).toContain('paragraph.paragraphSpacingBefore = compact ? 8 : 14');
});

test('native block views are positioned from TextKit layout fragments', () => {
  expect(swiftSource).toContain('layoutManager.textLayoutFragment(for: location)');
  expect(swiftSource).toContain('fragment.layoutFragmentFrame');
  expect(swiftSource).toContain('makeBlockView(attachment.payload)');
  expect(swiftSource).not.toContain('NSTextAttachmentViewProvider');
  expect(swiftSource).toContain('override func image(');
});

test('native code blocks keep equal external spacing', () => {
  expect(swiftSource).toContain('private static func codeBlockSpacing(compact: Bool) -> CGFloat {');
  expect(swiftSource).toContain('compact ? 6 : 9');
  expect(swiftSource.match(/paragraph\.paragraphSpacingBefore = spacing/g)).toHaveLength(2);
  expect(swiftSource.match(/paragraph\.paragraphSpacing = spacing/g)).toHaveLength(2);
});

test('native Markdown reuses block views by stable key during streaming', () => {
  expect(swiftSource).toContain('let blockKey: String');
  expect(swiftSource).toContain('let isStreaming: Bool');
  expect(swiftSource).toContain('private var blockViews: [String: NativeMarkdownBlockOverlay]');
  expect(swiftSource).toContain('blockKey: nextBlockKey');
  expect(swiftSource).toContain('streamKey: streamKey');
  expect(swiftSource).toContain('streaming: streaming');
  expect(swiftSource).toContain('"streaming": streaming');
  expect(swiftSource).toContain('cached.kind == .mermaid && cached.isStreaming');
  expect(nativeBlocksSource).toContain('private let streaming: Bool');
  expect(nativeBlocksSource).toContain('addMermaidPlaceholder');
  expect(nativeBlocksSource).toContain('if streaming {');
});

test('native block quotes draw one continuous bar with SafeMarkdown indentation', () => {
  expect(swiftSource).not.toContain('▏');
  expect(swiftSource).toContain('NativeMarkdownBlockQuoteView');
  expect(swiftSource).toContain('.taskHandoffBlockQuote');
  expect(swiftSource).toContain('syncQuoteOverlays(layoutManager: layoutManager)');
  expect(swiftSource).toContain('quoteViews[identity]');
  expect(swiftSource).toContain('paragraph.firstLineHeadIndent = 15');
  expect(swiftSource).toContain('paragraph.paragraphSpacingBefore = 0');
});

test('native Markdown Swift packages are exact-versioned by the Expo plugin', () => {
  expect(nativePluginSource).toContain("version: '1.0.4'");
  expect(nativePluginSource).toContain("version: '3.1.0'");
  expect(nativePluginSource).toContain("kind: 'exactVersion'");
  expect(nativePluginSource).toContain("products: ['Highlighter']");
});

test('the demo can switch between native and React Native Markdown with shared content', () => {
  expect(demoSource).toContain("from '../../modules/task-handoff-markdown'");
  expect(demoSource).toContain('<NativeMarkdownView');
  expect(demoSource).toContain('<SafeMarkdown');
  expect(demoSource).toContain('markdown-demo-renderer-native');
  expect(demoSource).toContain('markdown-demo-renderer-safe');
  expect(demoSource).toContain("{ label: '原生 iOS'");
  expect(demoSource).toContain("{ label: 'SafeMarkdown'");
  expect(demoSource).toContain('markdown={markdownValue}');
  expect(demoSource).toContain('>{markdownValue}</SafeMarkdown>');
});

test('the demo streams the same Markdown source for both renderers', () => {
  expect(demoSource).toContain('markdown-demo-stream');
  expect(demoSource).toContain('const startStreaming = useCallback');
  expect(demoSource).toContain('setMarkdownValue(graphemes.slice(0, cursor).join(\'\'))');
  expect(demoSource).toContain('streaming={streaming}');
  expect(demoSource).toContain('streamKey={streamKey}');
});

test('the demo compares Markdown on the session background', () => {
  expect(demoSource).toContain('testID="markdown-demo-preview"');
  expect(demoSource).toContain('{ backgroundColor: colors.background, borderColor: colors.border }');
});

test('Settings does not expose the Markdown demo entry', () => {
  expect(profilesSource).not.toContain('/markdown-demo');
  expect(profilesSource).not.toContain('settings-markdown-demo');
  expect(nativeProfilesSource).not.toContain('showMarkdownDemo');
  expect(nativeProfilesSource).not.toContain("t('demo.markdown')");
});

test('both Settings renderers expose the About entry', () => {
  expect(profilesSource).toContain("router.push('/about'");
  expect(profilesSource).toContain('testID="settings-about"');
  expect(nativeProfilesSource).toContain('props.onOpenAbout');
  expect(nativeProfilesSource).toContain("t('about.title')");
});

test('Expo autolinking includes the local native module directory', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(mobileRoot, 'package.json'), 'utf8'));
  expect(packageJson.expo?.autolinking?.nativeModulesDir).toBe('./modules');
});
