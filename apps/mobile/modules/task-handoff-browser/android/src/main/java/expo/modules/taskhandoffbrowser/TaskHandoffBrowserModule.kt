package expo.modules.taskhandoffbrowser

import androidx.webkit.WebViewFeature
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.launch

class TaskHandoffBrowserModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TaskHandoffBrowser")

    AsyncFunction("browserCapabilities") {
      val proxyOverride = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)
      val isolatedProfile = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
      val supported = proxyOverride && isolatedProfile
      mutableMapOf<String, Any>(
        "supported" to supported,
        "platform" to "android",
        "proxyOverride" to proxyOverride,
        "isolatedProfile" to isolatedProfile,
      ).apply { if (!supported) put("reason", capabilityReason(proxyOverride, isolatedProfile)) }
    }

    AsyncFunction("browserDiagnostics") { promise: Promise ->
      appContext.modulesQueue.launch { promise.resolve(MobileBrowserContextManager.diagnostics()) }
    }

    AsyncFunction("prepareBrowserContext") { input: PrepareBrowserContextRecord, promise: Promise ->
      appContext.modulesQueue.launch {
        runCatching { MobileBrowserContextManager.prepare(input) }
          .onSuccess { promise.resolve(mapOf("contextId" to it)) }
          .onFailure { promise.reject("BROWSER_CONTEXT_PREPARE_FAILED", it.message, it) }
      }
    }

    AsyncFunction("releaseBrowserContext") { contextId: String, promise: Promise ->
      appContext.modulesQueue.launch {
        runCatching { MobileBrowserContextManager.release(contextId) }
          .onSuccess { promise.resolve(null) }
          .onFailure { promise.reject("BROWSER_CONTEXT_RELEASE_FAILED", it.message, it) }
      }
    }

    AsyncFunction("releaseAllBrowserContexts") { promise: Promise ->
      appContext.modulesQueue.launch {
        runCatching { MobileBrowserContextManager.releaseAll() }
          .onSuccess { promise.resolve(null) }
          .onFailure { promise.reject("BROWSER_CONTEXT_RELEASE_FAILED", it.message, it) }
      }
    }

    View(TaskHandoffBrowserView::class) {
      Events("onNavigationStateChange", "onLoadingChange", "onError", "onNewWindow")

      Prop("contextId") { view: TaskHandoffBrowserView, contextId: String -> view.setContextId(contextId) }
      Prop("initialUrl") { view: TaskHandoffBrowserView, initialUrl: String? -> view.setInitialUrl(initialUrl ?: "about:blank") }

      AsyncFunction("loadUrl") { view: TaskHandoffBrowserView, url: String -> view.loadUrlChecked(url) }
      AsyncFunction("goBack") { view: TaskHandoffBrowserView -> view.goBack() }
      AsyncFunction("goForward") { view: TaskHandoffBrowserView -> view.goForward() }
      AsyncFunction("reload") { view: TaskHandoffBrowserView -> view.reload() }
      AsyncFunction("stopLoading") { view: TaskHandoffBrowserView -> view.stopLoading() }

      OnViewDestroys { view: TaskHandoffBrowserView -> view.destroy() }
    }
  }

  private fun capabilityReason(proxyOverride: Boolean, isolatedProfile: Boolean) = when {
    !proxyOverride -> "ANDROID_PROXY_OVERRIDE_UNAVAILABLE"
    !isolatedProfile -> "ANDROID_ISOLATED_PROFILE_UNAVAILABLE"
    else -> "ANDROID_BROWSER_UNAVAILABLE"
  }
}

internal class PrepareBrowserContextRecord : Record {
  @Field val controlPlaneId: String = ""
  @Field val instanceId: String = ""
  @Field val relayUrl: String = ""
  @Field val token: String = ""
}

internal class BrowserPlatformUnsupportedException(reason: String) : CodedException(reason)
internal class BrowserContextUnavailableException : CodedException("Browser context is unavailable.")
internal class BrowserNavigationRejectedException : CodedException("Only about:blank, HTTP, and HTTPS navigation is allowed.")
