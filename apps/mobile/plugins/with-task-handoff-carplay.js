const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const SOURCE_NAMES = ['TaskHandoffCarPlay.swift', 'TaskHandoffCarPlayBridge.m'];

module.exports = function withTaskHandoffCarPlay(config, options = {}) {
  const entitlement = options.entitlement || 'com.apple.developer.carplay-driving-task';

  config = withInfoPlist(config, (next) => {
    const manifest = next.modResults.UIApplicationSceneManifest || {};
    const configurations = manifest.UISceneConfigurations || {};
    next.modResults.UIApplicationSceneManifest = {
      ...manifest,
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        ...configurations,
        UIWindowSceneSessionRoleApplication: configurations.UIWindowSceneSessionRoleApplication || [{
          UISceneClassName: 'UIWindowScene',
          UISceneConfigurationName: 'TaskHandoffWindow',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).TaskHandoffWindowSceneDelegate',
        }],
        CPTemplateApplicationSceneSessionRoleApplication: [{
          UISceneClassName: 'CPTemplateApplicationScene',
          UISceneConfigurationName: 'TaskHandoffCarPlay',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).TaskHandoffCarPlaySceneDelegate',
        }],
      },
    };
    return next;
  });

  config = withEntitlementsPlist(config, (next) => {
    next.modResults[entitlement] = true;
    return next;
  });

  return withXcodeProject(config, (next) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(next.modRequest.projectRoot);
    for (const sourceName of SOURCE_NAMES) {
      const relativePath = path.join(projectName, sourceName);
      const destination = path.join(next.modRequest.platformProjectRoot, relativePath);
      fs.copyFileSync(path.join(__dirname, 'carplay', sourceName), destination);
      if (!next.modResults.hasFile(relativePath)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: relativePath,
          groupName: projectName,
          project: next.modResults,
        });
      }
    }
    IOSConfig.XcodeUtils.addFramework({
      project: next.modResults,
      projectName,
      framework: 'CarPlay.framework',
    });
    return next;
  });
};
