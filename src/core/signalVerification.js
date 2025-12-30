/**
 * 延迟信号验证模块
 *
 * 功能：
 * - 管理延迟信号的验证流程
 * - 记录验证期间的指标变化历史
 * - 执行趋势确认（60秒延迟验证）
 *
 * 验证逻辑：
 * - BUYCALL：所有验证指标的第二个值 > 第一个值（上涨趋势）
 * - BUYPUT：所有验证指标的第二个值 < 第一个值（下跌趋势）
 *
 * 验证窗口：
 * - 触发时间前后 ±5 秒内记录指标值
 * - 每个信号有独立的 verificationHistory 数组
 *
 * 验证指标（可配置）：
 * - K、D、J（KDJ 指标）
 * - MACD、DIF、DEA（MACD 指标）
 */

import { logger } from "../utils/logger.js";
import { verificationEntryPool, signalObjectPool } from "../utils/objectPool.js";
import { SignalType } from "../utils/constants.js";
import { getIndicatorValue } from "../utils/indicatorHelpers.js";

/**
 * 信号验证管理器类
 * 管理延迟信号的验证流程：记录历史、执行验证、清理数据
 */
export class SignalVerificationManager {
  constructor(verificationConfig) {
    this.verificationConfig = verificationConfig;
  }

  /**
   * 添加延迟信号到待验证列表
   * @param {Array} delayedSignals 延迟信号列表
   * @param {Object} lastState 状态对象（包含 pendingDelayedSignals）
   */
  addDelayedSignals(delayedSignals, lastState) {
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
            s.triggerTime.getTime() === delayedSignal.triggerTime.getTime()
        );

