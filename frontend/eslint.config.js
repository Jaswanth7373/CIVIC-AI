/**
 * ESLint flat config for the CivicAI frontend.
 * - @eslint/js recommended rules for all JS / JSX.
 * - react-hooks: rules of hooks + exhaustive deps (also checked for our `useApi(fetcher, deps)` hook).
 * - react-refresh (Vite preset): component files may only export components, so Fast Refresh keeps state.
 * - Browser globals for the app, service-worker globals for public/sw.js, Node globals for config files.
 */
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default defineConfig([
  globalIgnores(['dist', 'dev-dist', 'coverage', 'node_modules']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [js.configs.recommended, reactHooks.configs['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // ESLint 9 core does not mark identifiers that are only used in JSX (<Icon />, <motion.div>,
      // `({ as: Component })`) as used, so PascalCase names and `motion` are exempt; every other unused
      // variable or argument is still an error.
      'no-unused-vars': [
        'error',
        { varsIgnorePattern: '^(?:[A-Z_]|motion$)', argsIgnorePattern: '^(?:_|[A-Z])', ignoreRestSiblings: true },
      ],
      'react-hooks/exhaustive-deps': ['warn', { additionalHooks: '(useApi)' }],
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } },
  },
  {
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
])
