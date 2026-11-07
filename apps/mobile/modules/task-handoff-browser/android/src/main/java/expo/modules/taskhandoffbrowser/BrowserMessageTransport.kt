package expo.modules.taskhandoffbrowser

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal data class BrowserTransportMessage(val bytes: ByteArray, val binary: Boolean)
internal interface BrowserMessageTransport {
  suspend fun connect()
  suspend fun send(message: BrowserTransportMessage)
  suspend fun receive(): BrowserTransportMessage
  suspend fun consumed()
  suspend fun close()
}

internal class BrowserWebSocketTransport(url: String, token: String) : BrowserMessageTransport {
  private val opened = CompletableDeferred<Unit>()
  private val incoming = Channel<BrowserTransportMessage>(128)
  private val client = OkHttpClient.Builder().retryOnConnectionFailure(false).build()
  private val socket = client.newWebSocket(Request.Builder().url(url).header("Authorization", "Browser $token").build(), object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) { opened.complete(Unit) }
    override fun onMessage(webSocket: WebSocket, text: String) { accept(BrowserTransportMessage(text.toByteArray(), false)) }
    override fun onMessage(webSocket: WebSocket, bytes: ByteString) { accept(BrowserTransportMessage(bytes.toByteArray(), true)) }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { opened.completeExceptionally(t); incoming.close(t) }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { incoming.close() }
  })
  private fun accept(message: BrowserTransportMessage) {
    if (message.bytes.size > 64 * 1024 + 9 || incoming.trySend(message).isFailure) socket.cancel()
  }
  override suspend fun connect() { opened.await() }
  override suspend fun send(message: BrowserTransportMessage) {
    check(socket.queueSize() + message.bytes.size <= 2L * 1024 * 1024)
    check(if (message.binary) socket.send(ByteString.of(*message.bytes)) else socket.send(String(message.bytes, Charsets.UTF_8)))
  }
  override suspend fun receive() = incoming.receive()
  override suspend fun consumed() {}
  override suspend fun close() {
    socket.cancel()
    incoming.cancel()
    opened.cancel()
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
  }
}

internal class BridgedBrowserTransport(val id: String, private val emit: (String, Map<String, Any>) -> Unit) : BrowserMessageTransport {
  private val mutex = Mutex()
  private val incoming = Channel<BrowserTransportMessage>(1)
  private val sends = mutableMapOf<Int, Pair<Int, CompletableDeferred<Unit>>>()
  private var consumption: CompletableDeferred<Unit>? = null
  private var queuedBytes = 0
  private var sequence = 0
  private var closed = false
  override suspend fun connect() { mutex.withLock { check(!closed) } }
  override suspend fun send(message: BrowserTransportMessage) {
    val (id, waiter) = mutex.withLock {
      check(!closed && message.bytes.isNotEmpty() && message.bytes.size <= 64 * 1024 + 9 && queuedBytes + message.bytes.size <= 2 * 1024 * 1024)
      val waiter = CompletableDeferred<Unit>()
      val id = ++sequence
      queuedBytes += message.bytes.size
      sends[id] = Pair(message.bytes.size, waiter)
      Pair(id, waiter)
    }
    emit("onBrowserTransportMessage", mapOf("id" to this.id, "sequence" to id, "binary" to message.binary, "data" to message.bytes))
    waiter.await()
  }
  suspend fun acknowledge(sequence: Int, error: String?) {
    val waiter = mutex.withLock { sends.remove(sequence)?.also { queuedBytes -= it.first }?.second } ?: return
    if (error == null) waiter.complete(Unit) else waiter.completeExceptionally(IllegalStateException(error))
  }
  suspend fun deliver(message: BrowserTransportMessage) {
    val waiter = mutex.withLock {
      check(!closed && consumption == null && message.bytes.isNotEmpty() && message.bytes.size <= 64 * 1024 + 9)
      CompletableDeferred<Unit>().also { consumption = it }
    }
    incoming.send(message)
    waiter.await()
  }
  override suspend fun receive() = incoming.receive()
  override suspend fun consumed() { mutex.withLock { consumption?.complete(Unit); consumption = null } }
  override suspend fun close() {
    mutex.withLock {
      if (closed) return
      closed = true
      incoming.cancel()
      consumption?.cancel(); consumption = null
      sends.values.forEach { it.second.cancel() }; sends.clear(); queuedBytes = 0
    }
    emit("onBrowserTransportClose", mapOf("id" to id))
  }
}

internal object BrowserTransportRegistry {
  private val transports = ConcurrentHashMap<String, BridgedBrowserTransport>()
  fun create(emit: (String, Map<String, Any>) -> Unit): String {
    val id = UUID.randomUUID().toString()
    transports[id] = BridgedBrowserTransport(id, emit)
    return id
  }
  fun require(id: String) = checkNotNull(transports[id]) { "Browser transport is unavailable." }
  suspend fun close(id: String) { transports.remove(id)?.close() }
  suspend fun closeAll() { transports.keys.toList().forEach { close(it) } }
}
