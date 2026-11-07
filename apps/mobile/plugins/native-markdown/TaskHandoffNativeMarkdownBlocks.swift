import BeautifulMermaid
import Highlighter
internal import TaskHandoffMarkdown
import UIKit

@objc(TaskHandoffNativeBlockFactory)
final class TaskHandoffNativeBlockFactory: NSObject, TaskHandoffNativeBlockFactoryProtocol {
  @objc static func makeBlockView(_ payload: NSDictionary) -> UIView {
    let kind = payload["kind"] as? String ?? "code"
    switch kind {
    case "rule": return NativeMarkdownRuleView(payload: payload)
    case "table": return NativeMarkdownTableView(payload: payload)
    default: return NativeMarkdownBlockView(payload: payload, rendersMermaid: kind == "mermaid")
    }
  }
}
private enum NativeMarkdownCopyIcon {
  case copy
  case check
}

private final class NativeMarkdownCopyIconView: UIView {
  var icon = NativeMarkdownCopyIcon.copy {
    didSet { setNeedsDisplay() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    isOpaque = false
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var intrinsicContentSize: CGSize { CGSize(width: 16, height: 16) }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    let scale = min(bounds.width, bounds.height) / 24
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    context.setStrokeColor(tintColor.cgColor)
    context.setLineWidth(2)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    switch icon {
    case .copy:
      UIBezierPath(
        roundedRect: CGRect(x: 8, y: 8, width: 14, height: 14),
        cornerRadius: 2
      ).stroke()

      let back = UIBezierPath()
      back.move(to: CGPoint(x: 4, y: 16))
      back.addCurve(to: CGPoint(x: 2, y: 14), controlPoint1: CGPoint(x: 2.9, y: 16), controlPoint2: CGPoint(x: 2, y: 15.1))
      back.addLine(to: CGPoint(x: 2, y: 4))
      back.addCurve(to: CGPoint(x: 4, y: 2), controlPoint1: CGPoint(x: 2, y: 2.9), controlPoint2: CGPoint(x: 2.9, y: 2))
      back.addLine(to: CGPoint(x: 14, y: 2))
      back.addCurve(to: CGPoint(x: 16, y: 4), controlPoint1: CGPoint(x: 15.1, y: 2), controlPoint2: CGPoint(x: 16, y: 2.9))
      back.stroke()
    case .check:
      let check = UIBezierPath()
      check.move(to: CGPoint(x: 20, y: 6))
      check.addLine(to: CGPoint(x: 9, y: 17))
      check.addLine(to: CGPoint(x: 4, y: 12))
      check.stroke()
    }
    context.restoreGState()
  }
}

private final class NativeMarkdownCopyButton: UIControl {
  private let iconView = NativeMarkdownCopyIconView()
  private let titleLabel = UILabel()
  private let source: String
  private let copyLabel: String
  private let copiedLabel: String
  private let textColor: UIColor
  private let pressedColor: UIColor
  private var resetWorkItem: DispatchWorkItem?
  private var copied = false

  init(source: String, labels: [String: String], textColor: UIColor, pressedColor: UIColor) {
    self.source = source
    copyLabel = labels["copy"] ?? "Copy"
    copiedLabel = labels["copied"] ?? "Copied"
    self.textColor = textColor
    self.pressedColor = pressedColor
    super.init(frame: .zero)

    layer.cornerRadius = 6
    iconView.tintColor = textColor
    addSubview(iconView)
    titleLabel.textColor = textColor
    titleLabel.numberOfLines = 1
    titleLabel.lineBreakMode = .byClipping
    addSubview(titleLabel)
    isAccessibilityElement = true
    accessibilityTraits = .button
    addTarget(self, action: #selector(copySource), for: .touchUpInside)
    updateContent()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    resetWorkItem?.cancel()
  }

  override var intrinsicContentSize: CGSize {
    CGSize(width: 30 + textSize(copied ? copiedLabel : copyLabel).width + 8, height: 32)
  }

  override var isHighlighted: Bool {
    didSet { backgroundColor = isHighlighted ? pressedColor : .clear }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    iconView.frame = CGRect(x: 8, y: (bounds.height - 16) / 2, width: 16, height: 16)
    let measured = textSize(copied ? copiedLabel : copyLabel).width
    titleLabel.frame = CGRect(x: 30, y: (bounds.height - 19) / 2, width: ceil(measured), height: 19)
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    bounds.insetBy(dx: -6, dy: -6).contains(point)
  }

  @objc private func copySource() {
    UIPasteboard.general.string = source
    copied = true
    updateContent()
    resetWorkItem?.cancel()
    let reset = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.copied = false
      self.updateContent()
    }
    resetWorkItem = reset
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: reset)
  }

