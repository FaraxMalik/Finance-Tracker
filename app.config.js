/**
 * The few parts of the Expo config that have to be computed. Everything else lives in app.json.
 *
 * `versionCode` must go up with every release, or Android refuses to install the new APK over the old one.
 * The release workflow passes the run number in ANDROID_VERSION_CODE.
 */
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    versionCode: Number(process.env.ANDROID_VERSION_CODE) || 1,
  },
});
