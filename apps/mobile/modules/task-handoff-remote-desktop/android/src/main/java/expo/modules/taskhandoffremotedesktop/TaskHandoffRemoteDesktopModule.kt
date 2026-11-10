package expo.modules.taskhandoffremotedesktop

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.launch

class TaskHandoffRemoteDesktopModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TaskHandoffRemoteDesktop")
    Events("onRemoteDesktopDecoderError")

    OnCreate {
      RemoteDesktopDecoderEngine.onError = { code, message ->
        sendEvent("onRemoteDesktopDecoderError", mapOf("code" to code, "message" to message))
      }
    }

    Function("isAvailable") { true }

    AsyncFunction("configure") { input: RemoteDesktopCodecConfigRecord, promise: expo.modules.kotlin.Promise ->
      appContext.modulesQueue.launch {
        runCatching {
          RemoteDesktopDecoderEngine.configure(RemoteDesktopCodecConfig(
            codec = input.codec,
            width = input.width,
            height = input.height,
            fps = input.fps,
            bitrate = input.bitrate,
          ))
        }.onSuccess { promise.resolve(null) }
          .onFailure { promise.reject("REMOTE_DESKTOP_DECODER_CONFIGURE_FAILED", it.message, it) }
      }
    }

    AsyncFunction("decode") { data: ByteArray, keyframe: Boolean, timestampUs: Double, promise: expo.modules.kotlin.Promise ->
      appContext.modulesQueue.launch {
        runCatching { RemoteDesktopDecoderEngine.decode(data, keyframe, timestampUs) }
          .onSuccess { promise.resolve(null) }
          .onFailure { promise.reject("REMOTE_DESKTOP_DECODER_FAILED", it.message, it) }
      }
    }

    AsyncFunction("reset") { promise: expo.modules.kotlin.Promise ->
      appContext.modulesQueue.launch {
        runCatching { RemoteDesktopDecoderEngine.reset() }
          .onSuccess { promise.resolve(null) }
          .onFailure { promise.reject("REMOTE_DESKTOP_DECODER_RESET_FAILED", it.message, it) }
      }
    }

    AsyncFunction("close") { promise: expo.modules.kotlin.Promise ->
      appContext.modulesQueue.launch {
        runCatching { RemoteDesktopDecoderEngine.close() }
          .onSuccess { promise.resolve(null) }
          .onFailure { promise.reject("REMOTE_DESKTOP_DECODER_CLOSE_FAILED", it.message, it) }
      }
    }

    View(TaskHandoffRemoteDesktopView::class) {
      OnViewDestroys { }
    }

    OnDestroy {
      RemoteDesktopDecoderEngine.onError = null
      RemoteDesktopDecoderEngine.close()
    }
  }
}

internal class RemoteDesktopCodecConfigRecord : Record {
  @Field val codec: String = ""
  @Field val width: Int = 0
  @Field val height: Int = 0
  @Field val fps: Int = 30
  @Field val bitrate: Int = 0
}