        if (!existingSignal) {
          lastState.pendingDelayedSignals.push(delayedSignal);

          const actionDesc =
            delayedSignal.action === SignalType.BUYCALL
              ? "买入做多"
              : "买入做空";
          logger.info(
            `[延迟验证信号] 新增待验证${actionDesc}信号：${delayedSignal.symbol} - ${delayedSignal.reason}`
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
   * @param {Object} monitorSnapshot 监控标的指标快照
   * @param {Object} lastState 状态对象（包含 pendingDelayedSignals）
   */
  recordVerificationHistory(monitorSnapshot, lastState) {
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
    const currentIndicators = {};
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
          const windowEnd = triggerTimeMs + 5 * 1000; // triggerTime + 5 秒
          const nowMs = now.getTime();

          // 只在 triggerTime ±5 秒窗口内记录数据
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
              const entry = verificationEntryPool.acquire();
              entry.timestamp = now;
              // 将所有配置的指标值记录到 indicators 对象中
              entry.indicators = { ...currentIndicators };

              // 记录当前值
              pendingSignal.verificationHistory.push(entry);

              // 只保留当前信号触发时间点前后 5 秒窗口内的数据，释放其他条目
              const entriesToKeep = [];
              const entriesToRelease = [];
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
   * @param {Object} lastState 状态对象（包含 pendingDelayedSignals）
   * @param {Object} longQuote 做多标的行情
   * @param {Object} shortQuote 做空标的行情
   * @returns {Array} 验证通过的信号列表
   */
  verifyPendingSignals(lastState, longQuote, shortQuote) {
    const verifiedSignals = [];

    if (
      !lastState.pendingDelayedSignals ||
      lastState.pendingDelayedSignals.length === 0
    ) {
      return verifiedSignals;
    }

    // 检查是否有待验证的信号到了验证时间
    const now = new Date();
    const signalsToVerify = lastState.pendingDelayedSignals.filter(
      (s) => s.triggerTime && s.triggerTime <= now
    );

    // 处理需要验证的信号
    for (const pendingSignal of signalsToVerify) {
      try {
        const verifiedSignal = this._verifySingleSignal(
          pendingSignal,
          now,
          longQuote,
          shortQuote
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
          err?.message ?? String(err) ?? "未知错误"
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
   * @param {Object} pendingSignal 待验证信号
   * @param {Date} now 当前时间
   * @param {Object} longQuote 做多标的行情
   * @param {Object} shortQuote 做空标的行情
   * @returns {Object|null} 验证通过的信号，失败返回 null
   * @private
   */
  _verifySingleSignal(pendingSignal, now, longQuote, shortQuote) {
    // 安全检查：如果验证指标配置为null或空，跳过验证
    if (
      !this.verificationConfig.indicators ||
      this.verificationConfig.indicators.length === 0
    ) {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 验证指标配置为空，跳过验证`
      );
      return null;
    }

    // 验证策略更新：从实时监控标的的值获取indicators2
    if (!pendingSignal.triggerTime) {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 缺少triggerTime，跳过验证`
      );
      return null;
    }

    // 获取indicators1（从信号中获取，触发时已记录）
    const indicators1 = pendingSignal.indicators1;

    if (!indicators1 || typeof indicators1 !== "object") {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 缺少indicators1，跳过验证`
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
        `[延迟验证错误] ${pendingSignal.symbol} indicators1中存在无效值，跳过验证`
      );
      return null;
    }

    // 目标时间就是triggerTime（触发时已设置为当前时间+延迟秒数）
    const targetTime = pendingSignal.triggerTime;

    // 从该信号自己的验证历史记录中获取indicators2
    const history = pendingSignal.verificationHistory || [];

    // 查找精确匹配或最近的值
    let bestMatch = null;
    let minTimeDiff = Infinity;
    const maxTimeDiff = 5 * 1000; // 5秒误差

    for (const entry of history) {
      const timeDiff = Math.abs(
        entry.timestamp.getTime() - targetTime.getTime()
      );
      if (timeDiff <= maxTimeDiff && timeDiff < minTimeDiff) {
        minTimeDiff = timeDiff;
        bestMatch = entry;
      }
    }

    // 如果找不到匹配的值，尝试使用历史记录中最新的值
    if (!bestMatch && history.length > 0) {
      const latestEntry = history[history.length - 1];
      const timeDiff = Math.abs(
        latestEntry.timestamp.getTime() - targetTime.getTime()
      );
      if (timeDiff <= maxTimeDiff) {
        bestMatch = latestEntry;
      }
    }

    if (!bestMatch || !bestMatch.indicators) {
      logger.warn(
        `[延迟验证失败] ${
          pendingSignal.symbol
        } 无法获取有效的indicators2（目标时间=${targetTime.toLocaleString(
          "zh-CN",
          { timeZone: "Asia/Hong_Kong", hour12: false }
        )}，当前时间=${now.toLocaleString("zh-CN", {
          timeZone: "Asia/Hong_Kong",
          hour12: false,
        })}）`
      );
      return null;
    }

    const indicators2 = bestMatch.indicators;
    const actualTime = bestMatch.timestamp;
    const timeDiffSeconds =
      Math.abs(actualTime.getTime() - targetTime.getTime()) / 1000;

    // 验证所有配置的指标值是否有效
    let allIndicators2Valid = true;
    for (const indicatorName of this.verificationConfig.indicators) {
      if (!Number.isFinite(indicators2[indicatorName])) {
        allIndicators2Valid = false;
        break;
      }
    }

    if (!allIndicators2Valid) {
      logger.warn(
        `[延迟验证失败] ${pendingSignal.symbol} indicators2中存在无效值，跳过验证`
      );
      return null;
    }

    // 根据信号类型使用不同的验证条件
    const isBuyCall = pendingSignal.action === SignalType.BUYCALL;
    const isBuyPut = pendingSignal.action === SignalType.BUYPUT;

    // 只处理延迟验证的信号类型
    if (!isBuyCall && !isBuyPut) {
      logger.warn(
        `[延迟验证错误] ${pendingSignal.symbol} 未知的信号类型: ${pendingSignal.action}，跳过验证`
      );
      return null;
    }

    let verificationPassed = true;
    const verificationDetails = [];
    const failedIndicators = [];

    // 遍历所有配置的指标进行验证
    for (const indicatorName of this.verificationConfig.indicators) {
      const value1 = indicators1[indicatorName];
      const value2 = indicators2[indicatorName];

      // 安全检查：确保两个值都是有效的数字
      if (!Number.isFinite(value1) || !Number.isFinite(value2)) {
        logger.warn(
          `[延迟验证错误] ${pendingSignal.symbol} 指标${indicatorName}的值无效（value1=${value1}, value2=${value2}），跳过该信号验证`
        );
        return null;
      }

      // 统一使用 3 位小数
      const decimals = 3;

      let indicatorPassed = false;
      let comparisonSymbol = "";

      if (isBuyCall) {
        // 买入做多：所有指标的第二个值都要大于第一个值
        indicatorPassed = value2 > value1;
        comparisonSymbol = indicatorPassed ? ">" : "<=";
      } else if (isBuyPut) {
        // 买入做空：所有指标的第二个值都要小于第一个值
        indicatorPassed = value2 < value1;
        comparisonSymbol = indicatorPassed ? "<" : ">=";
      }

      // 构建详细信息字符串
      const detail = `${indicatorName}1=${value1.toFixed(
        decimals
      )} ${indicatorName}2=${value2.toFixed(
        decimals
      )} (${indicatorName}2${comparisonSymbol}${indicatorName}1)`;
      verificationDetails.push(detail);

      if (!indicatorPassed) {
        verificationPassed = false;
        failedIndicators.push(indicatorName);
      }
    }

    // 构建验证原因字符串
    let verificationReason = verificationDetails.join(" ");
    verificationReason += ` 时间差=${timeDiffSeconds.toFixed(1)}秒`;

    if (!verificationPassed) {
      verificationReason += ` [失败指标: ${failedIndicators.join(", ")}]`;
    }

    if (verificationPassed) {
      const actionDesc = isBuyCall ? "买入做多" : "买入做空";
      logger.info(
        `[延迟验证通过] ${pendingSignal.symbol} ${verificationReason}，执行${actionDesc}`
      );

      // 获取标的的当前价格和最小买卖单位
      let currentPrice = null;
      let lotSize = null;
      if (isBuyCall && longQuote) {
        currentPrice = longQuote.price;
        lotSize = longQuote.lotSize;
      } else if (isBuyPut && shortQuote) {
        currentPrice = shortQuote.price;
        lotSize = shortQuote.lotSize;
      }

      // 获取标的的中文名称
      let symbolName = null;
      if (isBuyCall && longQuote) {
        symbolName = longQuote.name;
      } else if (isBuyPut && shortQuote) {
        symbolName = shortQuote.name;
      }

      // 从对象池获取信号对象
      const signal = signalObjectPool.acquire();
      signal.symbol = pendingSignal.symbol;
      signal.symbolName = symbolName;
      signal.action = pendingSignal.action;
      signal.reason = `延迟验证通过：${verificationReason}`;
      signal.price = currentPrice;
      signal.lotSize = lotSize;
      signal.signalTriggerTime = pendingSignal.triggerTime;

      return signal;
    } else {
      const actionDesc = isBuyCall ? "买入做多" : "买入做空";
      logger.info(
        `[延迟验证失败] ${pendingSignal.symbol} ${verificationReason}，不执行${actionDesc}`
      );
      return null;
    }
  }
}
