/**
 * ESLint 本地规则架构测试
 *
 * 覆盖本地 ESLint plugin 的规则注册、src 类型组织约束与测试目录豁免。
 */
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

async function lintText(relativeFilePath: string, code: string) {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfig: {
      languageOptions: {
        parserOptions: {
          projectService: {
            allowDefaultProject: ['src/core/strategy/types.d.ts', 'src/types/probe.d.ts'],
          },
        },
      },
    },
  });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(process.cwd(), relativeFilePath),
  });

  return result?.messages ?? [];
}

function hasRuleMessage(messages: Awaited<ReturnType<typeof lintText>>, ruleId: string): boolean {
  return messages.some((message) => message.ruleId === ruleId);
}

describe('local ESLint rules', () => {
  it('rejects named import aliases in src files', async () => {
    const messages = await lintText(
      'src/core/utils.ts',
      "import { foo as bar } from './foo.js';\nvoid bar;\n",
    );

    expect(hasRuleMessage(messages, 'local/no-import-alias')).toBe(true);
  });

  it('allows named imports without aliases in src files', async () => {
    const messages = await lintText(
      'src/core/utils.ts',
      "import { foo } from './foo.js';\nvoid foo;\n",
    );

    expect(hasRuleMessage(messages, 'local/no-import-alias')).toBe(false);
  });

  it('keeps named import aliases allowed in tests', async () => {
    const messages = await lintText(
      'tests/probe.test.ts',
      "import { foo as bar } from './foo.js';\nvoid bar;\n",
    );

    expect(hasRuleMessage(messages, 'local/no-import-alias')).toBe(false);
  });

  it('rejects type declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/core/riskController/dailyLossTracker.ts',
      "type Probe = { readonly id: string };\nconst probe: Probe = { id: '1' };\nvoid probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects interface declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/core/riskController/dailyLossTracker.ts',
      "interface Probe { readonly id: string }\nconst probe: Probe = { id: '1' };\nvoid probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects module declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/core/riskController/dailyLossTracker.ts',
      'declare namespace Probe {}\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects ambient function declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/core/riskController/dailyLossTracker.ts',
      'declare function probe(): void;\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects ambient variable declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/core/riskController/dailyLossTracker.ts',
      'declare const probe: string;\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('allows type and interface declarations in adjacent types files', async () => {
    const messages = await lintText(
      'src/core/strategy/types.ts',
      'export type Probe = { readonly id: string };\nexport interface Runner { run(): void }\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(false);
  });

  it('allows type declarations in src types directory', async () => {
    const messages = await lintText(
      'src/types/queue.ts',
      'export type Probe = { readonly id: string };\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(false);
  });

  it('rejects declaration files as type location exceptions', async () => {
    const messages = await lintText(
      'src/core/strategy/types.d.ts',
      'interface Probe { readonly id: string }\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects src types directory declaration files as type location exceptions', async () => {
    const messages = await lintText(
      'src/types/probe.d.ts',
      'interface Probe { readonly id: string }\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects enums in src implementation files', async () => {
    const messages = await lintText(
      'src/core/riskController/dailyLossTracker.ts',
      "enum Probe { A = 'a' }\nexport type ProbeValue = Probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects enums anywhere under src', async () => {
    const messages = await lintText(
      'src/core/strategy/types.ts',
      "enum Probe { A = 'a' }\nexport type ProbeValue = Probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('does not restrict type declarations in tests', async () => {
    const messages = await lintText(
      'tests/probe.test.ts',
      'type Probe = { readonly id: string };\ninterface Runner { run(): void }\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(false);
  });

  it('allows import type and type declarations in types files', async () => {
    const messages = await lintText(
      'src/core/strategy/types.ts',
      "import type { Foo } from './foo.js';\nexport type Probe = Foo;\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(false);
  });

  it('rejects value imports in types files', async () => {
    const messages = await lintText(
      'src/core/strategy/types.ts',
      "import { foo } from './foo.js';\nexport type Probe = { readonly id: string };\nvoid foo;\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects side-effect imports in types files', async () => {
    const messages = await lintText(
      'src/core/strategy/types.ts',
      "import './setup.js';\nexport type Probe = { readonly id: string };\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects constants in types files', async () => {
    const messages = await lintText('src/core/strategy/types.ts', "export const probe = '1';\n");

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects functions in types files', async () => {
    const messages = await lintText(
      'src/core/strategy/types.ts',
      'export function probe(): void {}\n',
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects classes in types files', async () => {
    const messages = await lintText('src/core/strategy/types.ts', 'export class Probe {}\n');

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects module declarations in types files', async () => {
    const messages = await lintText('src/core/strategy/types.ts', 'declare namespace Probe {}\n');

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects export all declarations in types files', async () => {
    const messages = await lintText('src/core/strategy/types.ts', "export * from './foo.js';\n");

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects value export specifiers in types files', async () => {
    const messages = await lintText(
      'src/core/strategy/types.ts',
      "export { foo } from './foo.js';\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects type re-export specifiers in types files', async () => {
    const messages = await lintText(
      'src/core/strategy/types.ts',
      "export type { Foo } from './foo.js';\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects control flow statements in types files', async () => {
    const messages = await lintText('src/core/strategy/types.ts', 'if (true) {}\n');

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('does not restrict runtime code in test types files', async () => {
    const messages = await lintText('tests/helpers/types.ts', "export const probe = '1';\n");

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(false);
  });

  it('rejects type declarations in src utils files', async () => {
    const messages = await lintText(
      'src/core/strategy/utils.ts',
      "type Probe = { readonly id: string };\nconst probe: Probe = { id: '1' };\nvoid probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(true);
  });

  it('rejects interface declarations in src utils files', async () => {
    const messages = await lintText(
      'src/core/strategy/utils.ts',
      "interface Probe { readonly id: string }\nconst probe: Probe = { id: '1' };\nvoid probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(true);
  });

  it('rejects ambient function declarations in src utils files', async () => {
    const messages = await lintText(
      'src/core/strategy/utils.ts',
      'declare function probe(): void;\n',
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(true);
  });

  it('rejects ambient variable declarations in src utils files', async () => {
    const messages = await lintText('src/core/strategy/utils.ts', 'declare const probe: string;\n');

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(true);
  });

  it('allows import type and type annotations in src utils files', async () => {
    const messages = await lintText(
      'src/core/strategy/utils.ts',
      "import type { Probe } from './types.js';\nexport function normalizeProbe(probe: Probe): Probe {\n  return probe;\n}\n",
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(false);
  });

  it('does not restrict type declarations in test utils files', async () => {
    const messages = await lintText(
      'tests/helpers/utils.ts',
      'type Probe = { readonly id: string };\ninterface Runner { run(): void }\n',
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(false);
  });
});
