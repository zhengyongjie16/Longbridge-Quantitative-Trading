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

function getNormalizedFilename(context) {
  return (context.filename ?? context.physicalFilename).replaceAll('\\', '/');
}

function isSrcFile(filename) {
  return filename.includes('/src/') && filename.endsWith('.ts');
}

function isTypesFile(filename) {
  return filename.endsWith('/types.ts') || filename.includes('/src/types/');
}

function isUtilsFile(filename) {
  return filename.endsWith('/utils.ts');
}

function isDeclarationFile(filename) {
  return filename.endsWith('.d.ts');
}

function reportNode(context, node, messageId) {
  context.report({
    node,
    messageId,
  });
}

const typeDefinitionsLocationRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      invalidTypeLocation: '类型定义只能放在 src/types 或相邻 types.ts 中，且禁止 .d.ts 与 enum。',
    },
  },
  create(context) {
    const filename = getNormalizedFilename(context);
    if (!isSrcFile(filename)) {
      return {};
    }

    const isAllowedTypeLocation = isTypesFile(filename) && !isDeclarationFile(filename);

    return {
      TSEnumDeclaration(node) {
        reportNode(context, node, 'invalidTypeLocation');
      },
      TSInterfaceDeclaration(node) {
        if (!isAllowedTypeLocation) {
          reportNode(context, node, 'invalidTypeLocation');
        }
      },
      TSModuleDeclaration(node) {
        reportNode(context, node, 'invalidTypeLocation');
      },
      TSTypeAliasDeclaration(node) {
        if (!isAllowedTypeLocation) {
          reportNode(context, node, 'invalidTypeLocation');
        }
      },
      TSDeclareFunction(node) {
        reportNode(context, node, 'invalidTypeLocation');
      },
      VariableDeclaration(node) {
        if (node.declare === true) {
          reportNode(context, node, 'invalidTypeLocation');
        }
      },
    };
  },
};

const typesFileOnlyTypesRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      runtimeInTypesFile: 'types.ts 只能包含 import type、type 与 interface 定义。',
    },
  },
  create(context) {
    const filename = getNormalizedFilename(context);
    if (!isSrcFile(filename) || !isTypesFile(filename)) {
      return {};
    }

    function reportRuntimeNode(node) {
      reportNode(context, node, 'runtimeInTypesFile');
    }

    return {
      ExportAllDeclaration: reportRuntimeNode,
      ExportNamedDeclaration(node) {
        if (
          node.source === null &&
          (node.declaration?.type === 'TSTypeAliasDeclaration' ||
            node.declaration?.type === 'TSInterfaceDeclaration')
        ) {
          return;
        }

        reportRuntimeNode(node);
      },
      ImportDeclaration(node) {
        if (node.importKind === 'type') {
          return;
        }

        reportRuntimeNode(node);
      },
      Program(node) {
        for (const statement of node.body) {
          if (
            statement.type === 'ImportDeclaration' ||
            statement.type === 'ExportNamedDeclaration' ||
            statement.type === 'TSTypeAliasDeclaration' ||
            statement.type === 'TSInterfaceDeclaration'
          ) {
            continue;
          }

          reportRuntimeNode(statement);
        }
      },
    };
  },
};

const utilsFileNoTypesRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      typeInUtilsFile: 'utils.ts 只能包含工具函数实现，不能定义类型。',
    },
  },
  create(context) {
    const filename = getNormalizedFilename(context);
    if (!isSrcFile(filename) || !isUtilsFile(filename)) {
      return {};
    }

    return {
      TSDeclareFunction(node) {
        reportNode(context, node, 'typeInUtilsFile');
      },
      TSInterfaceDeclaration(node) {
        reportNode(context, node, 'typeInUtilsFile');
      },
      TSModuleDeclaration(node) {
        reportNode(context, node, 'typeInUtilsFile');
      },
      TSTypeAliasDeclaration(node) {
        reportNode(context, node, 'typeInUtilsFile');
      },
      VariableDeclaration(node) {
        if (node.declare === true) {
          reportNode(context, node, 'typeInUtilsFile');
        }
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
          'type-definitions-location': typeDefinitionsLocationRule,
          'types-file-only-types': typesFileOnlyTypesRule,
          'utils-file-no-types': utilsFileNoTypesRule,
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
      'local/type-definitions-location': 'error',
      'local/types-file-only-types': 'error',
      'local/utils-file-no-types': 'error',

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
    files: ['src/**/*.ts'],
    rules: {
      'unicorn/consistent-function-scoping': [
        'error',
        {
          checkArrowFunctions: true,
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'tools/**/*.ts'],
    rules: {
      // 测试和工具文件统一放宽部分规则，减少实现噪音
      'unicorn/consistent-function-scoping': 'off',
      'local/no-import-alias': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'sonarjs/void-use': 'off',
    },
  },
  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../app/*',
                '../../app/*',
                '../../../app/*',
                '../../../../app/*',
                '../../../../../app/*',
              ],
              message: 'main 层不得反向依赖 app 层',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../app/*',
                '../../app/*',
                '../../../app/*',
                '../../../../app/*',
                '../../../../../app/*',
              ],
              message: 'services 层不得反向依赖 app 层',
            },
            {
              group: [
                '../main/*',
                '../../main/*',
                '../../../main/*',
                '../../../../main/*',
                '../../../../../main/*',
              ],
              message: 'services 层不得依赖 main 层',
            },
            {
              regex: String.raw`^(?:\.\./)+core/(?!strategy/types\.js$).+`,
              message: 'services 层不得依赖 core 层',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/config/**/*.ts', 'src/utils/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../app/*',
                '../../app/*',
                '../../../app/*',
                '../../../../app/*',
                '../../../../../app/*',
              ],
              message: '下层模块不得反向依赖 app 层',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../app/*',
                '../../app/*',
                '../../../app/*',
                '../../../../app/*',
                '../../../../../app/*',
              ],
              message: '下层模块不得反向依赖 app 层',
            },
            {
              group: [
                '../services/*',
                '../../services/*',
                '../../../services/*',
                '../../../../services/*',
                '../../../../../services/*',
              ],
              message: 'types 层不得依赖 services 层',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            './app/*',
            '!./app/runApp.js',
            './config/*',
            './constants/*',
            './core/*',
            './main/*',
            './services/*',
            './types/*',
            './utils/*',
            '!./utils/error/index.js',
            '!./utils/logger/index.js',
          ],
        },
      ],
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
        // if 语句前：仅当前一条是多行表达式/多行块状语句时才强制空行（块顶部的 if 不会触发）
        { blankLine: 'always', prev: 'multiline-expression', next: 'if' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'if' },
        // if 语句后必须有空行（块尾部的 if 不会触发）
        { blankLine: 'always', prev: 'if', next: '*' },
        // for / while / do / switch / try 前：仅当上一条是多行表达式/多行块状语句时才强制空行（块顶部不触发）
        { blankLine: 'always', prev: 'multiline-expression', next: 'for' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'for' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'while' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'while' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'do' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'do' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'switch' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'switch' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'try' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'try' },
        // for / while / do / switch / try 后必须有空行（块尾部不触发）
        { blankLine: 'always', prev: 'for', next: '*' },
        { blankLine: 'always', prev: 'while', next: '*' },
        { blankLine: 'always', prev: 'do', next: '*' },
        { blankLine: 'always', prev: 'switch', next: '*' },
        { blankLine: 'always', prev: 'try', next: '*' },
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
