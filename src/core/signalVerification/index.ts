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
 * - SELLCALL：验证指标的3个时间点值（T0, T0+5s, T0+10s）都小于初始值（下跌趋势）
 * - SELLPUT：验证指标的3个时间点值（T0, T0+5s, T0+10s）都大于初始值（上涨趋势）
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

import { logger } from '../../utils/logger/index.js';
import { verificationEntryPool, signalObjectPool } from '../../utils/objectPool/index.js';
import { getIndicatorValue } from '../../utils/indicatorHelpers/index.js';
import { formatError } from '../../utils/helpers/index.js';
import type { IndicatorSnapshot, Quote, Signal, VerificationConfig, VerificationEntry, LastState } from '../../types/index.js';
import type { SignalVerificationManager } from './types.js';

// 常量定义
/**
 * 每秒的毫秒数
 * 用于时间单位转换（秒转毫秒）
 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * 验证时间点1偏移量（秒）
 * 延迟验证的第一个时间点：T0 + 5秒
 * T0 为信号触发时间，此时间点用于验证指标趋势的延续性
 */
const VERIFICATION_TIME_OFFSET_1_SECONDS = 5;

/**
 * 验证时间点2偏移量（秒）
 * 延迟验证的第二个时间点：T0 + 10秒
 * T0 为信号触发时间，此时间点用于进一步确认指标趋势
 */
const VERIFICATION_TIME_OFFSET_2_SECONDS = 10;

/**
 * 验证时间点误差容忍度（毫秒）
 * 在查找验证历史记录时，允许的时间点误差范围
 * 由于系统循环执行可能存在时间偏差，允许 ±5 秒的误差
 */
const VERIFICATION_TIME_TOLERANCE_MS = 5 * MILLISECONDS_PER_SECOND;

/**
 * 验证窗口开始时间偏移量（秒）
 * 验证历史记录的开始时间：T0 - 5秒
 * 在信号触发前5秒开始记录指标值，确保能捕获到 T0 时间点的数据
 */
const VERIFICATION_WINDOW_START_OFFSET_SECONDS = -5;

/**
 * 验证窗口结束时间偏移量（秒）
 * 验证历史记录的结束时间：T0 + 15秒
 * 考虑到 T0+10秒 时间点允许 ±5 秒误差，最晚可能在 T0+15秒 记录数据
 */
const VERIFICATION_WINDOW_END_OFFSET_SECONDS = 15;

/**
 * 验证就绪延迟时间（秒）
 * 信号触发后需要等待此时间才能执行验证：T0 + 15秒
 * 确保所有3个验证时间点（T0, T0+5s, T0+10s）的数据都已记录完成
 */
const VERIFICATION_READY_DELAY_SECONDS = 15;

/**
 * 创建信号验证管理器
 * 管理延迟信号的验证流程：记录历史、执行验证、清理数据
 */
