module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  extends: ['eslint:recommended'],
  ignorePatterns: ['out/', 'release/', 'node_modules/', '*.config.ts', '*.cjs'],
  rules: {
    'no-unused-vars': 'off', // handled by tsc noUnusedLocals
    'no-undef': 'off', // handled by tsc
  },
};
