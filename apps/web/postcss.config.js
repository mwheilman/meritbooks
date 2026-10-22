// postcss-import first: globals.css imports the kit CSS between Tailwind's layers
// (packages/merit-ui/README.md "Wiring an app" §2). The legacy bridge stylesheet
// picks its own Tailwind config with `@config` (see src/styles/legacy-bridge.css).
module.exports = {
  plugins: {
    'postcss-import': {},
    tailwindcss: {},
    autoprefixer: {},
  },
};
