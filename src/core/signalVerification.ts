/**
 * 延迟信号验证模块
 *
 * 功能：
 * - 管理延迟信号的验证流程
 * - 记录验证期间的指标变化历史
 * - 执行趋势确认（60秒延迟验证）
 *
 * 验证逻辑：
 * - BUYCALL：验证指标的3个时间点值（T0, T0+5s, T0+10s）都大于初始值（上涨趋势）
 * - BUYPUT：验证指标的3个时间点值（T0, T0+5s, T0+10s）都小于初始值（下跌趋势）
 *
 * 验证窗口：
 * - 触发时间前 5 秒到后 15 秒内记录指标值
 * - 验证时分别取3个时间点的值：T0（触发时间）、T0+5s、T0+10s
 * - 每个时间点允许 ±5 秒误差
 * - 每个信号有独立的 verificationHistory 数组
 *
 * 验证指标（可配置）：
 * - K、D、J（KDJ 指标）
 * - MACD、DIF、DEA（MACD 指标）
 */

import { logger } from '../utils/logger.js';
import { verificationEntryPool, signalObjectPool } from '../utils/objectPool.js';
import { getIndicatorValue } from '../utils/indicatorHelpers.js';
import type { IndicatorSnapshot, Quote, Signal, VerificationConfig } from '../types/index.js';

/**
 * 验证历史记录条目
 */
interface VerificationEntry {
  timestamp: Date;
  indicators: Record<string, number>;
}

/**
 * 状态对象接口
 */
interface LastState {
  pendingDelayedSignals?: Signal[];
}

/**
 * 信号验证管理器类
 * 管理延迟信号的验证流程：记录历史、执行验证、清理数据
 */
export class SignalVerificationManager {
  private verificationConfig: VerificationConfig;

  constructor(verificationConfig: VerificationConfig) {
    this.verificationConfig = verificationConfig;
  }

  /**
   * 添加延迟信号到待验证列表
   * @param delayedSignals 延迟信号列表
   * @param lastState 状态对象（包含 pendingDelayedSignals）
   */
  addDelayedSignals(delayedSignals: Signal[], lastState: LastState): void {
    // 初始化待验证信号数组（如果不存在）
    if (!lastState.pendingDelayedSignals) {
      lastState.pendingDelayedSignals = [];
    }

    // 处理延迟验证信号，添加到待验证列表
    for (const delayedSignal of delayedSignals) {
      if (delayedSignal && delayedSignal.triggerTime) {
        // 检查是否已存在相同的待验证信号（避免重复添加）
        const existingSignal = lastState.pendingDelayedSignals.find(
          (s) =>
            s.symbol === delayedSignal.symbol &&
            s.action === delayedSignal.action &&
            s.triggerTime?.getTime() === delayedSignal.triggerTime?.getTime(),
        );

        if (!existingSignal) {
          lastState.pendingDelayedSignals.push(delayedSignal);

          const actionDesc =
            delayedSignal.action === 'BUYCALL'
              ? '买入做多'
              : '买入做空';
          logger.info(
            `[延迟验证信号] 新增待验证${actionDesc}信号：${delayedSignal.symbol} - ${delayedSignal.reason}`,
          );
        } else {
          // 如果信号已存在，释放新的信号对象，避免内存泄漏
          signalObjectPool.release(delayedSignal);
        }
      }
    }
  }

