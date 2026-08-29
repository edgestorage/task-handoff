import ExpoModulesCore
import WebKit

internal final class TaskHandoffBrowserView: ExpoView, WKDownloadDelegate, WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
  // On iOS 17 WebKit owns the system upload picker when WKUIDelegate does not
  // override runOpenPanel; the selected file is still uploaded by this WebView.
  let onNavigationStateChange = EventDispatcher()
  let onLoadingChange = EventDispatcher()
  let onError = EventDispatcher()
  let onNewWindow = EventDispatcher()

  private var contextId: String?
  private var initialUrl = "about:blank"
  private var webView: WKWebView?
  private var progressObservation: NSKeyValueObservation?
  private var downloadDestination: URL?

  deinit {
    cleanupDownload()
    progressObservation?.invalidate()
    webView?.navigationDelegate = nil
    webView?.uiDelegate = nil
    webView?.stopLoading()
  }

  func setContextId(_ value: String) {
    guard contextId != value else { return }
    contextId = value
    rebuild()
  }

  func setInitialUrl(_ value: String) {
    initialUrl = value
    if value != "about:blank", webView?.url?.absoluteString != value { try? load(value) }
  }

  func load(_ value: String) throws {
    guard let url = allowedNavigationURL(value), let webView else { throw BrowserNavigationRejectedException() }
    webView.load(URLRequest(url: url))
  }

  func goBack() { webView?.goBack() }
  func goForward() { webView?.goForward() }
  func reload() { webView?.reload() }
  func stopLoading() { webView?.stopLoading() }

  func destroy() {
    cleanupDownload()
    progressObservation?.invalidate()
    progressObservation = nil
    webView?.navigationDelegate = nil
    webView?.uiDelegate = nil
    webView?.stopLoading()
    webView?.removeFromSuperview()
    webView = nil
  }

  private func rebuild() {
    destroy()
    guard let contextId else { return }
    Task { @MainActor [weak self] in
      guard let self, self.contextId == contextId,
            let dataStore = await MobileBrowserContextManager.shared.dataStore(contextId: contextId) else { return }
      let configuration = WKWebViewConfiguration()
      configuration.websiteDataStore = dataStore
      configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
      let webView = WKWebView(frame: bounds, configuration: configuration)
      webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      webView.navigationDelegate = self
      webView.uiDelegate = self
      self.webView = webView
      addSubview(webView)
      progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
        self?.onLoadingChange(["loading": view.isLoading, "progress": view.estimatedProgress])
      }
      if initialUrl != "about:blank" { try? load(initialUrl) }
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard navigationAction.targetFrame?.isMainFrame != true || allowedNavigationURL(navigationAction.request.url?.absoluteString ?? "") != nil else {
      decisionHandler(.cancel)
      onError(["code": "NAVIGATION_SCHEME_REJECTED", "description": "This address scheme is not supported."])
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { emitNavigation(webView) }
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { emitNavigation(webView) }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { emitError(error) }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { emitError(error) }

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    cleanupDownload()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let filename = safeFilename(suggestedFilename)
      let destination = directory.appendingPathComponent(filename)
      downloadDestination = destination
      completionHandler(destination)
    } catch {
      emitError(error)
      completionHandler(nil)
    }
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let destination = downloadDestination else { return }
    let picker = UIDocumentPickerViewController(forExporting: [destination], asCopy: true)
    picker.delegate = self
    guard present(picker) else { cleanupDownload() ; return }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    emitError(error)
    cleanupDownload()
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    cleanupDownload()
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    cleanupDownload()
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let value = navigationAction.request.url?.absoluteString, allowedNavigationURL(value) != nil { onNewWindow(["url": value]) }
    return nil
  }

  private func emitNavigation(_ webView: WKWebView) {
    onNavigationStateChange([
      "url": webView.url?.absoluteString ?? "about:blank",
      "title": webView.title ?? "",
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward,
    ])
    onLoadingChange(["loading": webView.isLoading, "progress": webView.estimatedProgress])
  }

  private func emitError(_ error: Error) {
    let native = error as NSError
    onError(["code": "WEBVIEW_\(native.code)", "description": native.localizedDescription])
  }

  private func present(_ controller: UIViewController) -> Bool {
    var presenter = window?.rootViewController
    while let presented = presenter?.presentedViewController { presenter = presented }
    guard let presenter else { return false }
    presenter.present(controller, animated: true)
    return true
  }

  private func cleanupDownload() {
    guard let destination = downloadDestination else { return }
    downloadDestination = nil
    try? FileManager.default.removeItem(at: destination.deletingLastPathComponent())
  }
}

private func allowedNavigationURL(_ value: String) -> URL? {
  if value == "about:blank" { return URL(string: value) }
  guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased()), url.host != nil else { return nil }
  return url
}

internal final class BrowserNavigationRejectedException: Exception {
  override var reason: String { "Only about:blank, HTTP, and HTTPS navigation is allowed." }
}

private func safeFilename(_ value: String) -> String {
  let name = URL(fileURLWithPath: value).lastPathComponent
  return name.isEmpty || name == "." || name == ".." ? "download" : String(name.prefix(180))
}
