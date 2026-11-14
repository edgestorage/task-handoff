const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const pkg = require('../package.json');

/**
 * The remote desktop viewer only receives video and uses data channels. The
 * WebRTC dependency declares camera/microphone capabilities for its general
 * media API, so remove the unused Android permissions before prebuild. The iOS
 * purpose strings live in the image-picker permission config because that
 * plugin owns the final Info.plist permission update.
 */
function withTaskHandoffRemoteDesktop(config) {
  config = withAndroidManifest(config, (result) => {
    AndroidConfig.Permissions.addBlockedPermissions(result.modResults, [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.BLUETOOTH',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.MODIFY_AUDIO_SETTINGS',
    ]);
    return result;
  });
  return config;
}

module.exports = createRunOncePlugin(withTaskHandoffRemoteDesktop, 'task-handoff-remote-desktop', pkg.version);