  /**
   * 为所有待验证信号记录当前监控标的值（每秒调用一次）
   * @param monitorSnapshot 监控标的指标快照
   * @param lastState 状态对象（包含 pendingDelayedSignals）
   */
  recordVerificationHistory(monitorSnapshot: IndicatorSnapshot | null, lastState: LastState): void {
    if (
      !monitorSnapshot ||
      !lastState.pendingDelayedSignals ||
      lastState.pendingDelayedSignals.length === 0 ||
      !this.verificationConfig.indicators ||
      this.verificationConfig.indicators.length === 0
    ) {
      return;
    }

    const now = new Date();

    // 提取当前配置的所有指标值
    const currentIndicators: Record<string, number> = {};
    let allIndicatorsValid = true;

    for (const indicatorName of this.verificationConfig.indicators) {
      const value = getIndicatorValue(monitorSnapshot, indicatorName);
      if (value === null || !Number.isFinite(value)) {
        allIndicatorsValid = false;
        break;
      }
      currentIndicators[indicatorName] = value;
    }

    // 为每个待验证信号记录当前值（如果所有配置的指标值有效）
    if (allIndicatorsValid && Object.keys(currentIndicators).length > 0) {
      for (const pendingSignal of lastState.pendingDelayedSignals) {
        if (pendingSignal.triggerTime) {
          const triggerTimeMs = pendingSignal.triggerTime.getTime();
          const windowStart = triggerTimeMs - 5 * 1000; // triggerTime - 5 秒
          const windowEnd = triggerTimeMs + 15 * 1000; // triggerTime + 15 秒（考虑T0+10s时间点±5秒误差）
          const nowMs = now.getTime();

          // 只在 triggerTime -5秒 到 +15秒 窗口内记录数据
          if (nowMs >= windowStart && nowMs <= windowEnd) {
            // 确保信号有历史记录数组
            if (!pendingSignal.verificationHistory) {
              pendingSignal.verificationHistory = [];
            }

            // 避免在同一秒内重复记录（精确到秒）
            const nowSeconds = Math.floor(nowMs / 1000);
            const lastEntry =
              pendingSignal.verificationHistory[
                pendingSignal.verificationHistory.length - 1
              ];
            const lastEntrySeconds = lastEntry
              ? Math.floor(lastEntry.timestamp.getTime() / 1000)
              : null;

            // 如果上一记录不是同一秒，则添加新记录
            if (lastEntrySeconds !== nowSeconds) {
              // 从对象池获取条目对象，减少内存分配
              const entry = verificationEntryPool.acquire() as VerificationEntry;
              entry.timestamp = now;
              // 将所有配置的指标值记录到 indicators 对象中
              entry.indicators = { ...currentIndicators };

              // 记录当前值
              pendingSignal.verificationHistory.push(entry);

              // 只保留当前信号触发时间点前后窗口内的数据，释放其他条目
              const entriesToKeep: VerificationEntry[] = [];
              const entriesToRelease: VerificationEntry[] = [];
              for (const e of pendingSignal.verificationHistory) {
                const t = e.timestamp.getTime();
                if (t >= windowStart && t <= windowEnd) {
                  entriesToKeep.push(e);
                } else {
                  entriesToRelease.push(e);
                }
              }
              if (entriesToRelease.length > 0) {
                verificationEntryPool.releaseAll(entriesToRelease);
              }
              pendingSignal.verificationHistory = entriesToKeep;
            }
          }
        }
      }
    }
  }

