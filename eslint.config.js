import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dev-dist/**', '**/node_modules/**', '**/test-results/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  {
    // packages/core must stay free of platform APIs (docs/IMPLEMENTATION_PLAN.md §3).
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'fs', 'path', 'better-sqlite3'] }],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage', 'process'],
    },
  },
);