  private func updateContent() {
    iconView.icon = copied ? .check : .copy
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = 19
    paragraph.maximumLineHeight = 19
    titleLabel.attributedText = NSAttributedString(
      string: copied ? copiedLabel : copyLabel,
      attributes: [
        .font: UIFont.systemFont(ofSize: 14),
        .foregroundColor: textColor,
        .paragraphStyle: paragraph,
      ]
    )
    accessibilityLabel = copied ? copiedLabel : copyLabel
    invalidateIntrinsicContentSize()
    setNeedsLayout()
    superview?.setNeedsLayout()
  }

  private func textSize(_ value: String) -> CGSize {
    (value as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
  }
}

private final class NativeMermaidPreviewViewController: UIViewController, UIScrollViewDelegate {
  private let source: String
  private let theme: DiagramTheme
  private let background: UIColor
  private let border: UIColor
  private let text: UIColor
  private let header = UIView()
  private let titleLabel = UILabel()
  private let closeButton = UIButton(type: .system)
  private let scrollView = UIScrollView()
  private let diagram = MermaidView(frame: .zero)
  private var lastViewportSize = CGSize.zero

  init(source: String, theme: DiagramTheme, appearance: [String: String]) {
    self.source = source
    self.theme = theme
    background = UIColor(markdownHex: appearance["surface"]) ?? .systemBackground
    border = UIColor(markdownHex: appearance["border"]) ?? .separator
    text = UIColor(markdownHex: appearance["text"]) ?? .label
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    modalTransitionStyle = .coverVertical
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var preferredStatusBarStyle: UIStatusBarStyle {
    background.isDark ? .lightContent : .darkContent
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = background
    view.accessibilityViewIsModal = true

    header.backgroundColor = background
    view.addSubview(header)

    titleLabel.text = "Mermaid"
    titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
    titleLabel.textColor = text
    header.addSubview(titleLabel)

    closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
    closeButton.tintColor = text
    closeButton.accessibilityLabel = "Close"
    closeButton.addTarget(self, action: #selector(closePreview), for: .touchUpInside)
    header.addSubview(closeButton)

    let separator = UIView()
    separator.backgroundColor = border
    separator.tag = 1001
    header.addSubview(separator)

    scrollView.backgroundColor = background
    scrollView.delegate = self
    scrollView.minimumZoomScale = 1
    scrollView.maximumZoomScale = 4
    scrollView.bouncesZoom = true
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.showsVerticalScrollIndicator = false
    scrollView.decelerationRate = .fast
    view.addSubview(scrollView)

    diagram.theme = theme
    diagram.source = source
    scrollView.addSubview(diagram)

    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
    doubleTap.numberOfTapsRequired = 2
    scrollView.addGestureRecognizer(doubleTap)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let safe = view.safeAreaInsets
    let headerHeight: CGFloat = 56
    header.frame = CGRect(x: 0, y: safe.top, width: view.bounds.width, height: headerHeight)
    titleLabel.frame = CGRect(x: 20, y: 0, width: max(1, view.bounds.width - 92), height: headerHeight)
    closeButton.frame = CGRect(x: view.bounds.width - 52, y: 6, width: 44, height: 44)
    header.viewWithTag(1001)?.frame = CGRect(
      x: 0,
      y: headerHeight - 1 / UIScreen.main.scale,
      width: header.bounds.width,
      height: 1 / UIScreen.main.scale
    )

    scrollView.frame = CGRect(
      x: 0,
      y: header.frame.maxY,
      width: view.bounds.width,
      height: max(1, view.bounds.height - header.frame.maxY - safe.bottom)
    )
    let viewport = CGSize(width: max(1, scrollView.bounds.width - 40), height: max(1, scrollView.bounds.height - 40))
    guard viewport != lastViewportSize else { return }
    lastViewportSize = viewport
    scrollView.zoomScale = 1
    diagram.frame = CGRect(origin: .zero, size: viewport)
    scrollView.contentSize = viewport
    centerDiagram()
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? {
    diagram
  }

  func scrollViewDidZoom(_ scrollView: UIScrollView) {
    centerDiagram()
  }

  @objc private func closePreview() {
    dismiss(animated: true)
  }

  @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
    let target: CGFloat = scrollView.zoomScale > 1.01 ? 1 : 2
    scrollView.setZoomScale(target, animated: true)
  }

  private func centerDiagram() {
    let horizontal = max((scrollView.bounds.width - scrollView.contentSize.width) / 2, 0)
    let vertical = max((scrollView.bounds.height - scrollView.contentSize.height) / 2, 0)
    scrollView.contentInset = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
  }
}

private final class NativeMarkdownBlockView: UIView {
  private let source: String
  private let contentFrame: CGRect
  private let foreground: UIColor
  private let compact: Bool
  private let appearance: [String: String]
  private let streaming: Bool
  private var mermaidTheme: DiagramTheme?
  private var copyButton: NativeMarkdownCopyButton?
  private var languageLabel: UILabel?

  init(payload: NSDictionary, rendersMermaid: Bool) {
    source = payload["source"] as? String ?? ""
    let width = (payload["width"] as? NSNumber)?.doubleValue ?? 1
    let height = (payload["height"] as? NSNumber)?.doubleValue ?? 1
    appearance = payload["appearance"] as? [String: String] ?? [:]
    let labels = payload["labels"] as? [String: String] ?? [:]
    compact = (payload["compact"] as? NSNumber)?.boolValue ?? false
    streaming = (payload["streaming"] as? NSNumber)?.boolValue ?? false
    foreground = UIColor(markdownHex: appearance["codeForeground"]) ?? .label
    contentFrame = CGRect(x: 0, y: 39, width: width, height: max(1, height - 39))
    super.init(frame: CGRect(x: 0, y: 0, width: width, height: height))

    backgroundColor = UIColor(markdownHex: appearance["codeBackground"]) ?? .secondarySystemBackground
    layer.borderColor = (UIColor(markdownHex: appearance["border"]) ?? .separator).cgColor
    layer.borderWidth = 1 / UIScreen.main.scale
    layer.cornerRadius = 7
    clipsToBounds = true
    addToolbar(
      language: rendersMermaid ? "Mermaid" : ((payload["language"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? labels["plainText"] ?? "Plain text"),
      appearance: appearance,
      labels: labels
    )
    if rendersMermaid {
      if streaming {
        addMermaidPlaceholder(appearance: appearance)
      } else {
        addMermaidView(appearance: appearance)
      }
    } else {
      addCodeView(language: payload["language"] as? String)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let copyButton, let languageLabel else { return }
    let copySize = copyButton.intrinsicContentSize
    copyButton.frame = CGRect(
      x: bounds.width - 12 - copySize.width,
      y: (39 - copySize.height) / 2,
      width: copySize.width,
      height: copySize.height
    )
    languageLabel.frame = CGRect(
      x: 14,
      y: 0,
      width: max(1, copyButton.frame.minX - 28),
      height: 39
    )
  }

  private func addToolbar(language: String, appearance: [String: String], labels: [String: String]) {
    let border = UIColor(markdownHex: appearance["border"]) ?? .separator
    let muted = UIColor(markdownHex: appearance["muted"]) ?? .secondaryLabel
    let pressed = UIColor(markdownHex: appearance["surfaceHover"]) ?? .secondarySystemBackground
    let toolbarHeight: CGFloat = 39
    let separator = UIView(frame: CGRect(x: 0, y: toolbarHeight - 1 / UIScreen.main.scale, width: bounds.width, height: 1 / UIScreen.main.scale))
    separator.backgroundColor = border
    separator.autoresizingMask = [.flexibleWidth]
    addSubview(separator)

    let copyButton = NativeMarkdownCopyButton(source: source, labels: labels, textColor: muted, pressedColor: pressed)
    addSubview(copyButton)
    self.copyButton = copyButton

    let label = UILabel(frame: .zero)
    label.font = UIFont.systemFont(ofSize: 14)
    label.textColor = muted
    label.text = language
    label.numberOfLines = 1
    label.lineBreakMode = .byTruncatingTail
    addSubview(label)
    languageLabel = label
    layoutSubviews()
  }

  private func addCodeView(language: String?) {
    let scrollView = UIScrollView(frame: contentFrame)
    scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    scrollView.alwaysBounceHorizontal = false
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.showsVerticalScrollIndicator = false

    let code = highlightedCode(language: language)
    let measured = code.boundingRect(
      with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
      options: [.usesFontLeading, .usesLineFragmentOrigin],
      context: nil
    ).size
    let contentWidth = max(contentFrame.width - 28, ceil(measured.width))
    let codeView = UITextView(frame: CGRect(x: 14, y: 12, width: contentWidth, height: max(1, contentFrame.height - 24)))
    codeView.attributedText = code
    codeView.backgroundColor = UIColor.clear
    codeView.isEditable = false
    codeView.isScrollEnabled = false
    codeView.isSelectable = true
    codeView.textContainerInset = UIEdgeInsets.zero
    codeView.textContainer.lineFragmentPadding = 0
    scrollView.contentSize = CGSize(width: contentWidth + 28, height: contentFrame.height)
    scrollView.addSubview(codeView)
    addSubview(scrollView)
  }

  private func highlightedCode(language: String?) -> NSAttributedString {
    let baseSize: CGFloat = compact ? 13 : 15
    let baseLineHeight: CGFloat = compact ? 20 : 25
    let baseFont = UIFont(name: "Menlo", size: baseSize) ?? UIFont.monospacedSystemFont(ofSize: baseSize, weight: .regular)
    let font = UIFontMetrics.default.scaledFont(for: baseFont)
    guard let highlighter = Highlighter() else {
      return NSAttributedString(string: source, attributes: [.font: font, .foregroundColor: foreground])
    }
    let isDark = backgroundColor?.resolvedColor(with: traitCollection).isDark ?? false
    _ = highlighter.setTheme(isDark ? "github-dark" : "github", withFont: font.fontName, ofSize: font.pointSize)
    highlighter.theme.lineSpacing = max(0, baseLineHeight * font.pointSize / baseSize - font.lineHeight)
    let normalized = normalizedHighlightLanguage(language)
    return highlighter.highlight(source, as: normalized) ?? NSAttributedString(
      string: source,
      attributes: [.font: font, .foregroundColor: foreground]
    )
  }

  private func addMermaidView(appearance: [String: String]) {
    let diagram = MermaidView(frame: contentFrame.insetBy(dx: 10, dy: 10))
    diagram.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    let theme = mermaidTheme ?? makeMermaidTheme(appearance)
    mermaidTheme = theme
    diagram.theme = theme
    diagram.source = source
    guard diagram.parseError == nil else {
      addCodeView(language: nil)
      return
    }
    diagram.isUserInteractionEnabled = true
    diagram.isAccessibilityElement = true
    diagram.accessibilityLabel = "Mermaid diagram"
    diagram.accessibilityHint = "Opens an enlarged preview"
    diagram.accessibilityTraits = .button
    diagram.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(showMermaidPreview)))
    addSubview(diagram)
  }

  private func addMermaidPlaceholder(appearance: [String: String]) {
    let muted = UIColor(markdownHex: appearance["muted"]) ?? .secondaryLabel
    let placeholder = UIView(frame: contentFrame.insetBy(dx: 10, dy: 10))
    placeholder.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    placeholder.isUserInteractionEnabled = false

    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.color = muted
    spinner.startAnimating()

    let label = UILabel()
    label.font = .systemFont(ofSize: 14)
    label.textColor = muted
    label.text = "Mermaid"
    label.textAlignment = .center

    let stack = UIStackView(arrangedSubviews: [spinner, label])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 6
    stack.translatesAutoresizingMaskIntoConstraints = false
    placeholder.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: placeholder.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: placeholder.centerYAnchor),
    ])
    placeholder.accessibilityLabel = "Mermaid"
    addSubview(placeholder)
  }

