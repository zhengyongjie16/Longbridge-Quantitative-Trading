/**
 * 港股交易费用计算工具。
 * 职责：读取指定交易日志，逐单计算费用并输出明细与汇总。
 * 流程：读取交易数据 -> 逐单计算费用 -> 累加汇总 -> 输出结果。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { HKFeeRates, Trade } from './types.js';
import {
  accumulateFees,
  calculateOrderFees,
  createEmptySummary,
  parseTradeNumbers,
  toShortSymbol,
} from './utils.js';

/** 港股收费标准（牛熊证不收印花税） */
const HK_FEE_RATES: HKFeeRates = {
  platformFee: 15,
  stampDuty: 0,
  clearingFee: {
    rate: 0.00002,
    min: 2,
    max: 100,
  },
  transactionFee: {
    rate: 0.0000565,
    min: 0.01,
  },
  transactionLevy: {
    rate: 0.000027,
    min: 0.01,
  },
  fstbLevy: {
    rate: 0.0000015,
    min: 0.01,
  },
};

/** 默认交易日志文件路径 */
const DEFAULT_TRADES_FILE = path.join(process.cwd(), 'logs', 'trades', '2026-01-21.json');

function main(): void {
  const trades: ReadonlyArray<Trade> = JSON.parse(
    readFileSync(DEFAULT_TRADES_FILE, 'utf8'),
  ) as Trade[];

  console.log('=== 2026-01-21 交易费用计算 ===\n');
  console.log(`总订单数：${trades.length}\n`);
  console.log('订单详情：');
  console.log(
    '订单ID | 标的 | 数量 | 价格 | 交易金额 | 平台费 | 印花税 | 交收费 | 交易费 | 交易征费 | 财汇局征费 | 总费用',
  );
  console.log(
    '-------|------|------|------|----------|--------|--------|--------|--------|----------|------------|--------',
  );

  let summary = createEmptySummary();

  for (const trade of trades) {
    const { quantity, price } = parseTradeNumbers(trade);
    const tradeAmount = quantity * price;
    const fees = calculateOrderFees(quantity, price, HK_FEE_RATES);
    summary = accumulateFees(summary, fees);

    const symbolShort = toShortSymbol(trade.symbol, 20);
    const row = `${trade.orderId.substring(0, 10)}... | ${symbolShort.padEnd(20)} | ${quantity
      .toString()
      .padStart(6)} | ${price.toFixed(3).padStart(5)} | ${tradeAmount
      .toFixed(2)
      .padStart(8)} | ${fees.platformFee.toFixed(2).padStart(6)} | ${fees.stampDuty
      .toFixed(2)
      .padStart(6)} | ${fees.clearingFee.toFixed(2).padStart(6)} | ${fees.transactionFee
      .toFixed(2)
      .padStart(6)} | ${fees.transactionLevy.toFixed(2).padStart(8)} | ${fees.fstbLevy
      .toFixed(2)
      .padStart(10)} | ${fees.total.toFixed(2).padStart(6)}`;
    console.log(row);
  }

  console.log('\n=== 费用汇总 ===');
  console.log(`平台费：${summary.totalPlatformFee.toFixed(2)} HKD`);
  console.log(`印花税：${summary.totalStampDuty.toFixed(2)} HKD（牛熊证不收印花税）`);
  console.log(`交收费：${summary.totalClearingFee.toFixed(2)} HKD`);
  console.log(`交易费：${summary.totalTransactionFee.toFixed(2)} HKD`);
  console.log(`交易征费：${summary.totalTransactionLevy.toFixed(2)} HKD`);
  console.log(`财务汇报局交易征费：${summary.totalFstbLevy.toFixed(2)} HKD`);
  console.log(`\n总费用：${summary.totalFees.toFixed(2)} HKD`);
}

main();
