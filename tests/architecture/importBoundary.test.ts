/**
 * import boundary 架构测试
 *
 * 覆盖：
 * - types 层不得依赖 services 层
 * - services 层不得依赖 core 层
 * - services 层允许依赖定义好的策略类型路径
 */
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

async function lintText(relativeFilePath: string, code: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(process.cwd(), relativeFilePath),
  });

  return result?.messages ?? [];
}

describe('architecture import boundaries', () => {
  it('rejects imports from src/types to src/services', async () => {
    const messages = await lintText(
      'src/types/state.ts',
      "import type { MarketMonitor } from '../services/marketMonitor/types.js';\nexport type Probe = MarketMonitor;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
    expect(
      messages.some((message) => message.message.includes('types 层不得依赖 services 层')),
    ).toBe(true);
  });

  it('rejects imports from src/services to src/core except allowed ports', async () => {
    const messages = await lintText(
      'src/services/autoSymbolManager/utils.ts',
      "import { createRiskChecker } from '../core/riskController/index.js';\nvoid createRiskChecker;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
    expect(
      messages.some((message) => message.message.includes('services 层不得依赖 core 层')),
    ).toBe(true);
  });

  it('allows services imports from the defined strategy type path', async () => {
    const messages = await lintText(
      'src/services/autoSymbolManager/utils.ts',
      "import type { TradingSignalStrategy } from '../core/strategy/types.js';\nexport type Probe = TradingSignalStrategy;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
  });
});
