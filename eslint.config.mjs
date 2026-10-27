import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules/**', 'android/**', 'ios/**', 'dist/**', '.expo/**', '.tools/**', '.gradle/**', '.cxx/**', 'artifacts/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser, __DEV__: 'readonly' } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json', './tsconfig.server.json', './tsconfig.test.json'], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Most of the app is asynchronous: a forgotten await or an unhandled rejection is a silent failure.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['plugins/**/*.cjs', 'metro.config.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