  private func makeMermaidTheme(_ appearance: [String: String]) -> DiagramTheme {
    DiagramTheme(
      background: UIColor(markdownHex: appearance["surface"]) ?? .systemBackground,
      foreground: UIColor(markdownHex: appearance["text"]) ?? .label,
      line: UIColor(markdownHex: appearance["border"]) ?? .separator,
      accent: UIColor(markdownHex: appearance["link"]) ?? .link,
      muted: UIColor(markdownHex: appearance["muted"]) ?? .secondaryLabel
    )
  }

  @objc private func showMermaidPreview() {
    guard let root = window?.rootViewController,
          let theme = mermaidTheme else { return }
    var presenter = root
    while let presented = presenter.presentedViewController {
      presenter = presented
    }
    presenter.present(
      NativeMermaidPreviewViewController(source: source, theme: theme, appearance: appearance),
      animated: true
    )
  }
}

private final class NativeMarkdownRuleView: UIView {
  init(payload: NSDictionary) {
    let width = (payload["width"] as? NSNumber)?.doubleValue ?? 1
    let height = (payload["height"] as? NSNumber)?.doubleValue ?? 22
    let appearance = payload["appearance"] as? [String: String] ?? [:]
    super.init(frame: CGRect(x: 0, y: 0, width: width, height: height))
    let rule = UIView(frame: CGRect(x: 0, y: 6, width: width, height: 1 / UIScreen.main.scale))
    rule.backgroundColor = UIColor(markdownHex: appearance["border"]) ?? .separator
    rule.autoresizingMask = [.flexibleWidth]
    addSubview(rule)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

private final class NativeMarkdownTableView: UIView, UIScrollViewDelegate {
  private let cornerRadius: CGFloat = 9
  private let fadeWidth: CGFloat = 18
  private let leftFadeLayer = CAGradientLayer()
  private let leftFadeView = UIView()
  private let rightFadeLayer = CAGradientLayer()
  private let rightFadeView = UIView()
  private let scrollView: UIScrollView

  init(payload: NSDictionary) {
    let width = (payload["width"] as? NSNumber)?.doubleValue ?? 1
    let height = (payload["height"] as? NSNumber)?.doubleValue ?? 1
    let tableHeight = (payload["tableHeight"] as? NSNumber)?.doubleValue ?? height
    let rows = payload["rows"] as? [[String]] ?? []
    let rowHeights = (payload["rowHeights"] as? [NSNumber] ?? []).map(CGFloat.init(truncating:))
    let headerRowCount = (payload["headerRowCount"] as? NSNumber)?.intValue ?? 0
    let compact = (payload["compact"] as? NSNumber)?.boolValue ?? false
    let appearance = payload["appearance"] as? [String: String] ?? [:]
    let border = UIColor(markdownHex: appearance["tableBorder"]) ?? .separator
    let text = UIColor(markdownHex: appearance["tableText"]) ?? .label
    let background = UIColor(markdownHex: appearance["tableBackground"]) ?? .systemBackground
    let header = UIColor(markdownHex: appearance["tableHeaderBackground"]) ?? .systemBackground
    let stripe = UIColor(markdownHex: appearance["tableStripe"]) ?? .secondarySystemBackground
    let scrollView = UIScrollView(frame: CGRect(x: 0, y: 0, width: width, height: height))
    self.scrollView = scrollView
    super.init(frame: CGRect(x: 0, y: 0, width: width, height: height))

    backgroundColor = .clear

    let columnCount = rows.map(\.count).max() ?? 0
    let tableWidth = TaskHandoffMarkdownTableMetrics.totalWidth(columnCount: columnCount)
    let shadowInset = TaskHandoffMarkdownTableMetrics.shadowInset
    scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    scrollView.backgroundColor = .clear
    scrollView.delegate = self
    scrollView.clipsToBounds = true
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.contentSize = CGSize(width: tableWidth + shadowInset * 2, height: height)
    addSubview(scrollView)

    let tableContainer = UIView(frame: CGRect(x: shadowInset, y: shadowInset, width: tableWidth, height: tableHeight))
    tableContainer.backgroundColor = background
    tableContainer.layer.cornerRadius = cornerRadius
    tableContainer.layer.shadowColor = UIColor.black.cgColor
    tableContainer.layer.shadowOffset = TaskHandoffMarkdownTableMetrics.shadowOffset
    tableContainer.layer.shadowOpacity = TaskHandoffMarkdownTableMetrics.shadowOpacity
    tableContainer.layer.shadowRadius = TaskHandoffMarkdownTableMetrics.shadowRadius
    tableContainer.layer.shadowPath = UIBezierPath(roundedRect: tableContainer.bounds, cornerRadius: cornerRadius).cgPath
    scrollView.addSubview(tableContainer)

    let table = UIView(frame: tableContainer.bounds)
    table.backgroundColor = background
    table.layer.borderColor = border.cgColor
    table.layer.borderWidth = 1
    table.layer.cornerRadius = cornerRadius
    table.clipsToBounds = true
    tableContainer.addSubview(table)

    let baseSize: CGFloat = compact ? 13 : 16
    let baseLineHeight: CGFloat = compact ? 20 : 24
    let regularFont = UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: baseSize))
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byWordWrapping
    let lineHeight = baseLineHeight * regularFont.pointSize / baseSize
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    var y: CGFloat = 0
    for (rowIndex, row) in rows.enumerated() {
      let rowHeight = rowHeights.indices.contains(rowIndex) ? rowHeights[rowIndex] : (compact ? 38 : 42)
      let rowView = UIView(frame: CGRect(x: 0, y: y, width: tableWidth, height: rowHeight))
      rowView.backgroundColor = background
      if rowIndex < headerRowCount {
        let gradient = CAGradientLayer()
        gradient.frame = rowView.bounds
        gradient.colors = [header.cgColor, header.withAlphaComponent(0.78).cgColor]
        gradient.startPoint = CGPoint(x: 0.5, y: 0)
        gradient.endPoint = CGPoint(x: 0.5, y: 1)
        rowView.layer.insertSublayer(gradient, at: 0)
      } else if (rowIndex - headerRowCount) % 2 == 1 {
        rowView.backgroundColor = stripe
      }
      table.addSubview(rowView)

      var x: CGFloat = 0
      for column in 0..<columnCount {
        let columnWidth = TaskHandoffMarkdownTableMetrics.width(forColumn: column)
        let cell = UITextView(frame: CGRect(x: x, y: 0, width: columnWidth, height: rowHeight))
        cell.backgroundColor = .clear
        let cellFont = rowIndex < headerRowCount
          ? UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: baseSize, weight: .bold))
          : regularFont
        cell.attributedText = NSAttributedString(
          string: row.indices.contains(column) ? row[column] : "",
          attributes: [
            .font: cellFont,
            .foregroundColor: text,
            .paragraphStyle: paragraph,
          ]
        )
        cell.isEditable = false
        cell.isScrollEnabled = false
        cell.isSelectable = true
        cell.textContainerInset = UIEdgeInsets(
          top: TaskHandoffMarkdownTableMetrics.verticalInset,
          left: TaskHandoffMarkdownTableMetrics.horizontalInset,
          bottom: TaskHandoffMarkdownTableMetrics.verticalInset,
          right: TaskHandoffMarkdownTableMetrics.horizontalInset
        )
        cell.textContainer.widthTracksTextView = true
        cell.textContainer.lineBreakMode = .byWordWrapping
        cell.textContainer.maximumNumberOfLines = 0
        cell.textContainer.lineFragmentPadding = 0
        rowView.addSubview(cell)
        x += columnWidth
        if column < columnCount - 1 {
          addSeparator(to: rowView, frame: CGRect(x: x, y: 0, width: 1, height: rowHeight), color: border)
        }
      }
      if rowIndex < rows.count - 1 {
        addSeparator(to: rowView, frame: CGRect(x: 0, y: rowHeight - 1, width: tableWidth, height: 1), color: border)
      }
      y += rowHeight
    }

