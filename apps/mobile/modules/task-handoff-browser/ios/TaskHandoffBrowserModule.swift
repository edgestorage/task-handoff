import ExpoModulesCore
import WebKit
import OSLog

private let browserModuleLogger = Logger(subsystem: "com.taskhandoff.mobile.dev", category: "task-handoff-browser")

public final class TaskHandoffBrowserModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TaskHandoffBrowser")

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
