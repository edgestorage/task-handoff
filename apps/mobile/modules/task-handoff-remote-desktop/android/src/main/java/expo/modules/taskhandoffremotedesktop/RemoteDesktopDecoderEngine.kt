package expo.modules.taskhandoffremotedesktop

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer

private const val TAG = "TaskHandoffRemoteDesktop"

internal data class RemoteDesktopCodecConfig(
  val codec: String,
  val width: Int,
  val height: Int,
  val fps: Int,
  val bitrate: Int,
)

/** One native surface and one decoder are active for the single remote desktop
 * viewer. Business session ownership remains in JS. */
internal object RemoteDesktopDecoderEngine {
  private var surface: Surface? = null
  private var config: RemoteDesktopCodecConfig? = null
  private var codec: MediaCodec? = null
  private var mime: String? = null
  private var parameterSets: ByteArray? = null
  private var lastTimestampUs: Long = 0
  private var queuedFrames: Long = 0
  private var outputFrames: Long = 0
  private var inputDrops: Long = 0
  private var parameterSetFailures: Long = 0
  private var surfaceWarnings: Int = 0
  var onError: ((code: String, message: String?) -> Unit)? = null

  @Synchronized
  fun attach(value: Surface) {
    if (surface === value) return
    releaseCodec()
    surface = value
    surfaceWarnings = 0
    ensureCodec()
  }

  @Synchronized
  fun detach(value: Surface) {
    if (surface !== value) return
    releaseCodec()
    surface = null
  }

  @Synchronized
  fun configure(value: RemoteDesktopCodecConfig) {
    config = value
    releaseCodec()
    parameterSets = null
    lastTimestampUs = 0
    queuedFrames = 0
    outputFrames = 0
    inputDrops = 0
    parameterSetFailures = 0
    ensureCodec()
  }

  @Synchronized
  fun reset() {
    releaseCodec()
    parameterSets = null
    lastTimestampUs = 0
    ensureCodec()
  }

  @Synchronized
  fun close() {
    releaseCodec()
    surface = null
    config = null
    parameterSets = null
    lastTimestampUs = 0
  }

  @Synchronized
  fun decode(data: ByteArray, keyframe: Boolean, timestampUs: Double) {
    val current = config ?: return
    if (surface == null) {
      if (surfaceWarnings++ < 3) Log.w(TAG, "decode ignored without surface")
      return
    }
    if (data.isEmpty()) return
    if (!keyframe && parameterSets == null) return

    if (keyframe) {
      val nals = annexBNals(data)
      if (nals.isEmpty()) {
        parameterSetFailures += 1
        if (parameterSetFailures <= 3) Log.w(TAG, "keyframe without annex-b NALs bytes=${data.size}")
        return
      }
      val parsed = parameterSetsFor(current.codec, nals) ?: run {
        parameterSetFailures += 1
        if (parameterSetFailures <= 3) Log.w(TAG, "keyframe without parameter sets nals=${nalTypes(nals).take(16)}")
        return
      }
      if (!parsed.contentEquals(parameterSets)) {
        releaseCodec()
        parameterSets = parsed
        ensureCodec()
      }
    }
    if (codec == null) ensureCodec()
    val active = codec ?: return
    val ptsUs = maxOf(timestampUs.toLong(), lastTimestampUs + 1)
    lastTimestampUs = ptsUs
    try {
      val inputIndex = active.dequeueInputBuffer(10_000)
      if (inputIndex >= 0) {
        val input = active.getInputBuffer(inputIndex) ?: return
        input.clear()
        input.put(data)
        active.queueInputBuffer(inputIndex, 0, data.size, ptsUs, 0)
        queuedFrames += 1
        if (queuedFrames <= 3) Log.i(TAG, "input queued=$queuedFrames key=$keyframe bytes=${data.size}")
      } else {
        inputDrops += 1
        if (inputDrops <= 3) Log.w(TAG, "input unavailable index=$inputIndex")
      }
      drain(active)
    } catch (cause: Throwable) {
      Log.e(TAG, "decode failed", cause)
      report("REMOTE_DESKTOP_DECODER_FAILED", cause.message)
      releaseCodec()
      parameterSets = null
    }
  }

