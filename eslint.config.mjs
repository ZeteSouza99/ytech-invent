import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules/**', 'android/**', 'ios/**', 'dist/**', '.expo/**', '.tools/**', '.gradle/**', '.cxx/**', 'artifacts/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser, __DEV__: 'readonly' } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['plugins/**/*.cjs', 'metro.config.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