    let configuredFadeColor = UIColor(markdownHex: appearance["background"]) ?? background
    let fadeColor = configuredFadeColor.cgColor.alpha > 0 ? configuredFadeColor : background
    leftFadeLayer.colors = [fadeColor.cgColor, fadeColor.withAlphaComponent(0).cgColor]
    leftFadeLayer.startPoint = CGPoint(x: 0, y: 0.5)
    leftFadeLayer.endPoint = CGPoint(x: 1, y: 0.5)
    leftFadeView.isUserInteractionEnabled = false
    leftFadeView.layer.addSublayer(leftFadeLayer)
    leftFadeView.isHidden = true
    addSubview(leftFadeView)
    rightFadeLayer.colors = [fadeColor.withAlphaComponent(0).cgColor, fadeColor.cgColor]
    rightFadeLayer.startPoint = CGPoint(x: 0, y: 0.5)
    rightFadeLayer.endPoint = CGPoint(x: 1, y: 0.5)
    rightFadeView.isUserInteractionEnabled = false
    rightFadeView.layer.addSublayer(rightFadeLayer)
    rightFadeView.isHidden = true
    addSubview(rightFadeView)
    updateEdgeFades()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    leftFadeView.frame = CGRect(x: 0, y: 0, width: fadeWidth, height: bounds.height)
    leftFadeLayer.frame = leftFadeView.bounds
    rightFadeView.frame = CGRect(x: max(0, bounds.width - fadeWidth), y: 0, width: fadeWidth, height: bounds.height)
    rightFadeLayer.frame = rightFadeView.bounds
    updateEdgeFades()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    updateEdgeFades()
  }

  private func updateEdgeFades() {
    let maxOffset = max(0, scrollView.contentSize.width - scrollView.bounds.width)
    leftFadeView.isHidden = maxOffset <= 0.5 || scrollView.contentOffset.x <= 0.5
    rightFadeView.isHidden = maxOffset <= 0.5 || scrollView.contentOffset.x >= maxOffset - 0.5
  }

  private func addSeparator(to parent: UIView, frame: CGRect, color: UIColor) {
    let separator = UIView(frame: frame)
    separator.backgroundColor = color
    parent.addSubview(separator)
  }
}

