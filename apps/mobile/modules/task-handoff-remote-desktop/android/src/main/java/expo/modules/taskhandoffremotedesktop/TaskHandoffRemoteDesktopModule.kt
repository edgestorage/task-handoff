package expo.modules.taskhandoffremotedesktop

import android.text.Editable
import android.text.TextWatcher
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import com.facebook.react.uimanager.util.ReactFindViewUtil
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.launch
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class TaskHandoffRemoteDesktopModule : Module() {
  private var observedTextInput: EditText? = null
  private var textInputWatcher: TextWatcher? = null
  private var textInputObservationToken = 0

  private fun stopTextInputObservation() {
    textInputObservationToken += 1
    val editText = observedTextInput
    val watcher = textInputWatcher
    observedTextInput = null
    textInputWatcher = null
    if (editText != null && watcher != null) editText.post { editText.removeTextChangedListener(watcher) }
  }

  override fun definition() = ModuleDefinition {
    Name("TaskHandoffRemoteDesktop")
    Events("onRemoteDesktopDecoderError", "onRemoteDesktopVideoDimensions", "onRemoteDesktopTextInput")

    OnCreate {
      RemoteDesktopDecoderEngine.onError = { code, message ->
        sendEvent("onRemoteDesktopDecoderError", mapOf("code" to code, "message" to message))
      }
      RemoteDesktopDecoderEngine.onVideoDimensions = { width, height ->
        sendEvent("onRemoteDesktopVideoDimensions", mapOf("width" to width, "height" to height))
      }
    }

    Function("isAvailable") { true }

    Function("startTextInputObservation") { nativeID: String ->
      stopTextInputObservation()
      val token = textInputObservationToken
      val activity = appContext.currentActivity
      if (activity == null) false else {
        val matched = AtomicBoolean(false)
        val latch = CountDownLatch(1)
        activity.runOnUiThread {
          val decorView = activity.window?.decorView
          if (decorView != null && token == textInputObservationToken) {
            val editText = ReactFindViewUtil.findView(decorView, nativeID) as? EditText
            if (editText != null && editText.isFocused) {
              val watcher = object : TextWatcher {
                override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(text: Editable?) {
                  sendEvent("onRemoteDesktopTextInput", mapOf(
                    "text" to (text?.toString() ?: ""),
                    "composing" to (text != null && BaseInputConnection.getComposingSpanStart(text) >= 0),
                  ))
                }
              }
              editText.addTextChangedListener(watcher)
              observedTextInput = editText
              textInputWatcher = watcher
              matched.set(true)
            }
          }
          latch.countDown()
        }
        latch.await(1, TimeUnit.SECONDS)
        matched.get()
      }
    }

    Function("stopTextInputObservation") {
      stopTextInputObservation()
    }

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
      stopTextInputObservation()
      RemoteDesktopDecoderEngine.onError = null
      RemoteDesktopDecoderEngine.onVideoDimensions = null
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
