const tailwindConfig = require("./tailwind.config.cjs");

module.exports = {
  plugins: {
    tailwindcss: tailwindConfig,
    autoprefixer: {},
  },
};
