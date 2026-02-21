import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

export default defineConfig(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // 基础规则
      'no-console': 'off', // 允许 console（日志系统需要）
      'no-unused-vars': 'off', // 关闭 JS 规则，使用 TS 规则
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // TypeScript 规则
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',

      // 最佳实践
      'no-var': 'error',
      'prefer-const': 'warn',
      'prefer-arrow-callback': 'warn',
    },
  },
  eslintConfigPrettier,
  {
    ignores: [
      'dist/**',
      'benchmark/**',
      'node_modules/**',
      'logs/**',
      'utils/**',
      '*.config.js',
      'tools/**',
      'scripts/**',
      '.worktrees/**',
      '.claude/**',
    ],
  },
);
