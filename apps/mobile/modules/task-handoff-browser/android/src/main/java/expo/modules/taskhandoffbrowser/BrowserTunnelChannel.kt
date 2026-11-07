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
import org.json.JSONObject
import java.io.Closeable

internal class BrowserTunnelChannel(
  private val transport: BrowserMessageTransport,
  private val diagnostic: (String) -> Unit = {},
  private val onClosed: (String, Throwable?) -> Unit = { _, _ -> },
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
  private val streams = mutableMapOf<Long, Stream>()
  private var nextStreamId = 1L
  private var initialWindow = BrowserTunnelProtocol.INITIAL_WINDOW
  private var closed = false
  private val inboundConsumer = scope.launch {
    var operation = "transport.connect"
    try {
      diagnostic("transport.connect")
      transport.connect()
      operation = "hello.send"
      diagnostic("hello.send")
      transport.send(BrowserTransportMessage(BrowserTunnelProtocol.hello().toByteArray(), false))
      diagnostic("ready.receive")
      while (!closed) {
        operation = "receive"
        val message = transport.receive()
        if (!ready.isCompleted) {
          operation = "ready.validate"
          diagnostic("ready.validate")
          check(!message.binary)
          val value = JSONObject(String(message.bytes, Charsets.UTF_8))
          check(value.getString("type") == "browser-tunnel.ready")
          check(value.getString("protocolVersion") == BrowserTunnelProtocol.VERSION)
          initialWindow = value.getInt("initialWindowBytes").also { check(it in 1..BrowserTunnelProtocol.MAX_WINDOW) }
          ready.complete(Unit)
          diagnostic("tunnel.ready")
        } else {
          operation = "frame.validate"
          check(message.binary)
          operation = "frame.decode"
          val frame = BrowserTunnelProtocol.decode(message.bytes)
          operation = "frame.handle"
          handle(frame)
        }
        operation = "frame.consume"
        transport.consumed()
      }
    } catch (error: Throwable) {
      ready.completeExceptionally(error)
      closeNow(operation, error)
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

  private suspend fun closeNow(source: String = "local", error: Throwable? = null) {
    val active = mutex.withLock {
      if (closed) return
      closed = true
      streams.values.toList().also { streams.clear() }
    }
    onClosed(source, error)
    ready.completeExceptionally(IllegalStateException("Browser relay closed."))

    for (stream in active) {
      stream.opened.completeExceptionally(IllegalStateException("Browser relay closed."))
      stream.creditSignal.close()
      runCatching { stream.onClose() }
    }
    transport.close()
  }

  private suspend fun send(data: ByteArray) {
    transport.send(BrowserTransportMessage(data, true))
  }

  private fun allocateStreamId(): Long {
    while (streams.containsKey(nextStreamId)) nextStreamId = if (nextStreamId == 0xffffffffL) 1 else nextStreamId + 1
    return nextStreamId.also { nextStreamId = if (it == 0xffffffffL) 1 else it + 1 }
  }

}
