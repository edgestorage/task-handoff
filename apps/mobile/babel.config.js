module.exports = function babelConfig(api) {
  api.cache(true);

  return {
    presets: ['expo/internal/babel-preset'],
  };
};
