package expo.modules.taskhandoffbrowser

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Message
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.ProfileStore
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.ReactApplicationContext
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.util.UUID

@SuppressLint("SetJavaScriptEnabled")
class TaskHandoffBrowserView(context: android.content.Context, private val browserAppContext: AppContext) : ExpoView(context, browserAppContext) {
  private val onNavigationStateChange by EventDispatcher<Map<String, Any>>()
  private val onLoadingChange by EventDispatcher<Map<String, Any>>()
  private val onError by EventDispatcher<Map<String, Any>>()
  private val onNewWindow by EventDispatcher<Map<String, Any>>()

  private var contextId: String? = null
  private var initialUrl = "about:blank"
  private var webView: WebView? = null
  private var uploadCallback: android.webkit.ValueCallback<Array<Uri>>? = null
  private var pendingDownload: File? = null
  private val activityListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      when (requestCode) {
        UPLOAD_REQUEST -> {
          uploadCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
          uploadCallback = null
        }
        DOWNLOAD_REQUEST -> {
          val source = pendingDownload
          pendingDownload = null
          val destination = data?.data
          if (resultCode == Activity.RESULT_OK && source != null && destination != null) {
            browserAppContext.modulesQueue.launch {
              runCatching {
                withContext(Dispatchers.IO) {
                  context.contentResolver.openOutputStream(destination)?.use { output -> source.inputStream().use { it.copyTo(output) } }
                    ?: error("The selected download destination is unavailable.")
                }
              }.onFailure { reportError("DOWNLOAD_SAVE_FAILED", "The download could not be saved.") }
              source.delete()
            }
          } else source?.delete()
        }
      }
    }
  }

  init {
    (browserAppContext.reactContext as? ReactApplicationContext)?.addActivityEventListener(activityListener)
  }

  fun setContextId(value: String) {
    if (contextId == value) return
    contextId = value
    rebuild()
  }

  fun setInitialUrl(value: String) {
    initialUrl = value
    if (value != "about:blank" && webView?.url != value) loadUrlChecked(value)
  }

  fun loadUrlChecked(value: String) {
    if (!isAllowedNavigation(value)) throw BrowserNavigationRejectedException()
    webView?.loadUrl(value) ?: throw BrowserContextUnavailableException()
  }

  fun goBack() { webView?.goBack() }
  fun goForward() { webView?.goForward() }
  fun reload() { webView?.reload() }
  fun stopLoading() { webView?.stopLoading() }

  fun destroy() {
    clearWebView()
    uploadCallback?.onReceiveValue(null)
    uploadCallback = null
    pendingDownload?.delete()
    pendingDownload = null
    (browserAppContext.reactContext as? ReactApplicationContext)?.removeActivityEventListener(activityListener)
  }

  private fun clearWebView() {
    webView?.apply {
      stopLoading()
      webChromeClient = null
      webViewClient = WebViewClient()
      removeAllViews()
      destroy()
    }
    webView = null
    removeAllViews()
  }

  private fun rebuild() {
    clearWebView()
    val id = contextId ?: return
    browserAppContext.modulesQueue.launch {
      val profileName = MobileBrowserContextManager.profileName(id) ?: return@launch
      withContext(Dispatchers.Main) {
        if (contextId != id || webView != null) return@withContext
        val view = WebView(context)
        WebViewCompat.setProfile(view, profileName)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.setSupportMultipleWindows(true)
        view.webViewClient = BrowserClient()
        view.webChromeClient = BrowserChromeClient()
        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
          download(url, userAgent, contentDisposition, mimeType)
        }
        webView = view
        addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        if (initialUrl != "about:blank") loadUrlChecked(initialUrl)
      }
    }
  }

  private fun emitNavigation(view: WebView) {
    onNavigationStateChange(mapOf(
      "url" to (view.url ?: "about:blank"),
      "title" to (view.title ?: ""),
      "canGoBack" to view.canGoBack(),
      "canGoForward" to view.canGoForward()
    ))
  }

  private inner class BrowserClient : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      if (!request.isForMainFrame || isAllowedNavigation(request.url.toString())) return false
      onError(mapOf("code" to "NAVIGATION_SCHEME_REJECTED", "description" to "This address scheme is not supported."))
      return true
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      onLoadingChange(mapOf("loading" to true, "progress" to 0.0))
      emitNavigation(view)
    }

    override fun onPageFinished(view: WebView, url: String) {
      onLoadingChange(mapOf("loading" to false, "progress" to 1.0))
      emitNavigation(view)
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
      if (request.isForMainFrame) onError(mapOf("code" to "WEBVIEW_${error.errorCode}", "description" to error.description.toString()))
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
      handler.cancel()
      onError(mapOf("code" to "CERTIFICATE_ERROR", "description" to "The server certificate is invalid."))
    }
  }

  private inner class BrowserChromeClient : WebChromeClient() {
    override fun onProgressChanged(view: WebView, newProgress: Int) {
      onLoadingChange(mapOf("loading" to (newProgress < 100), "progress" to (newProgress / 100.0)))
    }

    override fun onPermissionRequest(request: PermissionRequest) { request.deny() }

    override fun onShowFileChooser(webView: WebView, filePathCallback: android.webkit.ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean {
      val activity = browserAppContext.currentActivity ?: return false
      uploadCallback?.onReceiveValue(null)
      uploadCallback = filePathCallback
      return try {
        activity.startActivityForResult(fileChooserParams.createIntent(), UPLOAD_REQUEST)
        true
      } catch (_: Throwable) {
        uploadCallback = null
        filePathCallback.onReceiveValue(null)
        false
      }
    }

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
      val url = view.hitTestResult?.extra
      if (url != null && isAllowedNavigation(url)) onNewWindow(mapOf("url" to url))
      return false
    }
  }

  private fun download(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
    val id = contextId ?: return
    if (!isAllowedNavigation(url) || pendingDownload != null) {
      reportError("DOWNLOAD_REJECTED", "The download could not be started.")
      return
    }
    browserAppContext.modulesQueue.launch {
      val browserContext = MobileBrowserContextManager.downloadContext(id)
      if (browserContext == null) { reportError("DOWNLOAD_CONTEXT_UNAVAILABLE", "The Browser context is unavailable."); return@launch }
      val cookie = withContext(Dispatchers.Main) {
        ProfileStore.getInstance().getProfile(browserContext.profileName)?.cookieManager?.getCookie(url)
      }
      val source = runCatching {
        withContext(Dispatchers.IO) {
          val client = OkHttpClient.Builder()
            .proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", browserContext.socksPort)))
            .retryOnConnectionFailure(false)
            .build()
          val request = Request.Builder().url(url).apply {
            if (!userAgent.isNullOrBlank()) header("User-Agent", userAgent)
            if (!cookie.isNullOrBlank()) header("Cookie", cookie)
          }.build()
          client.newCall(request).execute().use { response ->
            check(response.isSuccessful)
            val file = File(context.cacheDir, "browser-download-${UUID.randomUUID()}")
            response.body?.byteStream()?.use { input -> file.outputStream().use { output -> input.copyTo(output) } }
              ?: error("The download response was empty.")
            file
          }
        }
      }.getOrElse { reportError("DOWNLOAD_FAILED", "The download failed."); return@launch }
      withContext(Dispatchers.Main) {
        val activity = browserAppContext.currentActivity
        if (activity == null || pendingDownload != null) { source.delete(); reportError("DOWNLOAD_SAVE_UNAVAILABLE", "The download cannot be saved right now."); return@withContext }
        pendingDownload = source
        val filename = downloadFilename(url, contentDisposition)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = mimeType?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
          putExtra(Intent.EXTRA_TITLE, filename)
        }
        runCatching { activity.startActivityForResult(intent, DOWNLOAD_REQUEST) }.onFailure {
          pendingDownload = null
          source.delete()
          reportError("DOWNLOAD_SAVE_UNAVAILABLE", "The download cannot be saved right now.")
        }
      }
    }
  }

  private fun reportError(code: String, description: String) {
    onError(mapOf("code" to code, "description" to description))
  }

  private companion object {
    const val UPLOAD_REQUEST = 0x5441
    const val DOWNLOAD_REQUEST = 0x5442
  }
}

private fun isAllowedNavigation(value: String): Boolean {
  if (value == "about:blank") return true
  val uri = runCatching { Uri.parse(value) }.getOrNull() ?: return false
  return uri.scheme?.lowercase() in setOf("http", "https") && !uri.host.isNullOrBlank()
}

private fun downloadFilename(url: String, contentDisposition: String?): String {
  val dispositionName = Regex("filename\\*?=(?:UTF-8''|\")?([^\";]+)", RegexOption.IGNORE_CASE)
    .find(contentDisposition.orEmpty())?.groupValues?.getOrNull(1)?.let { Uri.decode(it) }
  val candidate = dispositionName ?: runCatching { URL(url).path.substringAfterLast('/') }.getOrNull()
  return candidate?.substringAfterLast('/')?.replace(Regex("[\\r\\n/\\\\]"), "_")?.take(180)?.takeIf { it.isNotBlank() } ?: "download"
}
