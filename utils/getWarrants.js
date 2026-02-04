/**
 * 获取符合条件的最优牛熊证
 *
 * 筛选条件：正常交易，到期日 >= 3个月，现价 > 0.05（开盘后才应用分均成交额 >= 10万）
 * 优先选择：价格最接近 MIN_PRICE 且成交额最高
 *
 * 使用: node tests/getWarrants.js [标的代码] [bull|bear]
 * 示例: node tests/getWarrants.js HSI.HK bear
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Config, QuoteContext } from 'longport';

// ==================== 常量 ====================

/** 排序字段 - 成交额 */
const SORT_BY_TURNOVER = 4;
/** 排序顺序 - 降序 */
const SORT_DESCENDING = 1;
/** 牛熊证类型 */
const WARRANT_TYPE = { Bull: 3, Bear: 4 };
/** 到期日筛选 - 3个月以上 */
const EXPIRY_FILTERS = [3]; // Between_3_6, Between_6_12, GT_12
/** 状态 - 正常交易 */
const STATUS_NORMAL = [2];
/** 价内筛选 */
const PRICE_TYPE_IN_BOUNDS = [0];

/** 分均成交额阈值（港币） */
const MIN_TURNOVER_PER_MINUTE = 100000;
/** 最低价格阈值（港币） */
const MIN_PRICE = 0.05;
/** 默认标的 */
const DEFAULT_SYMBOL = 'HSI.HK';

/** 港股交易时段（分钟） */
const MORNING_OPEN = 570;   // 09:30
const MORNING_CLOSE = 720;  // 12:00
const AFTERNOON_OPEN = 780; // 13:00
const AFTERNOON_CLOSE = 960;// 16:00
const MORNING_MINUTES = 150;
const TOTAL_MINUTES = 330;

// 加载环境变量
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

// ==================== 工具函数 ====================

/**
 * 计算已开盘分钟数（使用 UTC+8 直接计算，避免 toLocaleString 开销）
 */
function getTradingMinutes() {
  const now = Date.now() + 8 * 3600000; // UTC+8
  const hkDate = new Date(now);
  const mins = hkDate.getUTCHours() * 60 + hkDate.getUTCMinutes();

  if (mins < MORNING_OPEN) return 0;
  if (mins < MORNING_CLOSE) return mins - MORNING_OPEN;
  if (mins < AFTERNOON_OPEN) return MORNING_MINUTES;
  if (mins < AFTERNOON_CLOSE) return MORNING_MINUTES + mins - AFTERNOON_OPEN;
  return TOTAL_MINUTES;
}

/**
 * 格式化成交额
 */
function formatTurnover(v) {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return v.toFixed(2);
}

/**
 * 格式化日期 YYMMDD -> YYYY-MM-DD
 */
function formatDate(d) {
  if (!d) return 'N/A';
  const s = String(d);
  if (s.length === 6) return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4)}`;
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  return s;
}

/**
 * 解析命令行参数
 */
function parseArgs() {
  let symbol = DEFAULT_SYMBOL;
  let isBull = true;

  for (const arg of process.argv.slice(2)) {
    const lower = arg.toLowerCase();
    if (lower === 'bull') isBull = true;
    else if (lower === 'bear') isBull = false;
    else if (arg.includes('.')) symbol = arg.toUpperCase();
  }

  return { symbol, isBull };
}

// ==================== 主程序 ====================

async function main() {
  const { symbol, isBull } = parseArgs();
  const typeLabel = isBull ? '牛证' : '熊证';
  const tradingMinutes = getTradingMinutes();

  console.log(`\n====== ${typeLabel}筛选 | ${symbol} ======`);
  console.log(`条件: 到期≥3月, 现价>${MIN_PRICE}, 分均成交≥${formatTurnover(MIN_TURNOVER_PER_MINUTE)}`);
  console.log(`已开盘: ${tradingMinutes} 分钟\n`);

  // 初始化 API 并获取数据
  const ctx = await QuoteContext.new(Config.fromEnv());
  const warrants = await ctx.warrantList(
    symbol,
    SORT_BY_TURNOVER,
    SORT_DESCENDING,
    [isBull ? WARRANT_TYPE.Bull : WARRANT_TYPE.Bear],
    null,
    EXPIRY_FILTERS,
    PRICE_TYPE_IN_BOUNDS,
    STATUS_NORMAL,
  );

  console.log(`获取 ${warrants.length} 只${typeLabel}\n`);

  // 单次遍历找最优：价格最低（> MIN_PRICE）且分均成交额最高
  let best = null;
  let validCount = 0;
  let skippedCount = 0;

  for (const w of warrants) {
    const price = Number(w.lastDone || 0);
    const turnover = Number(w.turnover || 0);

    // 价格过滤
    if (price <= MIN_PRICE) {
      skippedCount++;
      continue;
    }

    // 分均成交额过滤（市场已开盘时）
    const turnoverPerMin = tradingMinutes > 0 ? turnover / tradingMinutes : 0;
    if (tradingMinutes > 0 && turnoverPerMin < MIN_TURNOVER_PER_MINUTE) {
      skippedCount++;
      continue;
    }

    validCount++;

    // 比较找最优：价格低优先，成交额高优先
    if (!best ||
        price < best.price ||
        (price === best.price && turnoverPerMin > best.turnoverPerMin)) {
      best = {
        symbol: w.symbol,
        name: w.name,
        price,
        changeRate: (Number(w.changeRate || 0) * 100).toFixed(2) + '%',
        turnover,
        turnoverPerMin,
        expiryDate: w.expiryDate,
        callPrice: w.callPrice ? Number(w.callPrice) : null,
        toCallPrice: w.toCallPrice ? Number(w.toCallPrice) : null,
      };
    }
  }

  // 输出结果
  console.log('====== 结果 ======\n');

  if (best) {
    console.log(`选中: ${best.symbol} ${best.name}`);
    console.log(`现价: ${best.price.toFixed(3)} | 涨跌: ${best.changeRate}`);
    console.log(`成交额: ${formatTurnover(best.turnover)} | 分均: ${formatTurnover(best.turnoverPerMin)}`);
    console.log(`到期日: ${formatDate(best.expiryDate)}`);
    if (best.callPrice !== null) {
      console.log(`回收价: ${best.callPrice.toFixed(0)} | 距回收: ${best.toCallPrice !== null ? (best.toCallPrice * 100).toFixed(2) + '%' : 'N/A'}`);
    }
  } else {
    console.log(`没有符合条件的${typeLabel}`);
  }

  console.log(`\n统计: 总${warrants.length}, 有效${validCount}, 跳过${skippedCount}\n`);

  return { symbol, tradingMinutes, totalCount: warrants.length, best };
}

main().then(() => process.exit(0)).catch(e => {
  console.error('错误:', e.message);
  process.exit(1);
});