export const createSignalVerificationManager = (
  verificationConfig: VerificationConfig,
): SignalVerificationManager => {
  // 配置通过闭包捕获（不可变）
  const config = verificationConfig;

  /**
   * 验证单个信号（内部辅助函数）
   */
  const verifySingleSignal = (
    pendingSignal: Signal,
    now: Date,
    longQuote: Quote | null,
    shortQuote: Quote | null,
  ): Signal | null => {
    // 判断是买入还是卖出信号，选择对应的配置
    const isBuySignal = pendingSignal.action === 'BUYCALL' || pendingSignal.action === 'BUYPUT';
    const currentConfig = isBuySignal ? config.buy : config.sell;

    // 安全检查：如果验证指标配置为null或空，跳过验证
    if (
      !currentConfig.indicators ||
      currentConfig.indicators.length === 0
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
    for (const indicatorName of currentConfig.indicators) {
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
    const targetTime1 = new Date(targetTime0.getTime() + VERIFICATION_TIME_OFFSET_1_SECONDS * MILLISECONDS_PER_SECOND);
    const targetTime2 = new Date(targetTime0.getTime() + VERIFICATION_TIME_OFFSET_2_SECONDS * MILLISECONDS_PER_SECOND);
    const targetTimes = [targetTime0, targetTime1, targetTime2];
    const targetTimeLabels = ['T0', 'T0+5s', 'T0+10s'];

    // 从该信号自己的验证历史记录中获取indicators2a, indicators2b, indicators2c
    const history = pendingSignal.verificationHistory || [];
    const maxTimeDiff = VERIFICATION_TIME_TOLERANCE_MS;

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
      if (!match?.indicators) {
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
      if (!match?.indicators) {
        continue;
      }
      let allIndicatorsValid = true;
      for (const indicatorName of currentConfig.indicators) {
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
    // 防御性检查：确保有3个匹配项
    if (matches.length < 3) {
      logger.warn(
        `[延迟验证失败] ${pendingSignal.symbol} 匹配项数量不足（期望3个，实际${matches.length}个）`,
      );
      return null;
    }

    const match0 = matches[0];
    const match1 = matches[1];
    const match2 = matches[2];

    if (!match0 || !match1 || !match2) {
      logger.warn(
        `[延迟验证失败] ${pendingSignal.symbol} 匹配项为空`,
      );
      return null;
    }

    const indicators2a = match0.indicators;
    const indicators2b = match1.indicators;
    const indicators2c = match2.indicators;
    const actualTime0 = match0.timestamp;
    const actualTime1 = match1.timestamp;
    const actualTime2 = match2.timestamp;
    const timeDiffSeconds0 =
      Math.abs(actualTime0.getTime() - targetTime0.getTime()) / MILLISECONDS_PER_SECOND;
    const timeDiffSeconds1 =
      Math.abs(actualTime1.getTime() - targetTime1.getTime()) / MILLISECONDS_PER_SECOND;
    const timeDiffSeconds2 =
      Math.abs(actualTime2.getTime() - targetTime2.getTime()) / MILLISECONDS_PER_SECOND;

    // 根据信号类型使用不同的验证条件
    const isBuyCall = pendingSignal.action === 'BUYCALL';
    const isBuyPut = pendingSignal.action === 'BUYPUT';
    const isSellCall = pendingSignal.action === 'SELLCALL';
    const isSellPut = pendingSignal.action === 'SELLPUT';

    // 只处理延迟验证的信号类型
    if (!isBuyCall && !isBuyPut && !isSellCall && !isSellPut) {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 未知的信号类型: ${pendingSignal.action}，跳过验证`,
      );
      return null;
    }

    let verificationPassed = true;
    const verificationDetails: string[] = [];
    const failedIndicators: string[] = [];

    // 遍历所有配置的指标进行验证（所有3个时间点的值都要满足条件）
    for (const indicatorName of currentConfig.indicators) {
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

      if (isBuyCall || isSellPut) {
        // 买入做多 或 卖出做空：所有3个时间点的指标值都要大于第一个值（上涨趋势）
        indicatorPassedA = v2a > v1;
        indicatorPassedB = v2b > v1;
        indicatorPassedC = v2c > v1;
        comparisonSymbolA = indicatorPassedA ? '>' : '<=';
        comparisonSymbolB = indicatorPassedB ? '>' : '<=';
        comparisonSymbolC = indicatorPassedC ? '>' : '<=';
      } else if (isBuyPut || isSellCall) {
        // 买入做空 或 卖出做多：所有3个时间点的指标值都要小于第一个值（下跌趋势）
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
      let actionDesc = '';
      if (isBuyCall) {
        actionDesc = '买入做多';
      } else if (isBuyPut) {
        actionDesc = '买入做空';
      } else if (isSellCall) {
        actionDesc = '卖出做多';
      } else if (isSellPut) {
        actionDesc = '卖出做空';
      }

      logger.info(
        `[延迟验证通过] ${pendingSignal.symbol} ${verificationReason}，执行${actionDesc}`,
      );

      // 获取标的的当前价格和最小买卖单位
      let currentPrice: number | null = null;
      let lotSize: number | null = null;
      if ((isBuyCall || isSellCall) && longQuote) {
        currentPrice = longQuote.price;
        lotSize = longQuote.lotSize ?? null;
      } else if ((isBuyPut || isSellPut) && shortQuote) {
        currentPrice = shortQuote.price;
        lotSize = shortQuote.lotSize ?? null;
      }

      // 获取标的的中文名称
      let symbolName: string | null = null;
      if ((isBuyCall || isSellCall) && longQuote) {
        symbolName = longQuote.name;
      } else if ((isBuyPut || isSellPut) && shortQuote) {
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
      let actionDesc = '';
      if (isBuyCall) {
        actionDesc = '买入做多';
      } else if (isBuyPut) {
        actionDesc = '买入做空';
      } else if (isSellCall) {
        actionDesc = '卖出做多';
      } else if (isSellPut) {
        actionDesc = '卖出做空';
      }

      logger.info(
        `[延迟验证失败] ${pendingSignal.symbol} ${verificationReason}，不执行${actionDesc}`,
      );
      return null;
    }
  };

  return {
    addDelayedSignals: (delayedSignals: ReadonlyArray<Signal>, lastState: LastState): void => {
      // 初始化待验证信号数组（如果不存在）
      lastState.pendingDelayedSignals ??= [];

      // 处理延迟验证信号，添加到待验证列表
      for (const delayedSignal of delayedSignals) {
        if (delayedSignal?.triggerTime) {
          // 检查是否已存在相同的待验证信号（避免重复添加）
          const existingSignal = lastState.pendingDelayedSignals.find(
            (s) =>
              s.symbol === delayedSignal.symbol &&
              s.action === delayedSignal.action &&
              s.triggerTime?.getTime() === delayedSignal.triggerTime?.getTime(),
          );

          if (existingSignal === undefined) {
            lastState.pendingDelayedSignals.push(delayedSignal);

            let actionDesc = '';
            if (delayedSignal.action === 'BUYCALL') {
              actionDesc = '买入做多';
            } else if (delayedSignal.action === 'BUYPUT') {
              actionDesc = '买入做空';
            } else if (delayedSignal.action === 'SELLCALL') {
              actionDesc = '卖出做多';
            } else if (delayedSignal.action === 'SELLPUT') {
              actionDesc = '卖出做空';
            }

            logger.info(
              `[延迟验证信号] 新增待验证${actionDesc}信号：${delayedSignal.symbol} - ${delayedSignal.reason}`,
            );
          } else {
            // 如果信号已存在，释放新的信号对象，避免内存泄漏
            signalObjectPool.release(delayedSignal);
          }
        }
      }
    },

    recordVerificationHistory: (monitorSnapshot: IndicatorSnapshot | null, lastState: LastState): void => {
      if (
        !monitorSnapshot ||
        !lastState.pendingDelayedSignals ||
        lastState.pendingDelayedSignals.length === 0
      ) {
        return;
      }

      const now = new Date();

      // 为每个待验证信号记录当前值
      for (const pendingSignal of lastState.pendingDelayedSignals) {
        if (!pendingSignal.triggerTime) {
          continue;
        }

        // 判断是买入还是卖出信号，选择对应的配置
        const isBuySignal = pendingSignal.action === 'BUYCALL' || pendingSignal.action === 'BUYPUT';
        const currentConfig = isBuySignal ? config.buy : config.sell;

        // 检查该信号的配置是否有效
        if (!currentConfig.indicators || currentConfig.indicators.length === 0) {
          continue;
        }

        // 提取当前信号配置的所有指标值
        const currentIndicators: Record<string, number> = {};
        let allIndicatorsValid = true;

        for (const indicatorName of currentConfig.indicators) {
          const value = getIndicatorValue(monitorSnapshot, indicatorName);
          if (value === null || !Number.isFinite(value)) {
            allIndicatorsValid = false;
            break;
          }
          currentIndicators[indicatorName] = value;
        }

        // 如果所有配置的指标值有效，记录当前值
        if (allIndicatorsValid && Object.keys(currentIndicators).length > 0) {
          const triggerTimeMs = pendingSignal.triggerTime.getTime();
          const windowStart = triggerTimeMs + VERIFICATION_WINDOW_START_OFFSET_SECONDS * MILLISECONDS_PER_SECOND;
          const windowEnd = triggerTimeMs + VERIFICATION_WINDOW_END_OFFSET_SECONDS * MILLISECONDS_PER_SECOND;
          const nowMs = now.getTime();

          // 只在 triggerTime -5秒 到 +15秒 窗口内记录数据
          if (nowMs >= windowStart && nowMs <= windowEnd) {
            // 确保信号有历史记录数组
            pendingSignal.verificationHistory ??= [];

            // 避免在同一秒内重复记录（精确到秒）
            const nowSeconds = Math.floor(nowMs / MILLISECONDS_PER_SECOND);
            const lastEntry = pendingSignal.verificationHistory.at(-1);
            const lastEntrySeconds = lastEntry
              ? Math.floor(lastEntry.timestamp.getTime() / MILLISECONDS_PER_SECOND)
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
    },

    verifyPendingSignals: (
      lastState: LastState,
      longQuote: Quote | null,
      shortQuote: Quote | null,
    ): ReadonlyArray<Signal> => {
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
        const verificationReadyTime = new Date(s.triggerTime.getTime() + VERIFICATION_READY_DELAY_SECONDS * MILLISECONDS_PER_SECOND);
        return verificationReadyTime <= now;
      });

      // 处理需要验证的信号
      for (const pendingSignal of signalsToVerify) {
        try {
          const verifiedSignal = verifySingleSignal(
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
            formatError(err),
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
    },
  };
};
