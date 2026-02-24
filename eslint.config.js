import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import stylistic from '@stylistic/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

const restrictTemplateExpressionsRule = [
  'error',
  {
    allowAny: false,
    allowArray: false,
    allowBoolean: true,
    allowNullish: true,
    allowNumber: true,
    allowRegExp: false,
  },
];

export default defineConfig(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      // 基础规则
      'no-console': 'off', // 允许 console（日志系统需要）
      'no-unused-vars': 'off', // 关闭 JS 规则，使用 TS 规则
      'no-shadow': 'off', // 关闭 JS 规则，使用 TS 规则
      'no-use-before-define': 'off', // 关闭 JS 规则，使用 TS 规则
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/class-methods-use-this': 'error',
      '@typescript-eslint/member-ordering': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-void-return': 'error',
      '@typescript-eslint/consistent-return': 'error',
      '@typescript-eslint/max-params': [
        'error',
        {
          max: 7,
          countVoidThis: true,
        },
      ],
      '@typescript-eslint/no-use-before-define': [
        'error',
        {
          functions: false,
          classes: true,
          variables: true,
          typedefs: true,
          enums: true,
        },
      ],

      // TypeScript 规则
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-member-accessibility': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/restrict-template-expressions': restrictTemplateExpressionsRule,
      '@typescript-eslint/require-await': 'error',
      // 项目规范要求优先使用 ReadonlyArray/type，关闭与之冲突的 stylistic 规则
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/consistent-generic-constructors': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-dupe-class-members': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-invalid-this': 'error',
      '@typescript-eslint/no-loop-func': 'error',
      '@typescript-eslint/no-redeclare': 'error',
      '@typescript-eslint/no-unnecessary-parameter-property-assignment': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unused-private-class-members': 'error',
      'no-unused-private-class-members': 'off',
      '@typescript-eslint/no-useless-empty-export': 'error',
      '@typescript-eslint/prefer-enum-initializers': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/method-signature-style': 'error',

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
      'default-case': 'error',
      'default-case-last': 'error',
      'default-param-last': 'off',
      'consistent-return': 'off',
      // 保持 async 方法的 Promise 契约与调用时序，不强制要求函数体内出现 await
      'require-await': 'off',
      'max-params': 'off',
      'max-depth': ['warn', { max: 5 }],

      // 调试与全局
      'no-debugger': 'warn',
      'no-global-assign': 'error',
      'no-caller': 'error',

      // 对象与数组
      'no-dupe-keys': 'error',
      'no-object-constructor': 'error',
      'array-callback-return': 'error',
      'no-return-assign': ['error', 'always'],

      // 正则与字符
      'no-empty-character-class': 'error',
      'no-misleading-character-class': 'error',
      'no-extra-boolean-cast': 'error',
      'no-irregular-whitespace': 'error',

      // 作用域与命名
      'no-invalid-this': 'off',
      'no-shadow-restricted-names': 'error',
      'no-inner-declarations': ['error', 'both'],
      'no-labels': 'error',

      // 数字与 new
      'no-loss-of-precision': 'error',
      'no-new': 'error',

      // 注释与格式
      '@stylistic/spaced-comment': 'error',
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme'], location: 'anywhere' }],

      // 明确要求关闭
      'sonarjs/cognitive-complexity': 'off',
      // 避免与 ESLint / @typescript-eslint 同名规则重复报错
      'sonarjs/no-unused-vars': 'off',
      'sonarjs/no-labels': 'off',
      'sonarjs/no-fallthrough': 'off',
      'no-duplicate-imports': 'error',
      'no-nested-ternary': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'warn',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // 测试桩中允许空函数与 async 透传，避免无效噪音
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
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
