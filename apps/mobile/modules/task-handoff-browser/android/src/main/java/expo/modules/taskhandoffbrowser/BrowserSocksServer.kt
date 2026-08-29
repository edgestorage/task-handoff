package expo.modules.taskhandoffbrowser

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.util.Collections

internal class BrowserSocksServer(private val channel: BrowserTunnelChannel) : Closeable {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val permits = Semaphore(256)
  private val sockets = Collections.synchronizedSet(mutableSetOf<Socket>())
  private var server: ServerSocket? = null
  private var acceptJob: Job? = null

  suspend fun start(): Int = withContext(Dispatchers.IO) {
    check(server == null)
    val listener = ServerSocket()
    listener.reuseAddress = false
    listener.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 256)
    server = listener
    acceptJob = scope.launch {
      while (!listener.isClosed) {
        val socket = runCatching { listener.accept() }.getOrNull() ?: break
        if (!socket.inetAddress.isLoopbackAddress) { socket.close(); continue }
        scope.launch { permits.withPermit { serveAndClose(socket) } }
      }
    }
    listener.localPort
  }

  override fun close() {
    server?.close()
    server = null
    synchronized(sockets) { sockets.toList() }.forEach { runCatching { it.close() } }
  }

  suspend fun closeAndJoin() {
    close()
    acceptJob?.cancelAndJoin()
    acceptJob = null
  }

  private suspend fun serveAndClose(socket: Socket) {
    sockets += socket
    try { serve(socket) } catch (_: Throwable) { } finally { sockets -= socket; runCatching { socket.close() } }
  }

  private suspend fun serve(socket: Socket) {
    socket.tcpNoDelay = true
    socket.soTimeout = 30_000
    val input = socket.getInputStream()
    val output = socket.getOutputStream()
    val greeting = input.readExactly(2)
    require(greeting[0].toInt() == 5)
    val methods = input.readExactly(greeting[1].toInt() and 0xff)
    if (!methods.contains(0)) {
      output.write(byteArrayOf(5, 0xff.toByte()))
      return
    }
    output.write(byteArrayOf(5, 0))
    val request = readRequest(input)
    if (request.command != 1) {
      output.write(socksReply(7))
      return
    }
    val outputLock = Any()
    val streamId = try {
      channel.open(
        request.host,
        request.port,
        onData = { data -> withContext(Dispatchers.IO) { synchronized(outputLock) { output.write(data); output.flush() } } },
        onHalfClose = { withContext(Dispatchers.IO) { runCatching { socket.shutdownOutput() } } },
        onClose = { withContext(Dispatchers.IO) { runCatching { socket.close() } } },
      )
    } catch (error: Throwable) {
      output.write(socksReply(5))
      throw error
    }
    output.write(socksReply(0))
    output.flush()
    socket.soTimeout = 0
    val buffer = ByteArray(BrowserTunnelProtocol.MAX_DATA_BYTES)
    try {
      while (true) {
        val count = withContext(Dispatchers.IO) { input.read(buffer) }
        if (count < 0) break
        if (count > 0) channel.sendData(streamId, buffer.copyOf(count))
      }
      channel.halfClose(streamId)
    } catch (error: Throwable) {
      channel.closeStream(streamId)
      throw error
    }
  }

  private fun readRequest(input: InputStream): Request {
    val header = input.readExactly(4)
    require(header[0].toInt() == 5 && header[2].toInt() == 0)
    val host = when (header[3].toInt()) {
      1 -> input.readExactly(4).joinToString(".") { (it.toInt() and 0xff).toString() }
      3 -> String(input.readExactly(input.readExactly(1)[0].toInt() and 0xff), Charsets.UTF_8).also { require(it.isNotBlank()) }
      4 -> Inet6Address.getByAddress(null, input.readExactly(16), -1).hostAddress ?: error("Invalid IPv6 target")
      else -> error("Unsupported SOCKS address type")
    }
    val port = ByteBuffer.wrap(input.readExactly(2)).short.toInt() and 0xffff
    require(port > 0)
    return Request(header[1].toInt() and 0xff, host, port)
  }

  private fun socksReply(code: Int) = byteArrayOf(5, code.toByte(), 0, 1, 0, 0, 0, 0, 0, 0)
  private data class Request(val command: Int, val host: String, val port: Int)
}

private fun InputStream.readExactly(count: Int): ByteArray {
  require(count in 0..BrowserTunnelProtocol.MAX_CONTROL_BYTES)
  val output = ByteArray(count)
  var offset = 0
  while (offset < count) {
    val read = read(output, offset, count - offset)
    if (read < 0) throw EOFException("SOCKS connection ended unexpectedly")
    offset += read
  }
  return output
}