  private fun ensureCodec() {
    val current = config ?: return
    val target = surface ?: return
    if (codec != null) return
    val activeMime = when {
      current.codec.startsWith("avc1") || current.codec.startsWith("avc3") -> MediaFormat.MIMETYPE_VIDEO_AVC
      current.codec.startsWith("hvc1") || current.codec.startsWith("hev1") -> MediaFormat.MIMETYPE_VIDEO_HEVC
      else -> {
        report("REMOTE_DESKTOP_CODEC_UNSUPPORTED", current.codec)
        return
      }
    }
    val sets = parameterSets
    if (sets == null) return
    try {
      val format = MediaFormat.createVideoFormat(activeMime, current.width.coerceAtLeast(2), current.height.coerceAtLeast(2)).apply {
        setInteger(MediaFormat.KEY_FRAME_RATE, current.fps.coerceIn(1, 120))
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 2 * 1024 * 1024)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
        applyCodecSpecificData(this, current.codec, sets)
      }
      val created = MediaCodec.createDecoderByType(activeMime)
      created.configure(format, target, null, 0)
      created.start()
      codec = created
      mime = activeMime
      Log.i(TAG, "decoder started mime=$activeMime ${current.width}x${current.height} csd=${sets.size}")
    } catch (cause: Throwable) {
      Log.e(TAG, "decoder configure failed codec=${current.codec}", cause)
      report("REMOTE_DESKTOP_DECODER_CONFIGURE_FAILED", cause.message)
      releaseCodec()
      parameterSets = null
    }
  }

  private fun applyCodecSpecificData(format: MediaFormat, codecName: String, sets: ByteArray) {
    if (codecName.startsWith("avc")) {
      val nals = annexBNals(sets)
      val sps = nals.firstOrNull { nalType(it, true) == 7 }
      val pps = nals.firstOrNull { nalType(it, true) == 8 }
      if (sps != null) format.setByteBuffer("csd-0", ByteBuffer.wrap(withStartCode(sps)))
      if (pps != null) format.setByteBuffer("csd-1", ByteBuffer.wrap(withStartCode(pps)))
    } else {
      format.setByteBuffer("csd-0", ByteBuffer.wrap(sets))
    }
  }

  private fun drain(decoder: MediaCodec) {
    val info = MediaCodec.BufferInfo()
    while (true) {
      when (val index = decoder.dequeueOutputBuffer(info, 0)) {
        MediaCodec.INFO_TRY_AGAIN_LATER -> return
        MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> Log.i(TAG, "output format changed ${decoder.outputFormat}")
        else -> if (index >= 0) {
          outputFrames += 1
          if (outputFrames <= 3) {
            Log.i(TAG, "output frame=$outputFrames size=${info.size} flags=${info.flags} ptsUs=${info.presentationTimeUs}")
          }
          decoder.releaseOutputBuffer(index, true)
        }
      }
    }
  }

  private fun releaseCodec() {
    val active = codec ?: return
    codec = null
    mime = null
    try { active.stop() } catch (_: Throwable) {}
    try { active.release() } catch (_: Throwable) {}
  }

  private fun report(code: String, message: String?) {
    onError?.invoke(code, message)
  }

  private fun parameterSetsFor(codecName: String, nals: List<ByteArray>): ByteArray? {
    val hevc = codecName.startsWith("hvc1") || codecName.startsWith("hev1")
    val wanted = if (hevc) setOf(32, 33, 34) else setOf(7, 8)
    val selected = nals.filter { nalType(it, !hevc) in wanted }
    if (selected.isEmpty()) return null
    if (!hevc && selected.none { nalType(it, true) == 7 }) return null
    if (!hevc && selected.none { nalType(it, true) == 8 }) return null
    return selected.fold(ByteArray(0)) { value, nal -> value + withStartCode(nal) }
  }

  private fun nalTypes(nals: List<ByteArray>): List<Int> = nals.map { nal ->
    if (mime == MediaFormat.MIMETYPE_VIDEO_HEVC || config?.codec?.startsWith("hv") == true) nalType(nal, false) else nalType(nal, true)
  }
}

private fun nalType(nal: ByteArray, h264: Boolean): Int {
  if (nal.isEmpty()) return -1
  return if (h264) nal[0].toInt() and 0x1f else (nal[0].toInt() ushr 1) and 0x3f
}

private fun withStartCode(nal: ByteArray): ByteArray = byteArrayOf(0, 0, 0, 1) + nal

private fun annexBNals(data: ByteArray): List<ByteArray> {
  val starts = mutableListOf<Pair<Int, Int>>()
  var index = 0
  while (index + 3 < data.size) {
    when {
      data[index] == 0.toByte() && data[index + 1] == 0.toByte() && data[index + 2] == 1.toByte() -> {
        starts += index to 3
        index += 3
      }
      index + 4 < data.size && data[index] == 0.toByte() && data[index + 1] == 0.toByte() && data[index + 2] == 0.toByte() && data[index + 3] == 1.toByte() -> {
        starts += index to 4
        index += 4
      }
      else -> index++
    }
  }
  val result = mutableListOf<ByteArray>()
  for (position in starts.indices) {
    val (start, prefix) = starts[position]
    val begin = start + prefix
    val end = if (position + 1 < starts.size) starts[position + 1].first else data.size
    if (end > begin) result += data.copyOfRange(begin, end)
  }
  return result
}
