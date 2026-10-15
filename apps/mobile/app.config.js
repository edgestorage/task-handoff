const baseConfig = require('./app.json').expo;
const { resolveFeatureFlags } = require('../../shared/feature-flags.cjs');
const { CLOUD_ENVIRONMENTS, cloudEnvironmentForServiceOrigin } = require('../../shared/cloud-environments.cjs');

const variants = {
  development: {
    name: 'TaskHandoff Dev',
    scheme: 'taskhandoff-dev',
    applicationId: 'com.taskhandoff.mobile.dev',
  },
  production: {
    name: 'TaskHandoff',
    scheme: 'taskhandoff',
    applicationId: 'com.taskhandoff.mobile',
  },
  staging: {
    name: 'TaskHandoff Staging',
    scheme: 'taskhandoff-staging',
    applicationId: 'com.taskhandoff.mobile.staging',
  },
};

module.exports = () => {
  const variantName = process.env.TASK_HANDOFF_MOBILE_VARIANT || 'development';
  const variant = variants[variantName];
  if (!variant) {
    throw new Error(`Unsupported TASK_HANDOFF_MOBILE_VARIANT: ${variantName}`);
  }
  const taskStatusWidgetsEnabled = process.env.TASK_HANDOFF_WIDGETS_ENABLED !== '0';
  const carPlayEnabled = variantName === 'development' && process.env.TASK_HANDOFF_CARPLAY_ENABLED === '1';
  const featureFlags = resolveFeatureFlags(process.env);
  const cloudEnvironment = resolveCloudEnvironmentForVariant(variantName);
  const plugins = [
    ...(baseConfig.plugins || []),
    './modules/task-handoff-browser/plugin/withTaskHandoffBrowser',
    ...(taskStatusWidgetsEnabled ? [[
      'expo-widgets',
      {
        bundleIdentifier: `${variant.applicationId}.widgets`,
        groupIdentifier: `group.${variant.applicationId}`,
        widgets: [{
          name: 'TaskStatusWidget',
          displayName: 'Task Status',
          description: 'Shows active TaskHandoff AI work at a glance.',
          supportedFamilies: ['systemSmall', 'systemMedium'],
        }],
      },
    ]] : []),
    ...(carPlayEnabled ? [[
      './plugins/with-task-handoff-carplay',
      { entitlement: 'com.apple.developer.carplay-driving-task' },
    ]] : []),
    ...(variantName === 'production' ? ['./plugins/with-task-handoff-android-release'] : []),
  ];

  return {
    ...baseConfig,
    name: variant.name,
    scheme: variant.scheme,
    plugins,
    ios: {
      ...baseConfig.ios,
      bundleIdentifier: variant.applicationId,
      infoPlist: {
        ...baseConfig.ios?.infoPlist,
        ...(variantName === 'development' ? {
          NSAppTransportSecurity: {
            NSAllowsArbitraryLoads: true,
          },
        } : {}),
      },
    },
    android: {
      ...baseConfig.android,
      package: variant.applicationId,
      usesCleartextTraffic: variantName === 'development',
    },
    extra: {
      ...baseConfig.extra,
      variant: variantName,
      taskStatusWidgetsEnabled,
      carPlayEnabled,
      featureFlags,
      // Compatibility for v0.0.32: keep the old Expo extra available to N-1 JS bundles.
      cloudRelayEnabled: featureFlags.officialAccount,
      ...(cloudEnvironment ? { cloudEnvironment } : {}),
      ...(cloudEnvironment && variantName !== 'production' ? { cloudServiceOrigin: cloudEnvironment.serviceOrigin } : {}),
    },
  };
};

// The registered staging environment carries the test domains, so a staging build
// needs no environment variables. An explicit HTTPS origin still overrides it for
// ad-hoc clouds, and production ignores overrides entirely.
function resolveCloudEnvironmentForVariant(variantName) {
  if (variantName === 'production') return CLOUD_ENVIRONMENTS.production;
  if (variantName === 'staging') {
    const override = process.env.TASK_HANDOFF_CLOUD_STAGING_ORIGIN;
    if (!override) return CLOUD_ENVIRONMENTS.staging;
    const url = new URL(override);
    if (url.protocol !== 'https:') throw new Error('TASK_HANDOFF_CLOUD_STAGING_ORIGIN must use HTTPS');
    return cloudEnvironmentForServiceOrigin(url.origin);
  }
  const developmentOrigin = process.env.TASK_HANDOFF_CLOUD_DEVELOPMENT_ORIGIN;
  return developmentOrigin ? cloudEnvironmentForServiceOrigin(new URL(developmentOrigin).origin) : undefined;
}
