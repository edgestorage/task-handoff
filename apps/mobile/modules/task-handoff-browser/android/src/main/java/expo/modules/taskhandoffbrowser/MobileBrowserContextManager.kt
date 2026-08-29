package expo.modules.taskhandoffbrowser

import androidx.webkit.ProfileStore
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.net.URI
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume

internal object MobileBrowserContextManager {
  private data class Context(
    val id: String,
    val key: String,
    val profileName: String,
    val socksPort: Int,
    val channel: BrowserTunnelChannel,
    val socks: BrowserSocksServer,
    var references: Int,
  )

  private val mutex = Mutex()
  private val contextsById = mutableMapOf<String, Context>()
  private val contextIdByKey = mutableMapOf<String, String>()
  private var preparedContexts = 0
  private var releasedContexts = 0

  suspend fun prepare(input: PrepareBrowserContextRecord): String = mutex.withLock {
    requireCapabilities()
    val relay = runCatching { URI(input.relayUrl) }.getOrNull()
    if (input.controlPlaneId.isBlank() || input.instanceId.isBlank() || input.token.isBlank() || relay?.scheme !in setOf("ws", "wss")) {
      throw BrowserContextUnavailableException()
    }
    val key = "${input.controlPlaneId}\u0000${input.instanceId}"
    contextIdByKey[key]?.let { id ->
      contextsById[id]?.let { context ->
        context.references += 1
        return id
      }
    }
    if (contextsById.isNotEmpty()) {
      throw BrowserPlatformUnsupportedException("Close the active instance Browser context before switching instances.")
    }

    val channel = BrowserTunnelChannel(input.relayUrl, input.token)
    var socks: BrowserSocksServer? = null
    try {
      channel.connect()
      socks = BrowserSocksServer(channel)
      val port = socks.start()
      val profileName = deriveProfileName(key)
      withContext(Dispatchers.Main) { ProfileStore.getInstance().getOrCreateProfile(profileName) }
      setProxy(port)
      val id = UUID.randomUUID().toString()
      val context = Context(id, key, profileName, port, channel, socks, 1)
      contextsById[id] = context
      contextIdByKey[key] = id
      preparedContexts += 1
      id
    } catch (error: Throwable) {
      socks?.closeAndJoin()
      channel.closeAndJoin()
      throw error
    }
  }

  suspend fun profileName(contextId: String): String? = mutex.withLock { contextsById[contextId]?.profileName }

  data class DownloadContext(val profileName: String, val socksPort: Int)
  suspend fun downloadContext(contextId: String): DownloadContext? = mutex.withLock {
    contextsById[contextId]?.let { DownloadContext(it.profileName, it.socksPort) }
  }

  suspend fun release(contextId: String) = mutex.withLock {
    val context = contextsById[contextId] ?: return
    context.references -= 1
    if (context.references > 0) return
    contextsById.remove(contextId)
    contextIdByKey.remove(context.key)
    releasedContexts += 1
    clearProxy()
    context.socks.closeAndJoin()
    context.channel.closeAndJoin()
  }

  suspend fun releaseAll() = mutex.withLock {
    val active = contextsById.values.toList()
    contextsById.clear()
    contextIdByKey.clear()
    releasedContexts += active.size
    if (active.isNotEmpty()) clearProxy()
    for (context in active) {
      context.socks.closeAndJoin()
      context.channel.closeAndJoin()
    }
  }

  suspend fun diagnostics(): Map<String, Any?> = mutex.withLock { mapOf(
    "activeContexts" to contextsById.size,
    "preparedContexts" to preparedContexts,
    "releasedContexts" to releasedContexts,
  ) }

  private fun requireCapabilities() {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      throw BrowserPlatformUnsupportedException("Android WebView proxy override and isolated profile support are required.")
    }
  }

  private suspend fun setProxy(port: Int) = suspendCancellableCoroutine { continuation ->
    val config = ProxyConfig.Builder().addProxyRule("socks://127.0.0.1:$port").build()
    ProxyController.getInstance().setProxyOverride(config, Runnable::run) { if (continuation.isActive) continuation.resume(Unit) }
  }

  private suspend fun clearProxy() = suspendCancellableCoroutine { continuation ->
    ProxyController.getInstance().clearProxyOverride(Runnable::run) { if (continuation.isActive) continuation.resume(Unit) }
  }

  private fun deriveProfileName(key: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray())
    return "taskhandoff-${digest.take(16).joinToString("") { "%02x".format(it) }}"
  }
}
