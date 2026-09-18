const { patchAndroidReleaseBuildGradle } = require('../plugins/with-task-handoff-android-release');

const fixture = `def jscFlavor = 'android-jsc'

android {
    defaultConfig {
        versionCode 1
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
        }
    }
}
`;

test('production Android builds consume explicit release signing environment', () => {
  const patched = patchAndroidReleaseBuildGradle(fixture);
  expect(patched).toContain('System.getenv("TASK_HANDOFF_ANDROID_KEYSTORE")');
  expect(patched).toContain('throw new GradleException("Android release signing environment is incomplete.")');
  expect(patched).toContain('signingConfig signingConfigs.release');
  expect(patched).toContain("versionCode = (project.findProperty('taskHandoffVersionCode') ?: '1').toInteger()");
  expect(patched.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(1);
  expect(patchAndroidReleaseBuildGradle(patched)).toBe(patched);
});
