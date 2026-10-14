package expo.modules.taskhandoffappearance

import android.app.UiModeManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Persists the in-app appearance preference as the Android 12+ application night mode so the
 * system applies it to every configuration-derived surface, including the cold-start splash
 * window. Below API 31 there is no application-scoped API; the JavaScript layer keeps using
 * [androidx.appcompat.app.AppCompatDelegate] there.
 */
class TaskHandoffAppearanceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TaskHandoffAppearance")

    Function("setApplicationNightMode") { preference: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
      val context = appContext.reactContext ?: return@Function false
      val uiModeManager = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        ?: return@Function false
      val mode = nightModeFor(preference) ?: return@Function false
      uiModeManager.setApplicationNightMode(mode)
      true
    }
  }

  private fun nightModeFor(preference: String): Int? = when (preference) {
    "dark" -> UiModeManager.MODE_NIGHT_YES
    "light" -> UiModeManager.MODE_NIGHT_NO
    // MODE_NIGHT_AUTO clears the application override, so the app follows the system again.
    "system" -> UiModeManager.MODE_NIGHT_AUTO
    else -> null
  }
}
