import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
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
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  {
    plugins: {
      unicorn: eslintPluginUnicorn,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // 基础可靠性
      // 允许 console（日志系统需要）
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-void-return': 'error',
      '@typescript-eslint/consistent-return': 'error',
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

      // TypeScript 语义与边界
      '@typescript-eslint/explicit-member-accessibility': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: true,
        },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/restrict-template-expressions': restrictTemplateExpressionsRule,
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-useless-empty-export': 'error',

      // 项目规范对齐（关闭与规范冲突的 stylistic/风格规则）
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/consistent-generic-constructors': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',

      // TypeScript 额外质量约束
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/no-dupe-class-members': 'error',
      '@typescript-eslint/no-invalid-this': 'error',
      '@typescript-eslint/no-loop-func': 'error',
      '@typescript-eslint/no-redeclare': 'error',
      '@typescript-eslint/no-unnecessary-parameter-property-assignment': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unused-private-class-members': 'error',
      '@typescript-eslint/prefer-enum-initializers': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/method-signature-style': 'error',
      '@typescript-eslint/class-methods-use-this': 'error',
      '@typescript-eslint/member-ordering': 'error',
      '@typescript-eslint/max-params': [
        'error',
        {
          max: 7,
          countVoidThis: true,
        },
      ],

      // 变量与赋值
      'no-const-assign': 'error',
      'no-import-assign': 'error',
      eqeqeq: ['error', 'always'],
      'no-implicit-coercion': 'error',

      // 循环与控制流
      'default-case': 'error',
      'default-case-last': 'error',
      'max-depth': ['warn', { max: 5 }],

      // 调试与全局
      'no-debugger': 'warn',
      'no-caller': 'error',

      // 注释与代码卫生
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme'], location: 'anywhere' }],

      // 对象与数组
      'no-dupe-keys': 'error',
      'no-object-constructor': 'error',
      'array-callback-return': 'error',
      'no-return-assign': ['error', 'always'],

      // 作用域与命名
      'no-inner-declarations': ['error', 'both'],
      'no-labels': 'error',

      // new 语法约束
      'no-new': 'error',

      // SonarJS 策略调整
      'sonarjs/cognitive-complexity': 'off',

      // ESLint 与 @typescript-eslint 同名规则冲突消解
      'no-unused-private-class-members': 'off',

      // SonarJS 冲突消解（避免与 ESLint / @typescript-eslint 重复报错）
      'sonarjs/no-unused-vars': 'off',
      'sonarjs/no-labels': 'off',
      'sonarjs/no-fallthrough': 'off',

      // 项目风格约束
      'no-duplicate-imports': 'error',
      'no-nested-ternary': 'error',
      'prefer-arrow-callback': 'warn',

      // 索引访问表达优化
      'unicorn/prefer-at': [
        'error',
        {
          checkAllIndexAccess: false,
        },
      ],
      'unicorn/prefer-negative-index': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // 测试文件统一放宽部分规则，减少测试实现噪音
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
      // 构建与依赖产物
      'dist/**',
      'benchmark/**',
      'node_modules/**',

      // 运行日志
      'logs/**',

      // 脚本目录
      'utils/**',
      '*.config.js',
      'scripts/**',

      // 工作目录
      '.worktrees/**',
      '.claude/**',
    ],
  },
);
