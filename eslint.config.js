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
        'error',
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

      // 变量与赋值
      'no-var': 'error',
      'no-const-assign': 'error',
      'no-import-assign': 'error',

      // 相等与类型
      eqeqeq: ['error', 'always'],
      'no-implicit-coercion': 'error',

      // 循环与控制流
      'for-direction': 'error',
      'no-dupe-else-if': 'error',
      'no-empty': 'error',
      'no-empty-pattern': 'error',
      'default-case-last': 'error',

      // 调试与全局
      'no-debugger': 'warn',
      'no-global-assign': 'error',
      'no-caller': 'error',

      // 对象与数组
      'no-dupe-keys': 'error',
      'no-new-object': 'error',
      'array-callback-return': 'error',
      'no-return-assign': ['error', 'always'],

      // 正则与字符
      'no-empty-character-class': 'error',
      'no-misleading-character-class': 'error',
      'no-extra-boolean-cast': 'error',
      'no-irregular-whitespace': 'error',

      // 作用域与命名
      'no-invalid-this': 'error',
      'no-shadow-restricted-names': 'error',
      'no-inner-declarations': ['error', 'both'],
      'no-labels': 'error',

      // 数字与 new
      'no-loss-of-precision': 'error',
      'no-new': 'error',

      // 注释与格式
      'spaced-comment': 'error',
      'no-multiple-empty-lines': 'error',
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme'], location: 'anywhere' }],

      // 最佳实践
      'no-duplicate-imports': 'error',
      'no-nested-ternary': 'error',
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
