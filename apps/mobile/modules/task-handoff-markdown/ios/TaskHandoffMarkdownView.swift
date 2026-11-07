import ExpoModulesCore
import Foundation
import UIKit

public enum TaskHandoffMarkdownTableMetrics {
  public static let firstColumnWidth: CGFloat = 148
  public static let columnWidth: CGFloat = 112
  public static let horizontalInset: CGFloat = 13
  public static let verticalInset: CGFloat = 10
  public static let shadowInset: CGFloat = 4
  public static let shadowOffset = CGSize(width: 0, height: 1)
  public static let shadowOpacity: Float = 0.12
  public static let shadowRadius: CGFloat = 3

  public static func width(forColumn column: Int) -> CGFloat {
    column == 0 ? firstColumnWidth : columnWidth
  }

  public static func totalWidth(columnCount: Int) -> CGFloat {
    guard columnCount > 0 else { return 0 }
    return firstColumnWidth + CGFloat(columnCount - 1) * columnWidth
  }

  public static func textWidth(forColumn column: Int) -> CGFloat {
    max(1, width(forColumn: column) - horizontalInset * 2)
  }
}
private struct MarkdownAppearance: Equatable {
  var background = UIColor.clear
  var border = UIColor.separator
  var codeBackground = UIColor.secondarySystemBackground
  var codeForeground = UIColor.label
  var link = UIColor.link
  var muted = UIColor.secondaryLabel
  var surface = UIColor.systemBackground
  var surfaceHover = UIColor.secondarySystemBackground
  var surfaceInset = UIColor.systemBackground
  var surfaceRaised = UIColor.systemBackground
  var syntaxNumber = UIColor.systemOrange
  var tableBackground = UIColor.systemBackground
  var tableBorder = UIColor.separator
  var tableHeaderBackground = UIColor.secondarySystemBackground
  var tableStripe = UIColor.secondarySystemBackground
  var tableText = UIColor.label
  var text = UIColor.label

  var blockPayload: [String: String] {
    [
      "background": background.markdownHex,
      "border": border.markdownHex,
      "codeBackground": codeBackground.markdownHex,
      "codeForeground": codeForeground.markdownHex,
      "link": link.markdownHex,
      "muted": muted.markdownHex,
      "surface": surface.markdownHex,
      "surfaceHover": surfaceHover.markdownHex,
      "surfaceInset": surfaceInset.markdownHex,
      "surfaceRaised": surfaceRaised.markdownHex,
      "syntaxNumber": syntaxNumber.markdownHex,
      "tableBackground": tableBackground.markdownHex,
      "tableBorder": tableBorder.markdownHex,
      "tableHeaderBackground": tableHeaderBackground.markdownHex,
      "tableStripe": tableStripe.markdownHex,
      "tableText": tableText.markdownHex,
      "text": text.markdownHex,
    ]
  }
}

private struct MarkdownLabels: Equatable {
  var addToConversation = ""
  var copy = "Copy"
  var copied = "Copied"
  var plainText = "Plain text"
}

private struct MarkdownBlockContext {
  var identity: Int?
  var kind: PresentationIntent.Kind?
  var listKind: PresentationIntent.Kind?
  var listIdentities: [Int] = []
  var listOrdinal: Int?
  var tableRowIdentity: Int?
  var tableCellColumn: Int?
  var tableIdentity: Int?
  var tableColumnCount = 0
  var isTableHeader = false
  var blockQuoteIdentity: Int?
  var indentationLevel = 0
  var isBlockQuote = false
  var languageHint: String?
}

@objc public protocol TaskHandoffNativeBlockFactoryProtocol {
  static func makeBlockView(_ payload: NSDictionary) -> UIView
}

private enum NativeMarkdownBlockKind: String {
  case code
  case mermaid
  case rule
  case table
}

private let nativeMarkdownLocalLinkScheme = "taskhandoff-local-link"

private final class NativeMarkdownBlockAttachment: NSTextAttachment {
  let blockKey: String
  let kind: NativeMarkdownBlockKind
  let isStreaming: Bool
  let reuseSignature: String
  let payload: NSDictionary

  init(
    blockKey: String,
    kind: NativeMarkdownBlockKind,
    streaming: Bool,
    source: String = "",
    language: String? = nil,
    rows: [[String]] = [],
    headerRowCount: Int = 0,
    appearance: MarkdownAppearance,
    labels: MarkdownLabels,
    width: CGFloat,
    compact: Bool
  ) {
    self.blockKey = blockKey
    self.kind = kind
    isStreaming = streaming
    reuseSignature = Self.makeReuseSignature(
      kind: kind,
      source: source,
      language: language,
      rows: rows,
      headerRowCount: headerRowCount,
      appearance: appearance,
      labels: labels,
      width: width,
      compact: compact
    )
    let lineCount = max(1, source.reduce(1) { $1 == "\n" ? $0 + 1 : $0 })
    let rowHeights = Self.tableRowHeights(rows, headerRowCount: headerRowCount, compact: compact)
    let tableHeight = max(1, rowHeights.reduce(0, +))
    let height: CGFloat
    switch kind {
    case .code:
      let baseSize: CGFloat = compact ? 13 : 15
      let baseLineHeight: CGFloat = compact ? 20 : 25
      let baseFont = UIFont(name: "Menlo", size: baseSize) ?? UIFont.monospacedSystemFont(ofSize: baseSize, weight: .regular)
      let font = UIFontMetrics.default.scaledFont(for: baseFont)
      let lineHeight = baseLineHeight * font.pointSize / baseSize
      height = 39 + CGFloat(lineCount) * lineHeight + 24
    case .mermaid: height = compact ? 220 : 280
    case .rule: height = 22
    case .table: height = tableHeight + TaskHandoffMarkdownTableMetrics.shadowInset * 2
    }
    payload = [
      "kind": kind.rawValue,
      "source": source,
      "language": language ?? "",
      "compact": compact,
      "width": max(1, width),
      "height": height,
      "tableHeight": tableHeight,
      "streaming": streaming,
      "headerRowCount": headerRowCount,
      "rowHeights": rowHeights.map { NSNumber(value: Double($0)) },
      "rows": rows,
      "appearance": appearance.blockPayload,
      "labels": [
        "copy": labels.copy,
        "copied": labels.copied,
        "plainText": labels.plainText,
      ],
    ] as NSDictionary
    super.init(data: nil, ofType: nil)
    bounds = CGRect(x: 0, y: 0, width: max(1, width), height: height)
  }

