import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import eslintPluginStylistic from '@stylistic/eslint-plugin';
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

const noImportAliasRule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      forbiddenAlias: "不允许重命名导入: '{{imported}} as {{local}}'",
    },
  },
  create(context) {
    return {
      ImportSpecifier(node) {
        const imported =
          node.imported.type === 'Identifier' ? node.imported.name : String(node.imported.value);
        const local = node.local.name;

        if (imported === local) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenAlias',
          data: {
            imported,
            local,
          },
        });
      },
    };
  },
};

export default defineConfig(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  eslintPluginUnicorn.configs.recommended,
  {
    plugins: {
      '@stylistic': eslintPluginStylistic,
      local: {
        rules: {
          'no-import-alias': noImportAliasRule,
        },
      },
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
      '@typescript-eslint/await-thenable': 'error',
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
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'max-depth': ['error', { max: 5 }],

      // 调试与全局
      'no-debugger': 'error',
      'no-caller': 'error',

      // 注释与代码卫生
      'no-warning-comments': ['error', { terms: ['todo', 'fixme'], location: 'anywhere' }],

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
      'prefer-arrow-callback': 'error',
      'local/no-import-alias': 'error',

      // Unicorn 规则兼容性调整
      'unicorn/prefer-string-slice': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/numeric-separators-style': 'off',
      'unicorn/catch-error-name': 'off',
      'unicorn/no-null': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/prefer-switch': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/no-array-sort': 'off',

      // 索引访问表达优化
      'unicorn/prefer-at': [
        'error',
        {
          checkAllIndexAccess: false,
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // 测试文件统一放宽部分规则，减少测试实现噪音
      'local/no-import-alias': 'off',
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
    // 以下规则须在 Prettier 之后以覆盖其对该规则的关闭
    rules: {
      '@stylistic/lines-around-comment': [
        'error',
        {
          // 行注释（//）上方不强制空行
          beforeLineComment: false,
          // 行注释下方不强制空行
          afterLineComment: false,
          // 块注释（/* */、/** */）上方需空行
          beforeBlockComment: true,
          // 块注释下方不强制空行
          afterBlockComment: false,
          // 块/函数体/switch 等开头处的注释上方无需空行
          allowBlockStart: true,
          // interface 体开头处的注释上方无需空行
          allowInterfaceStart: true,
          // 对象字面量/解构开头处的注释上方无需空行
          allowObjectStart: true,
          // class 体开头处的注释上方无需空行
          allowClassStart: true,
          // 类型字面体（type X = { ... }）开头处的注释上方无需空行
          allowTypeStart: true,
        },
      ],
      '@stylistic/padding-line-between-statements': [
        'error',
        // import 与顶层其他语句之间必须有空行
        { blankLine: 'always', prev: 'import', next: '*' },
        // 相邻 import 之间不强制空行
        { blankLine: 'any', prev: 'import', next: 'import' },
        // block-like 之间（如 function 与 function）必须有空行
        { blankLine: 'always', prev: 'block-like', next: 'block-like' },
        // 多行表达式之间（如 it 与 it）必须有空行
        { blankLine: 'always', prev: 'multiline-expression', next: 'multiline-expression' },
      ],
    },
  },
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
