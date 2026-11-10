package expo.modules.taskhandoffremotedesktop

import android.content.Context
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class TaskHandoffRemoteDesktopView(context: Context, appContext: AppContext) : ExpoView(context, appContext), TextureView.SurfaceTextureListener {
  private val textureView = TextureView(context)
  private var attachedSurface: Surface? = null

  init {
    setBackgroundColor(Color.BLACK)
    textureView.surfaceTextureListener = this
    addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
    attach(texture)
  }

  override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {
    attach(texture)
  }

  override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
    detach()
    return true
  }

  override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    textureView.surfaceTexture?.let(::attach)
  }

  private fun attach(texture: SurfaceTexture) {
    if (attachedSurface?.isValid == true) return
    val surface = Surface(texture)
    attachedSurface = surface
    RemoteDesktopDecoderEngine.attach(surface)
  }

  private fun detach() {
    val surface = attachedSurface ?: return
    attachedSurface = null
    RemoteDesktopDecoderEngine.detach(surface)
    surface.release()
  }

  override fun onDetachedFromWindow() {
    detach()
    super.onDetachedFromWindow()
  }
}
