import ExpoModulesCore
import WebKit
import OSLog

private let browserModuleLogger = Logger(subsystem: "com.taskhandoff.mobile.dev", category: "task-handoff-browser")

public final class TaskHandoffBrowserModule: Module {
  private var relaySockets: [String: NativeRelaySocket] = [:]

  public func definition() -> ModuleDefinition {
    Name("TaskHandoffBrowser")

    Events("onRelaySocketOpen", "onRelaySocketMessage", "onRelaySocketError", "onRelaySocketClose")

    AsyncFunction("browserCapabilities") { () -> [String: Any] in
      if #available(iOS 17.0, *) {
        return [
          "supported": true,
          "platform": "ios",
          "proxyOverride": true,
          "isolatedProfile": true,
        ]
      }
      return [
        "supported": false,
        "platform": "ios",
        "proxyOverride": false,
        "isolatedProfile": false,
        "reason": "IOS_17_REQUIRED",
      ]
    }

    AsyncFunction("browserDiagnostics") {
      await MobileBrowserContextManager.shared.diagnostics()
    }

    AsyncFunction("createRelaySocket") { (url: String) -> String in
      guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(), scheme == "wss" || scheme == "ws" else {
        throw InvalidRelaySocketURLException()
      }
      let id = UUID().uuidString
      let socket = NativeRelaySocket(
        id: id,
        url: parsed,
        emit: { [weak self] event, body in DispatchQueue.main.async { self?.sendEvent(event, body) } },
        onFinish: { [weak self] socketId in DispatchQueue.main.async { self?.relaySockets.removeValue(forKey: socketId) } }
      )
      relaySockets[id] = socket
      return id
    }.runOnQueue(.main)

    AsyncFunction("startRelaySocket") { (id: String) in
      guard let socket = self.relaySockets[id] else { throw RelaySocketUnavailableException() }
      socket.start()
    }.runOnQueue(.main)

    AsyncFunction("sendRelaySocketText") { (id: String, value: String) in
      guard let socket = self.relaySockets[id] else { throw RelaySocketUnavailableException() }
      socket.sendText(value)
    }.runOnQueue(.main)

    AsyncFunction("sendRelaySocketBinary") { (id: String, value: String) in
      guard let socket = self.relaySockets[id], let data = Data(base64Encoded: value) else { throw RelaySocketUnavailableException() }
      socket.sendBinary(data)
    }.runOnQueue(.main)

    AsyncFunction("closeRelaySocket") { (id: String, code: Int?, reason: String?) in
      guard let socket = self.relaySockets[id] else { return }
      socket.close(code: code ?? 1000, reason: reason ?? "")
    }.runOnQueue(.main)

    OnDestroy {
      for socket in self.relaySockets.values { socket.close(code: 1001, reason: "module-destroyed") }
      self.relaySockets.removeAll()
    }

    AsyncFunction("prepareBrowserContext") { (input: PrepareBrowserContextRecord) -> [String: String] in
      guard #available(iOS 17.0, *) else { throw BrowserPlatformUnsupportedException() }
      NSLog("[task-handoff-browser] prepareBrowserContext instance=%@", input.instanceId)
      let contextId = try await MobileBrowserContextManager.shared.prepare(input)
      NSLog("[task-handoff-browser] prepareBrowserContext ready context=%@", contextId)
      return ["contextId": contextId]
    }

    AsyncFunction("activateBrowserContext") { (contextId: String) in
      guard #available(iOS 17.0, *) else { throw BrowserPlatformUnsupportedException() }
      NSLog("[task-handoff-browser] activateBrowserContext context=%@", contextId)
      try await MobileBrowserContextManager.shared.activate(contextId: contextId)
    }

    AsyncFunction("releaseBrowserContext") { (contextId: String) in
      await MobileBrowserContextManager.shared.release(contextId: contextId)
    }

    AsyncFunction("releaseAllBrowserContexts") {
      await MobileBrowserContextManager.shared.releaseAll()
    }

    View(TaskHandoffBrowserView.self) {
      Events("onNavigationStateChange", "onLoadingChange", "onError", "onNewWindow")

      Prop("contextId") { (view: TaskHandoffBrowserView, contextId: String) in
        NSLog("[task-handoff-browser] contextId prop context=%@", contextId)
        view.setContextId(contextId)
      }
      Prop("initialUrl") { (view: TaskHandoffBrowserView, initialUrl: String?) in
        view.setInitialUrl(initialUrl ?? "about:blank")
      }

      AsyncFunction("loadUrl") { (view: TaskHandoffBrowserView, url: String) in try view.load(url) }.runOnQueue(.main)
      AsyncFunction("goBack") { (view: TaskHandoffBrowserView) in view.goBack() }.runOnQueue(.main)
      AsyncFunction("goForward") { (view: TaskHandoffBrowserView) in view.goForward() }.runOnQueue(.main)
      AsyncFunction("reload") { (view: TaskHandoffBrowserView) in view.reload() }.runOnQueue(.main)
      AsyncFunction("stopLoading") { (view: TaskHandoffBrowserView) in view.stopLoading() }.runOnQueue(.main)

    }
  }
}

internal struct PrepareBrowserContextRecord: Record {
  @Field var controlPlaneId: String
  @Field var instanceId: String
  @Field var relayUrl: String
  @Field var token: String
}

internal final class BrowserPlatformUnsupportedException: Exception {
  override var reason: String { "Browser requires iOS 17 or newer." }
}

internal final class BrowserContextUnavailableException: Exception {
  override var reason: String { "Browser context is unavailable." }
}

internal final class InvalidRelaySocketURLException: Exception {
  override var reason: String { "Relay WebSocket URL is invalid." }
}

internal final class RelaySocketUnavailableException: Exception {
  override var reason: String { "Relay WebSocket is unavailable." }
}
