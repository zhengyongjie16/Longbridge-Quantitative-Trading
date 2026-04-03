/**
 * 类型组织架构测试
 *
 * 覆盖：
 * - 本次专项治理的硬违规文件不再在实现文件中声明命名类型
 * - strategy 契约类型整合到 core/strategy/types.ts
 * - 本次触达的 types.ts 保持纯类型文件
 * - 本次触达的 utils.ts 不再定义 type/interface
 */
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';

const projectRoot = process.cwd();

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(projectRoot, relativePath), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getRelevantLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('/*') &&
        !line.startsWith('*/') &&
        !line.startsWith('*') &&
        !line.startsWith('//'),
    );
}

describe('type organization regressions', () => {
  it('keeps named type declarations out of the scoped implementation files', async () => {
    const fileChecks: ReadonlyArray<{
      readonly relativePath: string;
      readonly forbiddenPatterns: ReadonlyArray<RegExp>;
    }> = [
      {
        relativePath: 'src/services/quoteClient/candlestickCache.ts',
        forbiddenPatterns: [
          /\btype\s+CandlestickCacheStore\b/,
          /\btype\s+SeedCandlestickSeriesParams\b/,
          /\btype\s+ApplyCandlestickPushParams\b/,
          /\btype\s+NormalizedCandleValue\b/,
        ],
      },
      {
        relativePath: 'src/services/indicators/runtime/index.ts',
        forbiddenPatterns: [/\btype\s+IndicatorRuntimeState\b/],
      },
      {
        relativePath: 'src/main/asyncProgram/monitorTaskProcessor/utils.ts',
        forbiddenPatterns: [/\btype\s+MonitorContextAndSeatReadiness\b/],
      },
      {
        relativePath: 'src/main/asyncProgram/monitorTaskProcessor/index.ts',
        forbiddenPatterns: [/\btype\s+RetryRegistryEntry\b/],
      },
      {
        relativePath: 'src/main/asyncProgram/sellProcessor/index.ts',
        forbiddenPatterns: [/\btype\s+SellRetryState\b/],
      },
    ];

    for (const fileCheck of fileChecks) {
      const source = await readProjectFile(fileCheck.relativePath);
      for (const forbiddenPattern of fileCheck.forbiddenPatterns) {
        expect(source).not.toMatch(forbiddenPattern);
      }
    }
  });

  it('stores strategy contracts in core/strategy/types.ts and keeps legacy ports path removed', async () => {
    const strategyTypesSource = await readProjectFile('src/core/strategy/types.ts');

    expect(strategyTypesSource).toMatch(/export\s+interface\s+TradingSignalStrategy\b/);
    expect(strategyTypesSource).toMatch(/export\s+type\s+TradingSignalStrategyFactory\b/);
    expect(await exists('src/core/strategy/ports.ts')).toBe(false);
  });

  it('keeps scoped types.ts files free of runtime declarations', async () => {
    const scopedTypeFiles = [
      'src/core/strategy/types.ts',
      'src/services/quoteClient/types.ts',
      'src/services/indicators/runtime/types.ts',
      'src/main/asyncProgram/monitorTaskProcessor/types.ts',
      'src/main/asyncProgram/sellProcessor/types.ts',
    ] as const;

    for (const relativePath of scopedTypeFiles) {
      const relevantLines = getRelevantLines(await readProjectFile(relativePath));
      expect(
        relevantLines.some(
          (line) => line.startsWith('import ') && !line.startsWith('import type '),
        ),
      ).toBe(false);

      expect(
        relevantLines.some(
          (line) =>
            line.startsWith('const ') ||
            line.startsWith('function ') ||
            line.startsWith('class ') ||
            line.startsWith('enum ') ||
            line.startsWith('export const ') ||
            line.startsWith('export function ') ||
            line.startsWith('export class ') ||
            line.startsWith('export enum '),
        ),
      ).toBe(false);
    }
  });

  it('keeps scoped utils.ts files free of type declarations', async () => {
    const scopedUtilsFiles = ['src/main/asyncProgram/monitorTaskProcessor/utils.ts'] as const;

    for (const relativePath of scopedUtilsFiles) {
      const relevantLines = getRelevantLines(await readProjectFile(relativePath));
      expect(
        relevantLines.some(
          (line) =>
            line.startsWith('type ') ||
            line.startsWith('interface ') ||
            line.startsWith('export type ') ||
            line.startsWith('export interface '),
        ),
      ).toBe(false);
    }
  });
});
