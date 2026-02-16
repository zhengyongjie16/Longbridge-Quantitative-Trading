/**
 * 计算港股交易费用（牛熊证不收印花税）
 */

interface Trade {
  orderId: string;
  symbol: string;
  action: string;
  side: string;
  quantity: string;
  price: string;
  orderType: string;
  status: string;
}

// 港股收费标准
const HK_FEE_RATES = {
  // 平台费（固定）
  platformFee: 15, // HKD per order
  
  // 印花税（牛熊证不收）
  stampDuty: 0, // 0% for CBBC
  
  // 交收费
  clearingFee: {
    rate: 0.00002, // 0.002%
    min: 2,
    max: 100
  },
  
  // 交易费
  transactionFee: {
    rate: 0.0000565, // 0.00565%
    min: 0.01
  },
  
  // 交易征费
  transactionLevy: {
    rate: 0.000027, // 0.0027%
    min: 0.01
  },
  
  // 财务汇报局交易征费
  fstbLevy: {
    rate: 0.0000015, // 0.00015%
    min: 0.01
  }
};

function calculateOrderFees(quantity: number, price: number): {
  platformFee: number;
  stampDuty: number;
  clearingFee: number;
  transactionFee: number;
  transactionLevy: number;
  fstbLevy: number;
  total: number;
} {
  const tradeAmount = quantity * price;
  
  const platformFee = HK_FEE_RATES.platformFee;
  const stampDuty = 0;
  
  // 交收费（有最低和最高限额）
  const clearingFeeRaw = tradeAmount * HK_FEE_RATES.clearingFee.rate;
  const clearingFee = Math.max(
    HK_FEE_RATES.clearingFee.min,
    Math.min(HK_FEE_RATES.clearingFee.max, clearingFeeRaw)
  );
  
  // 交易费
  const transactionFee = Math.max(
    HK_FEE_RATES.transactionFee.min,
    tradeAmount * HK_FEE_RATES.transactionFee.rate
  );
  
  // 交易征费
  const transactionLevy = Math.max(
    HK_FEE_RATES.transactionLevy.min,
    tradeAmount * HK_FEE_RATES.transactionLevy.rate
  );
  
  // 财务汇报局交易征费
  const fstbLevy = Math.max(
    HK_FEE_RATES.fstbLevy.min,
    tradeAmount * HK_FEE_RATES.fstbLevy.rate
  );
  
  const total = platformFee + stampDuty + clearingFee + transactionFee + transactionLevy + fstbLevy;
  
  return {
    platformFee,
    stampDuty,
    clearingFee,
    transactionFee,
    transactionLevy,
    fstbLevy,
    total
  };
}

// 读取交易记录
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tradesFile = join(process.cwd(), 'logs', 'trades', '2026-01-21.json');
const trades: Trade[] = JSON.parse(readFileSync(tradesFile, 'utf-8'));

console.log('=== 2026-01-21 交易费用计算 ===\n');
console.log(`总订单数：${trades.length}\n`);

let totalPlatformFee = 0;
let totalStampDuty = 0;
let totalClearingFee = 0;
let totalTransactionFee = 0;
let totalTransactionLevy = 0;
let totalFstbLevy = 0;
let totalFees = 0;

console.log('订单详情：');
console.log('订单ID | 标的 | 数量 | 价格 | 交易金额 | 平台费 | 印花税 | 交收费 | 交易费 | 交易征费 | 财汇局征费 | 总费用');
console.log('-------|------|------|------|----------|--------|--------|--------|--------|----------|------------|--------');

trades.forEach((trade) => {
  const quantity = Number.parseInt(trade.quantity);
  const price = Number.parseFloat(trade.price);
  const tradeAmount = quantity * price;
  
  const fees = calculateOrderFees(quantity, price);
  
  totalPlatformFee += fees.platformFee;
  totalStampDuty += fees.stampDuty;
  totalClearingFee += fees.clearingFee;
  totalTransactionFee += fees.transactionFee;
  totalTransactionLevy += fees.transactionLevy;
  totalFstbLevy += fees.fstbLevy;
  totalFees += fees.total;
  
  const symbolShort = trade.symbol.length > 20 ? trade.symbol.substring(0, 17) + '...' : trade.symbol;
  console.log(
    `${trade.orderId.substring(0, 10)}... | ${symbolShort.padEnd(20)} | ${quantity.toString().padStart(6)} | ${price.toFixed(3).padStart(5)} | ${tradeAmount.toFixed(2).padStart(8)} | ${fees.platformFee.toFixed(2).padStart(6)} | ${fees.stampDuty.toFixed(2).padStart(6)} | ${fees.clearingFee.toFixed(2).padStart(6)} | ${fees.transactionFee.toFixed(2).padStart(6)} | ${fees.transactionLevy.toFixed(2).padStart(8)} | ${fees.fstbLevy.toFixed(2).padStart(10)} | ${fees.total.toFixed(2).padStart(6)}`
  );
});

console.log('\n=== 费用汇总 ===');
console.log(`平台费：${totalPlatformFee.toFixed(2)} HKD`);
console.log(`印花税：${totalStampDuty.toFixed(2)} HKD（牛熊证不收印花税）`);
console.log(`交收费：${totalClearingFee.toFixed(2)} HKD`);
console.log(`交易费：${totalTransactionFee.toFixed(2)} HKD`);
console.log(`交易征费：${totalTransactionLevy.toFixed(2)} HKD`);
console.log(`财务汇报局交易征费：${totalFstbLevy.toFixed(2)} HKD`);
console.log(`\n总费用：${totalFees.toFixed(2)} HKD`);