  /**
   * 验证所有到期的待验证信号
   * @param lastState 状态对象（包含 pendingDelayedSignals）
   * @param longQuote 做多标的行情
   * @param shortQuote 做空标的行情
   * @returns 验证通过的信号列表
   */
  verifyPendingSignals(
    lastState: LastState,
    longQuote: Quote | null,
    shortQuote: Quote | null,
  ): Signal[] {
    const verifiedSignals: Signal[] = [];

    if (
      !lastState.pendingDelayedSignals ||
      lastState.pendingDelayedSignals.length === 0
    ) {
      return verifiedSignals;
    }

    // 检查是否有待验证的信号到了验证时间
    // 注意：需要等待 triggerTime + 15秒后才验证，确保所有3个时间点（T0, T0+5s, T0+10s）的数据都已记录
    // 考虑到每个时间点允许±5秒误差，T0+10s最晚可能在T0+15秒记录
    const now = new Date();
    const signalsToVerify = lastState.pendingDelayedSignals.filter((s) => {
      if (!s.triggerTime) return false;
      const verificationReadyTime = new Date(s.triggerTime.getTime() + 15 * 1000); // triggerTime + 15秒
      return verificationReadyTime <= now;
    });

    // 处理需要验证的信号
    for (const pendingSignal of signalsToVerify) {
      try {
        const verifiedSignal = this._verifySingleSignal(
          pendingSignal,
          now,
          longQuote,
          shortQuote,
        );

        if (verifiedSignal) {
          verifiedSignals.push(verifiedSignal);
        }

        // 清空该信号的历史记录并释放对象回池
        if (pendingSignal.verificationHistory) {
          verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
          pendingSignal.verificationHistory = [];
        }

        // 从待验证列表中移除（无论验证是否通过）
        const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
        if (index >= 0) {
          lastState.pendingDelayedSignals.splice(index, 1);
        }
        // 释放待验证信号对象回对象池
        signalObjectPool.release(pendingSignal);
      } catch (err) {
        logger.error(
          `[延迟验证错误] 处理待验证信号 ${pendingSignal.symbol} 时发生错误`,
          (err as Error)?.message ?? String(err),
        );
        // 清空该信号的历史记录并释放对象回池
        if (pendingSignal.verificationHistory) {
          verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
          pendingSignal.verificationHistory = [];
        }
        // 从待验证列表中移除错误的信号
        const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
        if (index >= 0) {
          lastState.pendingDelayedSignals.splice(index, 1);
        }
        // 释放待验证信号对象回对象池
        signalObjectPool.release(pendingSignal);
      }
    }

    return verifiedSignals;
  }

  /**
   * 验证单个信号（内部方法）
   * @param pendingSignal 待验证信号
   * @param now 当前时间
   * @param longQuote 做多标的行情
   * @param shortQuote 做空标的行情
   * @returns 验证通过的信号，失败返回 null
   * @private
   */
  private _verifySingleSignal(
    pendingSignal: Signal,
    now: Date,
    longQuote: Quote | null,
    shortQuote: Quote | null,
  ): Signal | null {
    // 安全检查：如果验证指标配置为null或空，跳过验证
    if (
      !this.verificationConfig.indicators ||
      this.verificationConfig.indicators.length === 0
    ) {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 验证指标配置为空，跳过验证`,
      );
      return null;
    }

    // 验证策略更新：从实时监控标的的值获取indicators2
    if (!pendingSignal.triggerTime) {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 缺少triggerTime，跳过验证`,
      );
      return null;
    }

    // 获取indicators1（从信号中获取，触发时已记录）
    const indicators1 = pendingSignal.indicators1;

