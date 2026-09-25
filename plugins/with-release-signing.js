const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Signs release builds with our own keystore instead of Expo's public debug key.
 *
 * Only active when ANDROID_KEYSTORE_PATH is set (the release workflow sets it), so a local `expo prebuild` still works
 * without any secrets. The passwords are never written into the generated project: build.gradle reads them from the
 * environment when Gradle runs.
 *
 * If Expo's generated build.gradle ever changes shape and the patch no longer applies, this throws instead of quietly
 * producing an APK signed with the debug key.
 */
module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (!process.env.ANDROID_KEYSTORE_PATH) return mod;

    let gradle = mod.modResults.contents;

    // 1. Add a `release` signing config right after the `debug` one.
    const debugConfig = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\}\s*)\}/;
    if (!debugConfig.test(gradle))
      throw new Error('with-release-signing: could not find signingConfigs { debug { ... } }');
    gradle = gradle.replace(
      debugConfig,
      `$1    release {
            storeFile file(System.getenv('ANDROID_KEYSTORE_PATH'))
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('ANDROID_KEY_ALIAS')
            keyPassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            storeType 'pkcs12'
        }
    }`,
    );

    // 2. Make the release build type use it (and only the release one; debug keeps the debug key).
    const releaseUsesDebug = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/;
    if (!releaseUsesDebug.test(gradle))
      throw new Error('with-release-signing: could not find the release signingConfig');
    gradle = gradle.replace(releaseUsesDebug, '$1signingConfig signingConfigs.release');

    mod.modResults.contents = gradle;
    return mod;
  });
};
