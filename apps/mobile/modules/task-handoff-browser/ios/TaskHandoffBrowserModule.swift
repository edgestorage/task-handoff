import ExpoModulesCore
import WebKit
import OSLog

private let browserModuleLogger = Logger(subsystem: "com.taskhandoff.mobile.dev", category: "task-handoff-browser")

public final class TaskHandoffBrowserModule: Module {
  private let relaySocketQueue = DispatchQueue(label: "com.taskhandoff.mobile.relay-socket", qos: .userInitiated)
  private let relaySocketsLock = NSLock()
  private var relaySockets: [String: NativeRelaySocket] = [:]

  private func relaySocket(_ id: String) -> NativeRelaySocket? {
    relaySocketsLock.lock()
    defer { relaySocketsLock.unlock() }
    return relaySockets[id]
  }

  private func storeRelaySocket(_ socket: NativeRelaySocket) {
    relaySocketsLock.lock()
    relaySockets[socket.id] = socket
    relaySocketsLock.unlock()
  }

  private func removeRelaySocket(_ id: String) {
    relaySocketsLock.lock()
    relaySockets.removeValue(forKey: id)
    relaySocketsLock.unlock()
  }

  private func takeRelaySockets() -> [NativeRelaySocket] {
    relaySocketsLock.lock()
    let sockets = Array(relaySockets.values)
    relaySockets.removeAll()
    relaySocketsLock.unlock()
    return sockets
  }

  public func definition() -> ModuleDefinition {
    Name("TaskHandoffBrowser")

    Events("onRelaySocketOpen", "onRelaySocketMessage", "onRelaySocketError", "onRelaySocketClose", "onBrowserTransportMessage", "onBrowserTransportClose", "onBrowserDiagnostic")

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
        onFinish: { [weak self] socketId in self?.removeRelaySocket(socketId) }
      )
      storeRelaySocket(socket)
      return id
    }.runOnQueue(relaySocketQueue)

    AsyncFunction("startRelaySocket") { (id: String) in
      guard let socket = self.relaySocket(id) else { throw RelaySocketUnavailableException() }
      socket.start()
    }.runOnQueue(relaySocketQueue)

    AsyncFunction("sendRelaySocketText") { (id: String, value: String) in
      guard let socket = self.relaySocket(id) else { throw RelaySocketUnavailableException() }
      socket.sendText(value)
    }.runOnQueue(relaySocketQueue)

    AsyncFunction("sendRelaySocketBinary") { (id: String, value: ArrayBuffer) in
      guard let socket = self.relaySocket(id) else { throw RelaySocketUnavailableException() }
      socket.sendBinary(value.data)
    }.runOnQueue(relaySocketQueue)

    AsyncFunction("closeRelaySocket") { (id: String, code: Int?, reason: String?) in
      guard let socket = self.relaySocket(id) else { return }
      socket.close(code: code ?? 1000, reason: reason ?? "")
    }.runOnQueue(relaySocketQueue)

    AsyncFunction("createBrowserTransport") { () -> String in
      await BrowserTransportRegistry.shared.create { [weak self] event, body in
        DispatchQueue.main.async { self?.sendEvent(event, body) }
      }
    }
    AsyncFunction("receiveBrowserTransportMessage") { (id: String, value: ArrayBuffer, binary: Bool) in
      let transport = try await BrowserTransportRegistry.shared.require(id)
      try await transport.deliver(value.data, binary: binary)
    }
    AsyncFunction("acknowledgeBrowserTransportSend") { (id: String, sequence: Int, error: String?) in
      let transport = try? await BrowserTransportRegistry.shared.require(id)
      await transport?.acknowledge(sequence, error: error)
    }
    AsyncFunction("closeBrowserTransport") { (id: String) in
      await BrowserTransportRegistry.shared.close(id)
    }

    OnDestroy {
      Task { await BrowserTransportRegistry.shared.closeAll(); await MobileBrowserContextManager.shared.releaseAll() }
      for socket in self.takeRelaySockets() { socket.close(code: 1001, reason: "module-destroyed") }
    }

    AsyncFunction("prepareBrowserContext") { (input: PrepareBrowserContextRecord) -> [String: String] in
      guard #available(iOS 17.0, *) else { throw BrowserPlatformUnsupportedException() }
      NSLog("[task-handoff-browser] prepareBrowserContext instance=%@", input.instanceId)
      let controlPlaneId = input.controlPlaneId
      let instanceId = input.instanceId
      let startedAt = DispatchTime.now().uptimeNanoseconds
      let diagnostic: @Sendable (String) -> Void = { [weak self] stage in
        let elapsedMs = (DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
        DispatchQueue.main.async {
          self?.sendEvent("onBrowserDiagnostic", ["controlPlaneId": controlPlaneId, "instanceId": instanceId, "stage": stage, "elapsedMs": elapsedMs])
        }
      }
      diagnostic("context.prepare.start")
      let contextId: String
      do {
        contextId = try await MobileBrowserContextManager.shared.prepare(input, diagnostic: diagnostic, onClosed: { [weak self] id, source, error in
          var event: [String: Any] = ["controlPlaneId": controlPlaneId, "instanceId": instanceId, "contextId": id,
            "stage": "tunnel.closed", "closeSource": source, "elapsedMs": (DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000]
          if let error {
            let failure = error as NSError
            event["errorDomain"] = failure.domain
            event["errorCode"] = failure.code
          }
          self?.sendEvent("onBrowserDiagnostic", event)
        })
      } catch {
        let failure = error as NSError
        let elapsedMs = (DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
        // Codes only: localizedDescription may contain URLs or peer data.
        self.sendEvent("onBrowserDiagnostic", ["controlPlaneId": controlPlaneId, "instanceId": instanceId, "stage": "context.prepare.failed", "elapsedMs": elapsedMs, "errorDomain": failure.domain, "errorCode": failure.code])
        throw error
      }
      diagnostic("context.prepare.ready")
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
  @Field var relayUrl: String = ""
  @Field var token: String = ""
  @Field var transportId: String = ""
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
