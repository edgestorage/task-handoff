const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

function withTaskHandoffBrowser(config) {
  config = withInfoPlist(config, (next) => {
    const ats = next.modResults.NSAppTransportSecurity || {};
    next.modResults.NSAppTransportSecurity = {
      ...ats,
      NSAllowsArbitraryLoadsInWebContent: true,
    };
    return next;
  });
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = 'true';
    return next;
  });
}

module.exports = withTaskHandoffBrowser;
