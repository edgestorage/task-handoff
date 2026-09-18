const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_ENV_MARKER = 'TASK_HANDOFF_ANDROID_KEYSTORE';

function patchAndroidReleaseBuildGradle(source) {
  if (source.includes(RELEASE_ENV_MARKER)) return source;

  const androidAnchor = '\nandroid {';
  if (!source.includes(androidAnchor)) {
    throw new Error('Unable to configure Android release signing: android block was not found.');
  }

  const releaseVariables = `
def taskHandoffReleaseKeystore = System.getenv("TASK_HANDOFF_ANDROID_KEYSTORE")
def taskHandoffReleaseKeystorePassword = System.getenv("TASK_HANDOFF_ANDROID_KEYSTORE_PASSWORD")
def taskHandoffReleaseKeyAlias = System.getenv("TASK_HANDOFF_ANDROID_KEY_ALIAS")
def taskHandoffReleaseKeyPassword = System.getenv("TASK_HANDOFF_ANDROID_KEY_PASSWORD")
def taskHandoffReleaseSigningValues = [taskHandoffReleaseKeystore, taskHandoffReleaseKeystorePassword, taskHandoffReleaseKeyAlias, taskHandoffReleaseKeyPassword]
def taskHandoffReleaseTaskRequested = gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") }
if (taskHandoffReleaseTaskRequested && taskHandoffReleaseSigningValues.any { !it }) {
    throw new GradleException("Android release signing environment is incomplete.")
}
`;
  let patched = source.replace(androidAnchor, `${releaseVariables}${androidAnchor}`);

  const signingConfigPattern = /(    signingConfigs \{\n        debug \{[\s\S]*?\n        \}\n)(    \})/;
  if (!signingConfigPattern.test(patched)) {
    throw new Error('Unable to configure Android release signing: debug signing config was not found.');
  }
  patched = patched.replace(signingConfigPattern, `$1        release {
            if (taskHandoffReleaseSigningValues.every { it }) {
                storeFile file(taskHandoffReleaseKeystore)
                storePassword taskHandoffReleaseKeystorePassword
                keyAlias taskHandoffReleaseKeyAlias
                keyPassword taskHandoffReleaseKeyPassword
            }
        }
$2`);

  const debugReleaseSigning = '            signingConfig signingConfigs.debug';
  const releaseBlockStart = patched.indexOf('        release {', patched.indexOf('    buildTypes {'));
  const debugSigningIndex = patched.indexOf(debugReleaseSigning, releaseBlockStart);
  if (releaseBlockStart < 0 || debugSigningIndex < 0) {
    throw new Error('Unable to configure Android release signing: release build type was not found.');
  }
  patched = `${patched.slice(0, debugSigningIndex)}            signingConfig signingConfigs.release${patched.slice(debugSigningIndex + debugReleaseSigning.length)}`;

  const versionCodePattern = /        versionCode \d+/;
  if (!versionCodePattern.test(patched)) {
    throw new Error('Unable to configure Android release build number: versionCode was not found.');
  }
  return patched.replace(versionCodePattern, "        versionCode = (project.findProperty('taskHandoffVersionCode') ?: '1').toInteger()");
}

function withTaskHandoffAndroidRelease(config) {
  return withAppBuildGradle(config, (next) => {
    if (next.modResults.language !== 'groovy') {
      throw new Error(`Unsupported Android build.gradle language: ${next.modResults.language}`);
    }
    next.modResults.contents = patchAndroidReleaseBuildGradle(next.modResults.contents);
    return next;
  });
}

module.exports = withTaskHandoffAndroidRelease;
module.exports.patchAndroidReleaseBuildGradle = patchAndroidReleaseBuildGradle;
