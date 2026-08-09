const baseConfig = require('./app.json').expo;

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
};

module.exports = () => {
  const variantName = process.env.TASK_HANDOFF_MOBILE_VARIANT || 'development';
  const variant = variants[variantName];
  if (!variant) {
    throw new Error(`Unsupported TASK_HANDOFF_MOBILE_VARIANT: ${variantName}`);
  }
  const taskStatusWidgetsEnabled = process.env.TASK_HANDOFF_WIDGETS_ENABLED !== '0';
  const carPlayEnabled = variantName === 'development' && process.env.TASK_HANDOFF_CARPLAY_ENABLED === '1';
  const easProjectId = process.env.EXPO_PROJECT_ID || baseConfig.extra?.eas?.projectId;
  const plugins = [
    ...(baseConfig.plugins || []),
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
      ...(easProjectId ? { eas: { ...baseConfig.extra?.eas, projectId: easProjectId } } : {}),
    },
  };
};
