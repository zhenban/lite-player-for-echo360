// ESLint for the Worker (modules), the tests and dev scripts (Node), and the page script
// (linted as the one bundle build-assets.mjs makes, since its files share one scope).
import globals from 'globals';
import js from '@eslint/js';

const rules = {
  'no-shadow': ['error', { builtinGlobals: false }],
  'no-unused-vars': ['error', { vars: 'all', args: 'none', caughtErrors: 'none' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  { ignores: ['node_modules/', '.wrangler/', 'src/assets.gen.js', 'src/page/'] },
  js.configs.recommended,
  { files: ['src/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.serviceworker } }, rules },
  { files: ['test/**/*.mjs', 'dev/**/*.mjs', '*.mjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } }, rules },
  { files: ['dev/out/page.bundle.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } }, rules },
];