  private static func makeReuseSignature(
    kind: NativeMarkdownBlockKind,
    source: String,
    language: String?,
    rows: [[String]],
    headerRowCount: Int,
    appearance: MarkdownAppearance,
    labels: MarkdownLabels,
    width: CGFloat,
    compact: Bool
  ) -> String {
    var fields = [
      kind.rawValue,
      source,
      language ?? "",
      String(headerRowCount),
      String(describing: width),
      compact ? "compact" : "standard",
      labels.copy,
      labels.copied,
      labels.plainText,
    ]
    fields.append(contentsOf: rows.map { $0.joined(separator: "\u{1F}") })
    fields.append(contentsOf: appearance.blockPayload.keys.sorted().map { "\($0)=\(appearance.blockPayload[$0] ?? "")" })
    return fields.joined(separator: "\u{1E}")
  }

  private static func tableRowHeights(_ rows: [[String]], headerRowCount: Int, compact: Bool) -> [CGFloat] {
    let baseSize: CGFloat = compact ? 13 : 16
    let baseLineHeight: CGFloat = compact ? 20 : 24
    let regularFont = UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: baseSize))
    let headerFont = UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: baseSize, weight: .bold))
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byWordWrapping
    return rows.enumerated().map { rowIndex, row in
      let font = rowIndex < headerRowCount ? headerFont : regularFont
      let lineHeight = baseLineHeight * font.pointSize / baseSize
      paragraph.minimumLineHeight = lineHeight
      paragraph.maximumLineHeight = lineHeight
      let contentHeight = row.enumerated().map { column, value in
        let width = TaskHandoffMarkdownTableMetrics.textWidth(forColumn: column)
        return ceil((value as NSString).boundingRect(
          with: CGSize(width: width, height: .greatestFiniteMagnitude),
          options: [.usesFontLeading, .usesLineFragmentOrigin],
          attributes: [.font: font, .paragraphStyle: paragraph],
          context: nil
        ).height)
      }.max() ?? lineHeight
      let verticalPadding = TaskHandoffMarkdownTableMetrics.verticalInset * 2
      return max(lineHeight + verticalPadding, contentHeight + verticalPadding)
    }
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  // Returning an image makes TextKit draw it; returning nil keeps the attachment as
  // layout space only. The live native block view is positioned by TaskHandoffMarkdownView.
  override func image(
    for bounds: CGRect,
    attributes: [NSAttributedString.Key: Any],
    location: any NSTextLocation,
    textContainer: NSTextContainer?
  ) -> UIImage? {
    nil
  }
}

private struct NativeMarkdownBlockOverlay {
  let view: UIView
  let kind: NativeMarkdownBlockKind
  let isStreaming: Bool
  let reuseSignature: String
}

private struct MarkdownFadeSpan {
  let range: NSRange
  let startedAt: CFTimeInterval
}

private extension NSAttributedString.Key {
  static let taskHandoffBlockQuote = NSAttributedString.Key("TaskHandoffMarkdownBlockQuote")
}

private final class NativeMarkdownBlockQuoteView: UIView {
  private let bar = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = .clear
    bar.layer.cornerRadius = 1.5
    addSubview(bar)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    bar.frame = CGRect(x: 0, y: 0, width: 3, height: bounds.height)
  }

  func setColor(_ color: UIColor) {
    bar.backgroundColor = color
  }
}

final class TaskHandoffMarkdownView: ExpoView, UITextViewDelegate {
  let onAddToConversation = EventDispatcher()
  let onLinkPress = EventDispatcher()
  let onLinkLongPress = EventDispatcher()

  private let textView: UITextView
  private let parserQueue = DispatchQueue(label: "com.taskhandoff.markdown.parser", qos: .userInitiated)
  private var appearance = MarkdownAppearance()
  private var markdown = ""
  private var streamKey: String?
  private var streaming = false
  private var compact = false
  private var trimEnd = false
  private var labels = MarkdownLabels()
  private var renderGeneration = 0
  private var renderedStreamKey: String?
  private var target = NSAttributedString()
  private var visibleLength = 0
  private var fadeSpans: [MarkdownFadeSpan] = []
  private var revealTimer: CADisplayLink?
  private var applyingSelection = false
  private var selectionHolding = false
  private var lastMeasuredWidth: CGFloat = 0
  private var lastMeasuredHeight: CGFloat = 0
  private var blockViews: [String: NativeMarkdownBlockOverlay] = [:]
  private var quoteViews: [Int: NativeMarkdownBlockQuoteView] = [:]
  private var blockOverlaySyncScheduled = false
  private var syncingBlockOverlays = false
  private var selectionDismissTap: UITapGestureRecognizer?

  required init(appContext: AppContext? = nil) {
    textView = UITextView(usingTextLayoutManager: true)
    super.init(appContext: appContext)

    clipsToBounds = false
    textView.backgroundColor = .clear
    textView.delegate = self
    textView.isEditable = false
    textView.isScrollEnabled = false
    textView.isSelectable = true
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.adjustsFontForContentSizeCategory = true
    textView.dataDetectorTypes = []
    addSubview(textView)
  }