    if (!indicators1 || typeof indicators1 !== 'object') {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 缺少indicators1，跳过验证`,
      );
      return null;
    }

    // 验证所有配置的指标值是否有效
    let allIndicators1Valid = true;
    for (const indicatorName of this.verificationConfig.indicators) {
      if (!Number.isFinite(indicators1[indicatorName])) {
        allIndicators1Valid = false;
        break;
      }
    }

    if (!allIndicators1Valid) {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} indicators1中存在无效值，跳过验证`,
      );
      return null;
    }

    // 定义3个目标时间点：T0 = triggerTime, T1 = triggerTime + 5秒, T2 = triggerTime + 10秒
    const targetTime0 = pendingSignal.triggerTime;
    const targetTime1 = new Date(targetTime0.getTime() + 5 * 1000);
    const targetTime2 = new Date(targetTime0.getTime() + 10 * 1000);
    const targetTimes = [targetTime0, targetTime1, targetTime2];
    const targetTimeLabels = ['T0', 'T0+5s', 'T0+10s'];

    // 从该信号自己的验证历史记录中获取indicators2a, indicators2b, indicators2c
    const history = pendingSignal.verificationHistory || [];
    const maxTimeDiff = 5 * 1000; // 5秒误差

    // 辅助函数：为指定目标时间查找最佳匹配
    const findBestMatch = (targetTime: Date): VerificationEntry | null => {
      let bestMatch: VerificationEntry | null = null;
      let minTimeDiff = Infinity;

      for (const entry of history) {
        const timeDiff = Math.abs(
          entry.timestamp.getTime() - targetTime.getTime(),
        );
        if (timeDiff <= maxTimeDiff && timeDiff < minTimeDiff) {
          minTimeDiff = timeDiff;
          bestMatch = entry;
        }
      }

      return bestMatch;
    };

    // 为3个时间点分别查找最佳匹配
    const matches: (VerificationEntry | null)[] = [];
    for (let i = 0; i < targetTimes.length; i++) {
      const targetTime = targetTimes[i]!; // 使用非空断言，因为我们知道数组有3个元素
      const targetTimeLabel = targetTimeLabels[i]!;
      const match = findBestMatch(targetTime);
      if (!match || !match.indicators) {
        logger.warn(
          `[延迟验证失败] ${
            pendingSignal.symbol
          } 无法获取有效的${targetTimeLabel}指标值（目标时间=${targetTime.toLocaleString('zh-CN', {
            timeZone: 'Asia/Hong_Kong',
            hour12: false,
          })}，当前时间=${now.toLocaleString('zh-CN', {
            timeZone: 'Asia/Hong_Kong',
            hour12: false,
          })}）`,
        );
        return null;
      }
      matches.push(match);
    }

    // 验证所有3个时间点的指标值是否有效
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      if (!match || !match.indicators) {
        continue;
      }
      let allIndicatorsValid = true;
      for (const indicatorName of this.verificationConfig.indicators) {
        if (!Number.isFinite(match.indicators[indicatorName])) {
          allIndicatorsValid = false;
          break;
        }
      }
      if (!allIndicatorsValid) {
        logger.warn(
          `[延迟验证失败] ${pendingSignal.symbol} ${targetTimeLabels[i]}指标值中存在无效值，跳过验证`,
        );
        return null;
      }
    }

    // 提取3个时间点的指标值
    const indicators2a = matches[0]!.indicators;
    const indicators2b = matches[1]!.indicators;
    const indicators2c = matches[2]!.indicators;
    const actualTime0 = matches[0]!.timestamp;
    const actualTime1 = matches[1]!.timestamp;
    const actualTime2 = matches[2]!.timestamp;
    const timeDiffSeconds0 =
      Math.abs(actualTime0.getTime() - targetTime0.getTime()) / 1000;
    const timeDiffSeconds1 =
      Math.abs(actualTime1.getTime() - targetTime1.getTime()) / 1000;
    const timeDiffSeconds2 =
      Math.abs(actualTime2.getTime() - targetTime2.getTime()) / 1000;

    // 根据信号类型使用不同的验证条件
    const isBuyCall = pendingSignal.action === 'BUYCALL';
    const isBuyPut = pendingSignal.action === 'BUYPUT';

    // 只处理延迟验证的信号类型
    if (!isBuyCall && !isBuyPut) {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 未知的信号类型: ${pendingSignal.action}，跳过验证`,
      );
      return null;
    }

    let verificationPassed = true;
    const verificationDetails: string[] = [];
    const failedIndicators: string[] = [];

    // 遍历所有配置的指标进行验证（所有3个时间点的值都要满足条件）
    for (const indicatorName of this.verificationConfig.indicators) {
      const value1 = indicators1[indicatorName];
      const value2a = indicators2a[indicatorName];
      const value2b = indicators2b[indicatorName];
      const value2c = indicators2c[indicatorName];

      // 安全检查：确保所有值都是有效的数字
      if (
        !Number.isFinite(value1) ||
        !Number.isFinite(value2a) ||
        !Number.isFinite(value2b) ||
        !Number.isFinite(value2c)
      ) {
        logger.warn(
          `[延迟验证错误] ${pendingSignal.symbol} 指标${indicatorName}的值无效（value1=${value1}, value2a=${value2a}, value2b=${value2b}, value2c=${value2c}），跳过该信号验证`,
        );
        return null;
      }

      // TypeScript 类型断言 - Number.isFinite 确保了这些是有效数字
      const v1 = value1 as number;
      const v2a = value2a as number;
      const v2b = value2b as number;
      const v2c = value2c as number;

      // 统一使用 3 位小数
      const decimals = 3;

      let indicatorPassedA = false;
      let indicatorPassedB = false;
      let indicatorPassedC = false;
      let comparisonSymbolA = '';
      let comparisonSymbolB = '';
      let comparisonSymbolC = '';

      if (isBuyCall) {
        // 买入做多：所有3个时间点的指标值都要大于第一个值
        indicatorPassedA = v2a > v1;
        indicatorPassedB = v2b > v1;
        indicatorPassedC = v2c > v1;
        comparisonSymbolA = indicatorPassedA ? '>' : '<=';
        comparisonSymbolB = indicatorPassedB ? '>' : '<=';
        comparisonSymbolC = indicatorPassedC ? '>' : '<=';
      } else if (isBuyPut) {
        // 买入做空：所有3个时间点的指标值都要小于第一个值
        indicatorPassedA = v2a < v1;
        indicatorPassedB = v2b < v1;
        indicatorPassedC = v2c < v1;
        comparisonSymbolA = indicatorPassedA ? '<' : '>=';
        comparisonSymbolB = indicatorPassedB ? '<' : '>=';
        comparisonSymbolC = indicatorPassedC ? '<' : '>=';
      }

      // 构建详细信息字符串
      const detail = `${indicatorName}1=${v1.toFixed(decimals)} ` +
        `${indicatorName}2a=${v2a.toFixed(decimals)} (${indicatorName}2a${comparisonSymbolA}${indicatorName}1) ` +
        `${indicatorName}2b=${v2b.toFixed(decimals)} (${indicatorName}2b${comparisonSymbolB}${indicatorName}1) ` +
        `${indicatorName}2c=${v2c.toFixed(decimals)} (${indicatorName}2c${comparisonSymbolC}${indicatorName}1)`;
      verificationDetails.push(detail);

      // 只有所有3个时间点都满足条件，该指标才算通过
      if (!indicatorPassedA || !indicatorPassedB || !indicatorPassedC) {
        verificationPassed = false;
        failedIndicators.push(indicatorName);
      }
    }

    // 构建验证原因字符串
    let verificationReason = verificationDetails.join(' ');
    verificationReason += ` 时间差T0=${timeDiffSeconds0.toFixed(1)}秒 T0+5s=${timeDiffSeconds1.toFixed(1)}秒 T0+10s=${timeDiffSeconds2.toFixed(1)}秒`;

    if (!verificationPassed) {
      verificationReason += ` [失败指标: ${failedIndicators.join(', ')}]`;
    }

    if (verificationPassed) {
      const actionDesc = isBuyCall ? '买入做多' : '买入做空';
      logger.info(
        `[延迟验证通过] ${pendingSignal.symbol} ${verificationReason}，执行${actionDesc}`,
      );

      // 获取标的的当前价格和最小买卖单位
      let currentPrice: number | null = null;
      let lotSize: number | null = null;
      if (isBuyCall && longQuote) {
        currentPrice = longQuote.price;
        lotSize = longQuote.lotSize ?? null;
      } else if (isBuyPut && shortQuote) {
        currentPrice = shortQuote.price;
        lotSize = shortQuote.lotSize ?? null;
      }

      // 获取标的的中文名称
      let symbolName: string | null = null;
      if (isBuyCall && longQuote) {
        symbolName = longQuote.name;
      } else if (isBuyPut && shortQuote) {
        symbolName = shortQuote.name;
      }

      // 从对象池获取信号对象
      const signal = signalObjectPool.acquire() as Signal;
      signal.symbol = pendingSignal.symbol;
      signal.symbolName = symbolName;
      signal.action = pendingSignal.action;
      signal.reason = `延迟验证通过：${verificationReason}`;
      signal.price = currentPrice;
      signal.lotSize = lotSize;
      signal.signalTriggerTime = pendingSignal.triggerTime;

      return signal;
    } else {
      const actionDesc = isBuyCall ? '买入做多' : '买入做空';
      logger.info(
        `[延迟验证失败] ${pendingSignal.symbol} ${verificationReason}，不执行${actionDesc}`,
      );
      return null;
    }
  }
}
