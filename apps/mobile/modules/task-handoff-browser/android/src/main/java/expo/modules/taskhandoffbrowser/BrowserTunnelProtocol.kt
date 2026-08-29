package expo.modules.taskhandoffbrowser

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal object BrowserTunnelProtocol {
  const val VERSION = "2026-08-29"
  const val HEADER_BYTES = 9
  const val INITIAL_WINDOW = 256 * 1024
  const val MAX_DATA_BYTES = 64 * 1024
  const val MAX_CONTROL_BYTES = 4 * 1024
  const val MAX_WINDOW = 16 * 1024 * 1024

  enum class FrameType(val value: Byte) {
    OPEN(1), OPEN_OK(2), DATA(3), HALF_CLOSE(4), CLOSE(5), ERROR(6), WINDOW_UPDATE(7);
    companion object { fun from(value: Byte) = entries.firstOrNull { it.value == value } }
  }

  data class Frame(val type: FrameType, val streamId: Long, val payload: ByteArray)

  fun hello() = JSONObject()
    .put("type", "browser-tunnel.hello")
    .put("protocolVersion", VERSION)
    .put("initialWindowBytes", INITIAL_WINDOW)
    .toString()

  fun open(streamId: Long, host: String, port: Int): ByteArray {
    require(host.isNotBlank() && host.toByteArray().size <= 255 && !host.any { it.isWhitespace() || it in "/?#@\\[]" })
    require(port in 1..65535)
    return encode(Frame(FrameType.OPEN, streamId, JSONObject().put("host", host).put("port", port).toString().toByteArray()))
  }

  fun encode(frame: Frame): ByteArray {
    require(frame.streamId in 1..0xffffffffL)
    val max = if (frame.type == FrameType.DATA) MAX_DATA_BYTES else MAX_CONTROL_BYTES
    require(frame.payload.size <= max)
    require(frame.type !in setOf(FrameType.OPEN_OK, FrameType.HALF_CLOSE, FrameType.CLOSE) || frame.payload.isEmpty())
    return ByteBuffer.allocate(HEADER_BYTES + frame.payload.size).order(ByteOrder.BIG_ENDIAN)
      .put(frame.type.value).putInt(frame.streamId.toInt()).putInt(frame.payload.size).put(frame.payload).array()
  }

  fun decode(input: ByteArray): Frame {
    require(input.size >= HEADER_BYTES)
    val buffer = ByteBuffer.wrap(input).order(ByteOrder.BIG_ENDIAN)
    val type = requireNotNull(FrameType.from(buffer.get()))
    val streamId = buffer.int.toLong() and 0xffffffffL
    val length = buffer.int
    require(streamId > 0 && length == buffer.remaining())
    val payload = ByteArray(length)
    buffer.get(payload)
    return Frame(type, streamId, payload).also { encode(it) }
  }

  fun windowUpdate(streamId: Long, bytes: Int): ByteArray {
    require(bytes in 1..MAX_WINDOW)
    return encode(Frame(FrameType.WINDOW_UPDATE, streamId, ByteBuffer.allocate(4).putInt(bytes).array()))
  }

  fun windowBytes(frame: Frame): Int {
    require(frame.type == FrameType.WINDOW_UPDATE && frame.payload.size == 4)
    return ByteBuffer.wrap(frame.payload).int.also { require(it in 1..MAX_WINDOW) }
  }
}
