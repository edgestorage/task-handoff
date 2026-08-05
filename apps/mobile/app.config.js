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

  return {
    ...baseConfig,
    name: variant.name,
    scheme: variant.scheme,
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
    },
  };
};