  deinit {
    revealTimer?.invalidate()
    removeSelectionDismissTap()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    let width = bounds.width
    if width > 0, abs(width - lastMeasuredWidth) > 0.5 {
      lastMeasuredWidth = width
      scheduleRender()
    } else {
      updateMeasuredHeight()
    }
    scheduleBlockOverlaySync()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      removeSelectionDismissTap()
    } else if textView.isFirstResponder || textView.selectedRange.length > 0 {
      installSelectionDismissTap()
    }
  }

  func setMarkdown(_ value: String) {
    guard markdown != value else { return }
    markdown = value.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").replacingOccurrences(of: "\0", with: "�")
    scheduleRender()
  }

  func setStreamKey(_ value: String?) {
    guard streamKey != value else { return }
    streamKey = value
    scheduleRender()
  }

  func setStreaming(_ value: Bool) {
    guard streaming != value else { return }
    streaming = value
    scheduleRender()
  }

  func setCompact(_ value: Bool) {
    guard compact != value else { return }
    compact = value
    scheduleRender()
  }

  func setTrimEnd(_ value: Bool) {
    guard trimEnd != value else { return }
    trimEnd = value
    scheduleRender()
  }

  func setTheme(_ value: TaskHandoffMarkdownTheme) {
    let next = MarkdownAppearance(
      background: UIColor(markdownHex: value.background) ?? .clear,
      border: UIColor(markdownHex: value.border) ?? .separator,
      codeBackground: UIColor(markdownHex: value.codeBackground) ?? .secondarySystemBackground,
      codeForeground: UIColor(markdownHex: value.codeForeground) ?? .label,
      link: UIColor(markdownHex: value.link) ?? .link,
      muted: UIColor(markdownHex: value.muted) ?? .secondaryLabel,
      surface: UIColor(markdownHex: value.surface) ?? .systemBackground,
      surfaceHover: UIColor(markdownHex: value.surfaceHover) ?? .secondarySystemBackground,
      surfaceInset: UIColor(markdownHex: value.surfaceInset) ?? .systemBackground,
      surfaceRaised: UIColor(markdownHex: value.surfaceRaised) ?? .systemBackground,
      syntaxNumber: UIColor(markdownHex: value.syntaxNumber) ?? .systemOrange,
      tableBackground: UIColor(markdownHex: value.tableBackground) ?? .systemBackground,
      tableBorder: UIColor(markdownHex: value.tableBorder) ?? .separator,
      tableHeaderBackground: UIColor(markdownHex: value.tableHeaderBackground) ?? .secondarySystemBackground,
      tableStripe: UIColor(markdownHex: value.tableStripe) ?? .secondarySystemBackground,
      tableText: UIColor(markdownHex: value.tableText) ?? .label,
      text: UIColor(markdownHex: value.text) ?? .label
    )
    guard appearance != next else { return }
    appearance = next
    scheduleRender()
  }

  func setLabels(_ value: TaskHandoffMarkdownLabels) {
    let next = MarkdownLabels(
      addToConversation: value.addToConversation ?? "",
      copy: value.copy,
      copied: value.copied,
      plainText: value.plainText
    )
    guard labels != next else { return }
    labels = next
    scheduleRender()
  }

  private func scheduleRender() {
    renderGeneration += 1
    let generation = renderGeneration
    let source = markdown
    let appearance = appearance
    let compact = compact
    let trimEnd = trimEnd
    let labels = labels
    let streamKey = streamKey
    let streaming = streaming
    let width = max(lastMeasuredWidth, bounds.width)
    parserQueue.async { [weak self] in
      let rendered = NativeMarkdownRenderer.render(
        source,
        appearance: appearance,
        labels: labels,
        compact: compact,
        trimEnd: trimEnd,
        streamKey: streamKey,
        streaming: streaming,
        width: width
      )
      DispatchQueue.main.async {
        guard let self, self.renderGeneration == generation else { return }
        self.accept(rendered)
      }
    }
  }

  private func accept(_ rendered: NSAttributedString) {
    let streamChanged = renderedStreamKey != streamKey
    renderedStreamKey = streamKey
    target = rendered

    if selectionHolding {
      return
    }
    if streamChanged || !streaming {
      visibleLength = rendered.length
      fadeSpans.removeAll()
      applyVisibleTarget()
      stopRevealTimer()
      return
    }

    let currentlyVisible = textView.attributedText?.string ?? ""
    guard rendered.string.hasPrefix(currentlyVisible) else {
      visibleLength = rendered.length
      fadeSpans.removeAll()
      applyVisibleTarget()
      stopRevealTimer()
      return
    }
    visibleLength = min(visibleLength, rendered.length)
    applyVisibleTarget()
    startRevealTimerIfNeeded()
  }

  private func startRevealTimerIfNeeded() {
    guard (visibleLength < target.length || !fadeSpans.isEmpty), revealTimer == nil, !selectionHolding else { return }
    let timer = CADisplayLink(target: self, selector: #selector(revealFrame))
    timer.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
    timer.add(to: .main, forMode: .common)
    revealTimer = timer
  }

  private func stopRevealTimer() {
    revealTimer?.invalidate()
    revealTimer = nil
  }

  @objc private func revealFrame() {
    guard !selectionHolding else {
      stopRevealTimer()
      return
    }

    let now = CACurrentMediaTime()
    if visibleLength < target.length {
      let backlog = target.length - visibleLength
      let step = min(8, max(1, Int(ceil(Double(backlog) / 30.0))))
      let range = (target.string as NSString).rangeOfComposedCharacterSequences(
        for: NSRange(location: visibleLength, length: min(step, backlog))
      )
      visibleLength = min(target.length, NSMaxRange(range))
      fadeSpans.append(MarkdownFadeSpan(range: range, startedAt: now))
    }
    fadeSpans.removeAll { now - $0.startedAt >= 0.16 }
    applyVisibleTarget()
    if visibleLength >= target.length, fadeSpans.isEmpty {
      stopRevealTimer()
    }
  }

  private func applyVisibleTarget() {
    let selected = textView.selectedRange
    let next = NSMutableAttributedString(
      attributedString: target.attributedSubstring(from: NSRange(location: 0, length: min(visibleLength, target.length)))
    )
    applyFade(to: next)
    applyingSelection = true
    textView.textStorage.setAttributedString(next)
    if selected.location <= next.length {
      textView.selectedRange = NSRange(location: selected.location, length: min(selected.length, next.length - selected.location))
    }
    applyingSelection = false
    updateMeasuredHeight()
    scheduleBlockOverlaySync()
  }

  private func scheduleBlockOverlaySync() {
    guard !blockOverlaySyncScheduled else { return }
    blockOverlaySyncScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.blockOverlaySyncScheduled = false
      self.syncBlockOverlays()
    }
  }

  private func syncBlockOverlays() {
    guard !syncingBlockOverlays, let layoutManager = textView.textLayoutManager else { return }
    syncingBlockOverlays = true
    defer { syncingBlockOverlays = false }

    // TextKit 2 creates attachment view providers but does not install their views in this
    // UITextView configuration. Keep the attachment as layout space and host the native block
    // above the text view at the fragment's frame, which also survives streaming text updates.
    var attachments: [(NativeMarkdownBlockAttachment, Int)] = []
    textView.textStorage.enumerateAttribute(
      .attachment,
      in: NSRange(location: 0, length: textView.textStorage.length),
      options: [.longestEffectiveRangeNotRequired]
    ) { value, range, _ in
      guard let attachment = value as? NativeMarkdownBlockAttachment else { return }
      attachments.append((attachment, range.location))
    }

    layoutManager.ensureLayout(for: layoutManager.documentRange)
    var active = Set<String>()
    for (attachment, characterIndex) in attachments {
      let blockKey = attachment.blockKey
      active.insert(blockKey)
      let cached = blockViews[blockKey]
      let shouldReuse = cached.map { cached in
        if attachment.kind == .mermaid {
          if attachment.isStreaming {
            return cached.kind == .mermaid && cached.isStreaming
          }
          return cached.kind == .mermaid
            && !cached.isStreaming
            && cached.reuseSignature == attachment.reuseSignature
        }
        return cached.kind == attachment.kind && cached.reuseSignature == attachment.reuseSignature
      } ?? false
      let view: UIView
      if shouldReuse, let cached {
        view = cached.view
      } else {
        cached?.view.removeFromSuperview()
        view = makeBlockView(attachment)
        blockViews[blockKey] = NativeMarkdownBlockOverlay(
          view: view,
          kind: attachment.kind,
          isStreaming: attachment.isStreaming,
          reuseSignature: attachment.reuseSignature
        )
        addSubview(view)
      }
      guard let frame = blockFrame(for: attachment, at: characterIndex, layoutManager: layoutManager) else {
        view.isHidden = true
        continue
      }
      view.isHidden = false
      view.frame = frame
    }

    let staleKeys = blockViews.keys.filter { !active.contains($0) }
    for key in staleKeys {
      blockViews.removeValue(forKey: key)?.view.removeFromSuperview()
    }

    syncQuoteOverlays(layoutManager: layoutManager)
  }

  private func syncQuoteOverlays(layoutManager: NSTextLayoutManager) {
    var rangesByQuote: [Int: [NSRange]] = [:]
    textView.textStorage.enumerateAttribute(
      .taskHandoffBlockQuote,
      in: NSRange(location: 0, length: textView.textStorage.length),
      options: []
    ) { value, range, _ in
      guard let identity = (value as? NSNumber)?.intValue, range.length > 0 else { return }
      rangesByQuote[identity, default: []].append(range)
    }

    var active = Set<Int>()
    for (identity, ranges) in rangesByQuote {
      active.insert(identity)
      let view = quoteViews[identity] ?? NativeMarkdownBlockQuoteView(frame: .zero)
      if quoteViews[identity] == nil {
        quoteViews[identity] = view
        insertSubview(view, at: 0)
      }
      guard let frame = quoteFrame(for: ranges, layoutManager: layoutManager) else {
        view.isHidden = true
        continue
      }
      view.setColor(appearance.border)
      view.isHidden = false
      view.frame = frame
    }

    let staleIdentities = quoteViews.keys.filter { !active.contains($0) }
    for identity in staleIdentities {
      quoteViews.removeValue(forKey: identity)?.removeFromSuperview()
    }
  }

  private func quoteFrame(for ranges: [NSRange], layoutManager: NSTextLayoutManager) -> CGRect? {
    guard !ranges.isEmpty else { return nil }
    var top = CGFloat.greatestFiniteMagnitude
    var bottom = -CGFloat.greatestFiniteMagnitude
    for range in ranges {
      guard let start = layoutManager.location(layoutManager.documentRange.location, offsetBy: range.location),
            let end = layoutManager.location(layoutManager.documentRange.location, offsetBy: NSMaxRange(range) - 1) else { continue }
      layoutManager.ensureLayout(for: NSTextRange(location: start, end: end) ?? NSTextRange(location: start))
      if let fragment = layoutManager.textLayoutFragment(for: start) {
        top = min(top, fragment.layoutFragmentFrame.minY)
      }
      if let fragment = layoutManager.textLayoutFragment(for: end) {
        // TextKit includes trailing paragraph spacing in layoutFragmentFrame.
        // Quote bars should only cover rendered lines, not the gap to the next block.
        let contentBottom = fragment.textLineFragments.last.map {
          fragment.layoutFragmentFrame.minY + $0.typographicBounds.maxY
        } ?? (fragment.layoutFragmentFrame.maxY - fragment.bottomMargin)
        bottom = max(bottom, contentBottom)
      }
    }
    guard top.isFinite, bottom.isFinite, bottom > top else { return nil }
    let inset = textView.textContainerInset
    let verticalPadding: CGFloat = compact ? 4 : 6
    return CGRect(
      x: inset.left,
      y: top + inset.top - verticalPadding,
      width: 3,
      height: bottom - top + verticalPadding * 2
    )
  }

  private func blockFrame(
    for attachment: NativeMarkdownBlockAttachment,
    at characterIndex: Int,
    layoutManager: NSTextLayoutManager
  ) -> CGRect? {
    guard let location = layoutManager.location(layoutManager.documentRange.location, offsetBy: characterIndex) else {
      return nil
    }
    layoutManager.ensureLayout(for: NSTextRange(location: location))
    guard let fragment = layoutManager.textLayoutFragment(for: location) else { return nil }
    let fragmentFrame = fragment.layoutFragmentFrame
    let inset = textView.textContainerInset
    let width = min(attachment.bounds.width, max(1, fragmentFrame.width))
    return CGRect(
      x: fragmentFrame.minX + inset.left,
      y: fragmentFrame.minY + inset.top,
      width: width,
      height: attachment.bounds.height
    )
  }

  private func makeBlockView(_ attachment: NativeMarkdownBlockAttachment) -> UIView {
    let factory = NSClassFromString("TaskHandoffNativeBlockFactory") as? TaskHandoffNativeBlockFactoryProtocol.Type
    if let view = factory?.makeBlockView(attachment.payload) { return view }

    let fallback = UITextView(frame: .zero)
    fallback.backgroundColor = .secondarySystemBackground
    fallback.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
    fallback.isEditable = false
    fallback.isScrollEnabled = true
    fallback.isSelectable = true
    fallback.text = attachment.payload["source"] as? String
    return fallback
  }

  private func applyFade(to value: NSMutableAttributedString) {
    let now = CACurrentMediaTime()
    for span in fadeSpans {
      let range = NSIntersectionRange(span.range, NSRange(location: 0, length: value.length))
      guard range.length > 0 else { continue }
      let progress = max(0, min(1, (now - span.startedAt) / 0.16))
      value.enumerateAttribute(.foregroundColor, in: range) { raw, colorRange, _ in
        guard let color = raw as? UIColor else { return }
        value.addAttribute(.foregroundColor, value: color.withAlphaComponent(CGFloat(progress)), range: colorRange)
      }
    }
  }

  private func updateMeasuredHeight() {
    let width = bounds.width
    guard width > 0 else { return }
    let measured = ceil(textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    guard measured.isFinite, abs(measured - lastMeasuredHeight) > 0.5 else { return }
    lastMeasuredHeight = measured
    setShadowNodeSize(Float(width), height: Float(max(1, measured)))
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    guard !applyingSelection else { return }
    let holding = textView.selectedRange.length > 0
    guard selectionHolding != holding else { return }
    selectionHolding = holding
    if holding {
      installSelectionDismissTap()
      stopRevealTimer()
    } else {
      if !textView.isFirstResponder { removeSelectionDismissTap() }
      applyVisibleTarget()
      startRevealTimerIfNeeded()
    }
  }

  func textViewDidBeginEditing(_ textView: UITextView) {
    installSelectionDismissTap()
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    selectionHolding = false
    removeSelectionDismissTap()
    applyVisibleTarget()
    startRevealTimerIfNeeded()
  }

  func textView(
    _ textView: UITextView,
    editMenuForTextIn range: NSRange,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    let title = labels.addToConversation.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, let selectedText = selectedPlainText(in: range) else {
      return UIMenu(children: suggestedActions)
    }
    let addToConversation = UIAction(
      title: title,
      image: UIImage(systemName: "text.bubble")
    ) { [weak self] _ in
      guard let self else { return }
      self.onAddToConversation(["text": selectedText])
      self.clearTextSelection()
    }
    return UIMenu(children: [addToConversation] + suggestedActions)
  }

  private func selectedPlainText(in range: NSRange) -> String? {
    guard range.location != NSNotFound,
          range.location >= 0,
          range.length > 0,
          NSMaxRange(range) <= textView.attributedText.length else { return nil }
    let selected = textView.attributedText.attributedSubstring(from: range).string
    let text = selected
      .replacingOccurrences(of: "\u{FFFC}", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  private func installSelectionDismissTap() {
    guard selectionDismissTap == nil, let window else { return }
    let tap = UITapGestureRecognizer(target: self, action: #selector(handleSelectionDismissTap(_:)))
    tap.cancelsTouchesInView = false
    tap.delegate = self
    window.addGestureRecognizer(tap)
    selectionDismissTap = tap
  }

  private func removeSelectionDismissTap() {
    guard let tap = selectionDismissTap else { return }
    tap.view?.removeGestureRecognizer(tap)
    selectionDismissTap = nil
  }

  @objc private func handleSelectionDismissTap(_ gesture: UITapGestureRecognizer) {
    guard textView.isFirstResponder || textView.selectedRange.length > 0 else {
      removeSelectionDismissTap()
      return
    }
    let point = gesture.location(in: textView)
    if textView.selectedRange.length > 0, textView.bounds.contains(point), selectionContains(point) {
      return
    }
    clearTextSelection()
  }

  private func selectionContains(_ point: CGPoint) -> Bool {
    guard let range = textView.selectedTextRange else { return false }
    return textView.selectionRects(for: range).contains { selectionRect in
      !selectionRect.rect.isNull && !selectionRect.rect.isEmpty
        && selectionRect.rect.insetBy(dx: -4, dy: -4).contains(point)
    }
  }

  private func clearTextSelection() {
    let location = min(textView.selectedRange.location, textView.textStorage.length)
    textView.selectedRange = NSRange(location: location, length: 0)
    textView.resignFirstResponder()
    removeSelectionDismissTap()
  }

  func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    guard let target = NativeMarkdownRenderer.linkTarget(from: URL) else { return false }
    if interaction == .presentActions {
      let rect = linkAnchor(for: characterRange) ?? textView.bounds
      let windowRect = textView.convert(rect, to: nil)
      onLinkLongPress([
        "url": target,
        "x": Double(windowRect.minX),
        "y": Double(windowRect.minY),
        "width": Double(windowRect.width),
        "height": Double(windowRect.height),
      ])
      return false
    }
    onLinkPress(["url": target])
    return false
  }

  private func linkAnchor(for range: NSRange) -> CGRect? {
    guard range.length > 0,
          let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
          let end = textView.position(from: start, offset: range.length),
          let textRange = textView.textRange(from: start, to: end) else { return nil }
    let rects = textView.selectionRects(for: textRange)
      .map(\.rect)
      .filter { !$0.isNull && !$0.isEmpty && $0.minX.isFinite && $0.minY.isFinite && $0.maxX.isFinite && $0.maxY.isFinite }
    guard var result = rects.first else { return nil }
    for rect in rects.dropFirst() { result = result.union(rect) }
    return result
  }
}

extension TaskHandoffMarkdownView: UIGestureRecognizerDelegate {
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }
}

private struct NativeMarkdownTableContent {
  private(set) var rowOrder: [Int] = []
  private(set) var cells: [Int: [Int: String]] = [:]
  private(set) var headerRows = Set<Int>()
  private(set) var columnCount = 0

  mutating func append(_ value: String, row: Int, column: Int, header: Bool, declaredColumnCount: Int) {
    if cells[row] == nil { rowOrder.append(row) }
    cells[row, default: [:]][column, default: ""] += value
    if header { headerRows.insert(row) }
    columnCount = max(columnCount, declaredColumnCount, column + 1)
  }

  var rows: [[String]] {
    rowOrder.map { row in
      (0..<columnCount).map { cells[row]?[$0] ?? "" }
    }
  }

  var headerRowCount: Int {
    rowOrder.prefix { headerRows.contains($0) }.count
  }
}

private enum NativeMarkdownRenderer {
  static func render(
    _ markdown: String,
    appearance: MarkdownAppearance,
    labels: MarkdownLabels,
    compact: Bool,
    trimEnd: Bool,
    streamKey: String?,
    streaming: Bool,
    width: CGFloat
  ) -> NSAttributedString {
    let parsed: AttributedString
    do {
      parsed = try AttributedString(
        markdown: markdown,
        options: .init(
          allowsExtendedAttributes: false,
          interpretedSyntax: .full,
          failurePolicy: .returnPartiallyParsedIfPossible,
          languageCode: nil,
          appliesSourcePositionAttributes: true
        )
      )
    } catch {
      return NSAttributedString(string: markdown, attributes: baseAttributes(appearance: appearance, compact: compact))
    }

    let result = NSMutableAttributedString()
    var previous: MarkdownBlockContext?
    var emittedBlockIdentities = Set<Int>()
    var emittedTableIdentities = Set<Int>()
    var blockSources: [Int: String] = [:]
    var tables: [Int: NativeMarkdownTableContent] = [:]
    let runs = Array(parsed.runs)
    let contexts = runs.map { blockContext($0.presentationIntent) }
    let streamIdentity = streamKey ?? "static"
    var blockOrdinal = 0
    func nextBlockKey(_ kind: NativeMarkdownBlockKind) -> String {
      blockOrdinal += 1
      return "\(streamIdentity):\(kind.rawValue):\(blockOrdinal)"
    }
    for (run, context) in zip(runs, contexts) {
      let value = NSAttributedString(AttributedString(parsed[run.range])).string
      if case .codeBlock? = context.kind, let identity = context.identity {
        blockSources[identity, default: ""] += value
      }
      if let tableIdentity = context.tableIdentity,
         let rowIdentity = context.tableRowIdentity,
         let column = context.tableCellColumn {
        var table = tables[tableIdentity] ?? NativeMarkdownTableContent()
        table.append(
          value,
          row: rowIdentity,
          column: column,
          header: context.isTableHeader,
          declaredColumnCount: context.tableColumnCount
        )
        tables[tableIdentity] = table
      }
    }

    for (index, run) in runs.enumerated() {
      let context = contexts[index]
      let previousBlockContext = contexts[..<index].last { $0.identity != context.identity }
      let startsAfterTopLevelList = previousBlockContext?.listIdentities.first.map { listIdentity in
        !context.listIdentities.contains(listIdentity)
      } ?? false
      if let tableIdentity = context.tableIdentity {
        defer { previous = context }
        guard emittedTableIdentities.insert(tableIdentity).inserted,
              let table = tables[tableIdentity] else { continue }
        if previous?.tableIdentity != tableIdentity {
          appendBoundary(to: result, previous: previous, next: context, appearance: appearance, compact: compact, width: width)
        }
        let attachment = NativeMarkdownBlockAttachment(
          blockKey: nextBlockKey(.table),
          kind: .table,
          streaming: streaming,
          source: table.rows.map { $0.joined(separator: "\t") }.joined(separator: "\n"),
          rows: table.rows,
          headerRowCount: table.headerRowCount,
          appearance: appearance,
          labels: labels,
          width: max(1, width),
          compact: compact
        )
        let block = NSMutableAttributedString(attachment: attachment)
        let paragraph = NSMutableParagraphStyle()
        paragraph.paragraphSpacing = 11
        block.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: block.length))
        result.append(block)
        continue
      }

      let startsBlock = context.identity != previous?.identity
      if startsBlock {
        appendBoundary(to: result, previous: previous, next: context, appearance: appearance, compact: compact, width: width)
      }

      if case .codeBlock? = context.kind, let identity = context.identity {
        defer { previous = context }
        guard emittedBlockIdentities.insert(identity).inserted else { continue }
        let source = blockSources[identity, default: ""].trimmingCharacters(in: .newlines)
        let language = context.languageHint?.trimmingCharacters(in: .whitespacesAndNewlines)
        let kind: NativeMarkdownBlockKind = language?.lowercased() == "mermaid" ? .mermaid : .code
        let attachment = NativeMarkdownBlockAttachment(
          blockKey: nextBlockKey(kind),
          kind: kind,
          streaming: streaming,
          source: source,
          language: language,
          appearance: appearance,
          labels: labels,
          width: max(1, width),
          compact: compact
        )
        let block = NSMutableAttributedString(attachment: attachment)
        let paragraph = NSMutableParagraphStyle()
        let spacing = codeBlockSpacing(compact: compact)
        paragraph.paragraphSpacingBefore = spacing
        paragraph.paragraphSpacing = spacing
        block.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: block.length))
        result.append(block)
        continue
      }

      if case .thematicBreak? = context.kind, let identity = context.identity {
        defer { previous = context }
        guard emittedBlockIdentities.insert(identity).inserted else { continue }
        let attachment = NativeMarkdownBlockAttachment(
          blockKey: nextBlockKey(.rule),
          kind: .rule,
          streaming: streaming,
          appearance: appearance,
          labels: labels,
          width: max(1, width),
          compact: compact
        )
        result.append(NSAttributedString(attachment: attachment))
        continue
      }

      var fragment = NSAttributedString(AttributedString(parsed[run.range]))
      if let inline = run.inlinePresentationIntent, inline.contains(.softBreak) || inline.contains(.lineBreak) {
        fragment = NSAttributedString(string: "\n")
      }
      let mutable = NSMutableAttributedString(attributedString: fragment)
      style(
        mutable,
        inline: run.inlinePresentationIntent,
        context: context,
        appearance: appearance,
        compact: compact,
        width: width,
        startsAfterTopLevelList: startsAfterTopLevelList
      )
      sanitizeLinksAndImages(mutable, appearance: appearance)
      if let blockQuoteIdentity = context.blockQuoteIdentity {
        mutable.addAttribute(
          .taskHandoffBlockQuote,
          value: NSNumber(value: blockQuoteIdentity),
          range: NSRange(location: 0, length: mutable.length)
        )
      }
      result.append(mutable)
      previous = context
    }

    if !trimEnd, result.length > 0 {
      result.append(NSAttributedString(string: "\n", attributes: baseAttributes(appearance: appearance, compact: compact)))
    }
    return result
  }

  private static func blockContext(_ intent: PresentationIntent?) -> MarkdownBlockContext {
    var result = MarkdownBlockContext()
    guard let intent else { return result }
    result.indentationLevel = intent.indentationLevel
    for component in intent.components {
      switch component.kind {
      case .paragraph, .header, .codeBlock, .thematicBreak, .tableCell:
        if result.identity == nil {
          result.identity = component.identity
          result.kind = component.kind
        }
        if case .tableCell(let column) = component.kind { result.tableCellColumn = column }
        if case .codeBlock(let languageHint) = component.kind { result.languageHint = languageHint }
      case .orderedList, .unorderedList:
        result.listKind = component.kind
        result.listIdentities.append(component.identity)
      case .listItem(let ordinal):
        result.listOrdinal = ordinal
      case .tableHeaderRow:
        result.tableRowIdentity = component.identity
        result.isTableHeader = true
      case .tableRow:
        result.tableRowIdentity = component.identity
      case .blockQuote:
        result.isBlockQuote = true
        result.blockQuoteIdentity = component.identity
      case .table(let columns):
        result.tableIdentity = component.identity
        result.tableColumnCount = columns.count
      @unknown default:
        break
      }
    }
    return result
  }

  private static func appendBoundary(
    to result: NSMutableAttributedString,
    previous: MarkdownBlockContext?,
    next: MarkdownBlockContext,
    appearance: MarkdownAppearance,
    compact: Bool,
    width: CGFloat
  ) {
    if let previous {
      let sameTableRow = previous.tableRowIdentity != nil && previous.tableRowIdentity == next.tableRowIdentity
      result.append(NSAttributedString(string: sameTableRow ? "\t" : "\n", attributes: baseAttributes(appearance: appearance, compact: compact)))
    }
    guard next.listOrdinal != nil else { return }
    let indent = String(repeating: "  ", count: max(0, next.indentationLevel - 2))
    let marker: String
    if case .orderedList? = next.listKind {
      marker = "\(next.listOrdinal ?? 1).\t"
    } else {
      marker = "•\t"
    }
    result.append(NSAttributedString(string: indent + marker, attributes: baseAttributes(appearance: appearance, compact: compact)))
  }

  private static func codeBlockSpacing(compact: Bool) -> CGFloat {
    compact ? 6 : 9
  }

  private static func style(
    _ value: NSMutableAttributedString,
    inline: InlinePresentationIntent?,
    context: MarkdownBlockContext,
    appearance: MarkdownAppearance,
    compact: Bool,
    width: CGFloat,
    startsAfterTopLevelList: Bool
  ) {
    let range = NSRange(location: 0, length: value.length)
    guard range.length > 0 else { return }
    let bodySize: CGFloat = compact ? 13 : 16
    let bodyLineHeight: CGFloat = compact ? 20 : 24
    var font = scaledFont(size: bodySize)
    var lineHeight = scaledMetric(bodyLineHeight, relativeTo: bodySize, font: font)
    var foreground = appearance.text
    let paragraph = NSMutableParagraphStyle()
    paragraph.paragraphSpacing = compact ? 4 : 9

    switch context.kind {
    case .header(let level):
      let sizes = compact ? [17.0, 16.0, 15.0, 16.0, 15.0, 15.0] : [25.0, 21.0, 18.0, 16.0, 15.0, 15.0]
      let lineHeights = compact ? [22.0, 21.0, 20.0, 23.0, 23.0, 23.0] : [32.0, 28.0, 25.0, 23.0, 23.0, 23.0]
      let index = min(max(level - 1, 0), sizes.count - 1)
      font = scaledFont(size: sizes[index], weight: .bold)
      lineHeight = scaledMetric(lineHeights[index], relativeTo: sizes[index], font: font)
      if level == 6 { foreground = appearance.muted }
      paragraph.paragraphSpacingBefore = compact ? 8 : 15
      paragraph.paragraphSpacing = compact ? 5 : 7
    case .codeBlock:
      font = UIFont.monospacedSystemFont(ofSize: compact ? 12 : 13, weight: .regular)
      foreground = appearance.codeForeground
      paragraph.firstLineHeadIndent = 12
      paragraph.headIndent = 12
      paragraph.tailIndent = -12
      let spacing = codeBlockSpacing(compact: compact)
      paragraph.paragraphSpacingBefore = spacing
      paragraph.paragraphSpacing = spacing
      value.addAttribute(.backgroundColor, value: appearance.codeBackground, range: range)
    case .thematicBreak:
      foreground = appearance.border
      font = scaledFont(size: bodySize)
    case .tableCell:
      font = scaledFont(size: bodySize)
      let available = max(220, width)
      paragraph.tabStops = stride(from: min(148, available * 0.38), through: available, by: max(112, available * 0.3)).map {
        NSTextTab(textAlignment: .left, location: $0)
      }
      paragraph.defaultTabInterval = max(112, available * 0.3)
    default:
      break
    }

    if context.listOrdinal != nil {
      paragraph.firstLineHeadIndent = CGFloat(max(0, context.indentationLevel - 2)) * 18
      paragraph.headIndent = paragraph.firstLineHeadIndent + 24
      paragraph.tabStops = [NSTextTab(textAlignment: .left, location: paragraph.headIndent + 1)]
      paragraph.paragraphSpacing = 3
    }
    if context.isBlockQuote {
      paragraph.firstLineHeadIndent = 15
      paragraph.headIndent = 15
      paragraph.tailIndent = -12
      paragraph.tabStops = [NSTextTab(textAlignment: .left, location: paragraph.headIndent + 1)]
      paragraph.paragraphSpacingBefore = 0
      paragraph.paragraphSpacing = compact ? 4 : 8
    }
    if startsAfterTopLevelList {
      paragraph.paragraphSpacingBefore = compact ? 8 : 14
    }

    if let inline {
      var traits = font.fontDescriptor.symbolicTraits
      if inline.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
      if inline.contains(.emphasized) { traits.insert(.traitItalic) }
      if let descriptor = font.fontDescriptor.withSymbolicTraits(traits) { font = UIFont(descriptor: descriptor, size: font.pointSize) }
      if inline.contains(.code) {
        font = scaledMonospacedFont(size: bodySize)
        foreground = appearance.syntaxNumber
      }
      if inline.contains(.strikethrough) {
        value.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
      }
    }

    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    value.addAttributes([
      .font: font,
      .foregroundColor: foreground,
      .paragraphStyle: paragraph,
    ], range: range)
  }

  private static func sanitizeLinksAndImages(_ value: NSMutableAttributedString, appearance: MarkdownAppearance) {
    let range = NSRange(location: 0, length: value.length)
    value.removeAttribute(NSAttributedString.Key("NSImageURL"), range: range)
    value.enumerateAttribute(.link, in: range) { raw, linkRange, _ in
      let url = raw as? URL ?? (raw as? String).flatMap(URL.init(string:))
      let target: URL
      if let url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
        target = url
      } else if let localTarget = localLinkTarget(url), let localURL = localLinkURL(localTarget) {
        target = localURL
      } else {
        value.removeAttribute(.link, range: linkRange)
        return
      }
      value.addAttributes([
        .link: target,
        .foregroundColor: appearance.link,
        .underlineStyle: NSUnderlineStyle.single.rawValue,
      ], range: linkRange)
    }
  }

  private static func localLinkTarget(_ url: URL?) -> String? {
    guard let url else { return nil }
    let scheme = url.scheme?.lowercased()
    if scheme == "file" { return url.absoluteString }
    guard scheme == nil else { return nil }
    let target = url.relativeString
    return target.isEmpty || target.hasPrefix("#") ? nil : target
  }

  private static func localLinkURL(_ target: String) -> URL? {
    var components = URLComponents()
    components.scheme = nativeMarkdownLocalLinkScheme
    components.host = "local"
    components.queryItems = [URLQueryItem(name: "target", value: target)]
    return components.url
  }

  fileprivate static func linkTarget(from url: URL) -> String? {
    if url.scheme?.lowercased() == nativeMarkdownLocalLinkScheme {
      return URLComponents(url: url, resolvingAgainstBaseURL: false)?
        .queryItems?
        .first(where: { $0.name == "target" })?
        .value
    }
    guard ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return nil }
    return url.absoluteString
  }

  private static func baseAttributes(appearance: MarkdownAppearance, compact: Bool) -> [NSAttributedString.Key: Any] {
    let size: CGFloat = compact ? 13 : 16
    let baseLineHeight: CGFloat = compact ? 20 : 24
    let font = scaledFont(size: size)
    let paragraph = NSMutableParagraphStyle()
    let lineHeight = scaledMetric(baseLineHeight, relativeTo: size, font: font)
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    return [
      .font: font,
      .foregroundColor: appearance.text,
      .paragraphStyle: paragraph,
    ]
  }

  private static func scaledFont(size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
    UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: size, weight: weight))
  }

  private static func scaledMonospacedFont(size: CGFloat) -> UIFont {
    let base = UIFont(name: "Menlo", size: size) ?? UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    return UIFontMetrics.default.scaledFont(for: base)
  }

  private static func scaledMetric(_ value: CGFloat, relativeTo baseSize: CGFloat, font: UIFont) -> CGFloat {
    value * font.pointSize / baseSize
  }
}

private extension UIColor {
  var markdownHex: String {
    guard let components = cgColor.converted(to: CGColorSpaceCreateDeviceRGB(), intent: .defaultIntent, options: nil)?.components,
          components.count >= 3 else { return "#000000" }
    let alpha = components.count >= 4 ? components[3] : 1
    return String(format: "#%02X%02X%02X%02X", Int(components[0] * 255), Int(components[1] * 255), Int(components[2] * 255), Int(alpha * 255))
  }

  convenience init?(markdownHex value: String) {
    let raw = value.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
    guard raw.count == 6 || raw.count == 8, let number = UInt64(raw, radix: 16) else { return nil }
    let hasAlpha = raw.count == 8
    let red = CGFloat((number >> (hasAlpha ? 24 : 16)) & 0xff) / 255
    let green = CGFloat((number >> (hasAlpha ? 16 : 8)) & 0xff) / 255
    let blue = CGFloat((number >> (hasAlpha ? 8 : 0)) & 0xff) / 255
    let alpha = hasAlpha ? CGFloat(number & 0xff) / 255 : 1
    self.init(red: red, green: green, blue: blue, alpha: alpha)
  }
}