private func normalizedHighlightLanguage(_ rawLanguage: String?) -> String? {
  switch rawLanguage?.lowercased() {
  case "c++", "hpp": return "cpp"
  case "golang": return "go"
  case "js", "jsx": return "javascript"
  case "jsonc": return "json"
  case "py": return "python"
  case "rs": return "rust"
  case "shell", "sh", "zsh": return "bash"
  case "ts", "tsx": return "typescript"
  case "yml": return "yaml"
  case let language?: return language.isEmpty ? nil : language
  case nil: return nil
  }
}

private extension UIColor {
  var isDark: Bool {
    var white: CGFloat = 0
    guard getWhite(&white, alpha: nil) else { return false }
    return white < 0.5
  }

  convenience init?(markdownHex value: String?) {
    guard let value else { return nil }
    let raw = value.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
    guard raw.count == 6 || raw.count == 8, let number = UInt64(raw, radix: 16) else { return nil }
    let hasAlpha = raw.count == 8
    self.init(
      red: CGFloat((number >> (hasAlpha ? 24 : 16)) & 0xff) / 255,
      green: CGFloat((number >> (hasAlpha ? 16 : 8)) & 0xff) / 255,
      blue: CGFloat((number >> (hasAlpha ? 8 : 0)) & 0xff) / 255,
      alpha: hasAlpha ? CGFloat(number & 0xff) / 255 : 1
    )
  }
}
