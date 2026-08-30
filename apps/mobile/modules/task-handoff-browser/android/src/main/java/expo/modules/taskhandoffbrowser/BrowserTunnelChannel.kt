package expo.modules.taskhandoffbrowser

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.Closeable

internal class BrowserTunnelChannel(
  url: String,
  token: String,
  client: OkHttpClient = OkHttpClient.Builder().retryOnConnectionFailure(false).build()
) : Closeable {
  private data class Stream(
    val id: Long,
    val onData: suspend (ByteArray) -> Unit,
    val onHalfClose: suspend () -> Unit,
    val onClose: suspend () -> Unit,
    val opened: CompletableDeferred<Unit> = CompletableDeferred(),
    val creditSignal: Channel<Unit> = Channel(Channel.CONFLATED),
    var state: String = "opening",
    var sendCredit: Int = BrowserTunnelProtocol.INITIAL_WINDOW,
    var receiveCredit: Int = BrowserTunnelProtocol.INITIAL_WINDOW,
  )

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val mutex = Mutex()
  private val ready = CompletableDeferred<Unit>()
  // DATA frames are flow-controlled per stream; keep a bounded queue large enough
  // for every stream's initial window without treating temporary callback backpressure
  // as a relay failure.
  private val inboundFrames = Channel<BrowserTunnelProtocol.Frame>(capacity = 2048)
  private val streams = mutableMapOf<Long, Stream>()
  private var nextStreamId = 1L
  private var initialWindow = BrowserTunnelProtocol.INITIAL_WINDOW
  private var closed = false
  private val webSocket = client.newWebSocket(
    Request.Builder().url(url).header("Authorization", "Browser $token").build(),
    Listener()
  )
  private val inboundConsumer = scope.launch {
    for (frame in inboundFrames) {
      try {
        handle(frame)
      } catch (_: Throwable) {
        closeNow()
        break
      }
    }
  }

  suspend fun connect() { withTimeout(15_000) { ready.await() } }

  suspend fun open(
    host: String,
    port: Int,
    onData: suspend (ByteArray) -> Unit,
    onHalfClose: suspend () -> Unit,
    onClose: suspend () -> Unit,
  ): Long {
    ready.await()
    val stream = mutex.withLock {
      check(!closed && streams.size < 256)
      val id = allocateStreamId()
      Stream(id, onData, onHalfClose, onClose, sendCredit = initialWindow).also { streams[id] = it }
    }
    send(BrowserTunnelProtocol.open(stream.id, host, port))
    stream.opened.await()
    return stream.id
  }

  suspend fun sendData(streamId: Long, input: ByteArray) {
    var offset = 0
    while (offset < input.size) {
      val step = mutex.withLock {
        val stream = checkNotNull(streams[streamId])
        check(stream.state == "open")
        minOf(input.size - offset, stream.sendCredit, BrowserTunnelProtocol.MAX_DATA_BYTES).also {
          if (it > 0) stream.sendCredit -= it
        }
      }
      if (step == 0) {
        val signal = mutex.withLock { checkNotNull(streams[streamId]).creditSignal }
        signal.receive()
        continue
      }
      send(BrowserTunnelProtocol.encode(BrowserTunnelProtocol.Frame(
        BrowserTunnelProtocol.FrameType.DATA, streamId, input.copyOfRange(offset, offset + step)
      )))
      offset += step
    }
  }

  fun halfClose(streamId: Long): Job = scope.launch {
    if (mutex.withLock { streams[streamId]?.state == "open" }) {
      send(BrowserTunnelProtocol.encode(BrowserTunnelProtocol.Frame(BrowserTunnelProtocol.FrameType.HALF_CLOSE, streamId, byteArrayOf())))
    }
  }

  fun closeStream(streamId: Long, notify: Boolean = true): Job = scope.launch { closeStreamNow(streamId, notify) }

  override fun close() {
    scope.launch { closeNow() }
  }

  suspend fun closeAndJoin() { closeNow() }

  private suspend fun handle(frame: BrowserTunnelProtocol.Frame) {
    val stream = mutex.withLock { streams[frame.streamId] } ?: return
    when (frame.type) {
      BrowserTunnelProtocol.FrameType.OPEN_OK -> mutex.withLock {
        check(stream.state == "opening")
        stream.state = "open"
        stream.opened.complete(Unit)
      }
      BrowserTunnelProtocol.FrameType.DATA -> {
        mutex.withLock {
          check(stream.state == "open" && frame.payload.size <= stream.receiveCredit)
          stream.receiveCredit -= frame.payload.size
        }
        stream.onData(frame.payload)
        mutex.withLock { stream.receiveCredit += frame.payload.size }
        send(BrowserTunnelProtocol.windowUpdate(frame.streamId, frame.payload.size))
      }
      BrowserTunnelProtocol.FrameType.WINDOW_UPDATE -> mutex.withLock {
        val bytes = BrowserTunnelProtocol.windowBytes(frame)
        check(stream.sendCredit + bytes <= BrowserTunnelProtocol.MAX_WINDOW)
        stream.sendCredit += bytes
        stream.creditSignal.trySend(Unit)
      }
      BrowserTunnelProtocol.FrameType.HALF_CLOSE -> stream.onHalfClose()
      BrowserTunnelProtocol.FrameType.CLOSE -> {
        closeStreamNow(frame.streamId, false)
        stream.onClose()
      }
      BrowserTunnelProtocol.FrameType.ERROR -> {
        val message = runCatching { JSONObject(String(frame.payload)).optString("message") }.getOrNull() ?: "Target connection failed."
        stream.opened.completeExceptionally(IllegalStateException(message))
        closeStreamNow(frame.streamId, false)
        stream.onClose()
      }
      BrowserTunnelProtocol.FrameType.OPEN -> error("Browser client cannot receive OPEN frames")
    }
  }

  private suspend fun closeStreamNow(streamId: Long, notify: Boolean) {
    val stream = mutex.withLock { streams.remove(streamId) } ?: return
    stream.state = "closed"
    stream.opened.completeExceptionally(IllegalStateException("Target connection closed before opening."))
    stream.creditSignal.close()
    if (notify && !closed) runCatching {
      send(BrowserTunnelProtocol.encode(BrowserTunnelProtocol.Frame(BrowserTunnelProtocol.FrameType.CLOSE, streamId, byteArrayOf())))
    }
  }

  private suspend fun closeNow() {
    val active = mutex.withLock {
      if (closed) return
      closed = true
      streams.values.toList().also { streams.clear() }
    }
    ready.completeExceptionally(IllegalStateException("Browser relay closed."))
    inboundFrames.close()
    for (stream in active) {
      stream.opened.completeExceptionally(IllegalStateException("Browser relay closed."))
      stream.creditSignal.close()
      runCatching { stream.onClose() }
    }
    webSocket.close(1001, "Browser context closed")
  }

  private fun send(data: ByteArray) {
    check(webSocket.queueSize() + data.size <= 16L * 1024 * 1024)
    check(webSocket.send(ByteString.of(*data)))
  }

  private fun allocateStreamId(): Long {
    while (streams.containsKey(nextStreamId)) nextStreamId = if (nextStreamId == 0xffffffffL) 1 else nextStreamId + 1
    return nextStreamId.also { nextStreamId = if (it == 0xffffffffL) 1 else it + 1 }
  }

  private inner class Listener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      if (!webSocket.send(BrowserTunnelProtocol.hello())) ready.completeExceptionally(IllegalStateException("Browser relay hello failed."))
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      if (!ready.isCompleted) {
        runCatching {
          val value = JSONObject(text)
          check(value.getString("type") == "browser-tunnel.ready")
          check(value.getString("protocolVersion") == BrowserTunnelProtocol.VERSION)
          initialWindow = value.getInt("initialWindowBytes").also { check(it in 1..BrowserTunnelProtocol.MAX_WINDOW) }
        }.onSuccess { ready.complete(Unit) }.onFailure { ready.completeExceptionally(it); close() }
      } else close()
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (!ready.isCompleted) { close(); return }
      val frame = runCatching { BrowserTunnelProtocol.decode(bytes.toByteArray()) }.getOrElse { close(); return }
      if (inboundFrames.trySend(frame).isFailure) close()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      ready.completeExceptionally(t)
      close()
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close() }
  }
}
