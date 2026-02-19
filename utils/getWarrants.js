/**
 * 获取符合条件的所有牛熊证（全部符合阈值的结果）
 *
 * 筛选条件：正常交易，到期日 >= 3个月，距回收价百分比超过阈值，分均成交额 >= MIN_TURNOVER_PER_MINUTE（开盘后）
 * - 牛证：距回收价百分比 > 2%（API 小数形式 > 0.02）
 * - 熊证：距回收价百分比 < -2%（API 小数形式 < -0.02）
 * 输出：所有符合条件的结果（标注最接近阈值的一个），以 JSON 形式展示
 *
 * 使用: node utils/getWarrants.js [标的代码] [bull|bear]
 * 示例: node utils/getWarrants.js HSI.HK bear
 *
 * --- warrantList / Warrant Filter API 返回字段说明（list 中每项）---
 * 参考: Longbridge OpenAPI - Warrant Filter (quote/pull/warrant-filter)
 *
 * symbol             string   - 证券代码（如 12345.HK）
 * name               string   - 证券名称
 * last_done          string   - 最新价
 * change_rate        string   - 涨跌幅（小数形式，如 -0.0216 表示 -2.16%）
 * change_val         string   - 涨跌额
 * volume             int64    - 成交量
 * turnover           string   - 成交额（港币）
 * expiry_date        string   - 到期日，格式 YYMMDD（如 20220705）
 * strike_price       string   - 行权价（窝轮用；牛熊证多为 0）
 * upper_strike_price string   - 上限价（牛熊证为收回价上限；窝轮可能为 0）
 * lower_strike_price string   - 下限价（牛熊证为收回价下限；窝轮可能为 0）
 * outstanding_qty   string   - 流通量
 * outstanding_ratio  string   - 流通比率
 * premium            string   - 溢价（小数，如 0.016 表示约 1.6%）
 * itm_otm            string   - 价内/价外程度（窝轮用；牛熊证可能为 null/0）
 * implied_volatility string   - 隐含波动率（窝轮用；牛熊证可能无）
 * delta              string   - 希腊值 Delta（窝轮用；牛熊证可能无）
 * call_price         string   - 回收价/收回价（牛熊证触及即强制收回，单位与标的一致）
 * to_call_price      string   - 距回收价百分比（小数形式，如 0.02 表示 2%；牛证正值，熊证负值）
 * effective_leverage string   - 有效杠杆
 * leverage_ratio     string   - 杠杆比率
 * conversion_ratio   string   - 换股比率（牛熊证每份对应正股数量）
 * balance_point      string   - 打和点/盈亏平衡点（正股需到该价位才回本）
 * status             int32    - 状态：2=停牌 3=待上市 4=正常
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
/** 距回收价百分比阈值（小数形式，0.02 = 2%） */
const MIN_DISTANCE_PCT = 0.02;
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

  const distanceLabel = isBull
    ? `>${(MIN_DISTANCE_PCT * 100).toFixed(0)}%`
    : `<-${(MIN_DISTANCE_PCT * 100).toFixed(0)}%`;

  console.log(`\n====== ${typeLabel}筛选 | ${symbol} ======`);
  console.log(`条件: 到期≥3月, 距回收价${distanceLabel}, 分均成交≥${formatTurnover(MIN_TURNOVER_PER_MINUTE)}`);
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

  // 收集所有符合阈值的结果（保留 API 原始结构）：距回收价百分比超过阈值 且分均成交额 >= MIN_TURNOVER_PER_MINUTE（开盘后）
  const rawList = [];
  const distanceValues = [];
  let skippedCount = 0;
  const distanceThreshold = isBull ? MIN_DISTANCE_PCT : -MIN_DISTANCE_PCT;
  let closestIdx = -1;
  let closestDiff = Infinity;

  for (const w of warrants) {
    const turnover = Number(w.turnover || 0);
    const distancePct = Number(w.toCallPrice || 0);

    // 距回收价百分比过滤：牛证 > 阈值，熊证 < -阈值
    const distanceOk = isBull
      ? distancePct > MIN_DISTANCE_PCT
      : distancePct < -MIN_DISTANCE_PCT;
    if (!distanceOk) {
      skippedCount++;
      continue;
    }

    // 分均成交额过滤（市场已开盘时）
    const turnoverPerMin = tradingMinutes > 0 ? turnover / tradingMinutes : 0;
    if (tradingMinutes > 0 && turnoverPerMin < MIN_TURNOVER_PER_MINUTE) {
      skippedCount++;
      continue;
    }

    // 使用 SDK 提供的 toJSON() 获取可序列化的原生结构（WarrantInfo 为原生类，仅 getter 无枚举属性）
    rawList.push(typeof w.toJSON === 'function' ? w.toJSON() : { ...w });
    distanceValues.push(distancePct);

    // 追踪最接近距回收价百分比阈值的项
    const diff = Math.abs(distancePct - distanceThreshold);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIdx = rawList.length - 1;
    }
  }

  // 标注最接近阈值的牛熊证
  if (closestIdx >= 0) {
    rawList[closestIdx]._isClosestToThreshold = true;
  }

  // 构建最接近阈值的摘要信息
  const closestToThreshold = closestIdx >= 0
    ? {
        index: closestIdx,
        symbol: rawList[closestIdx].symbol,
        distancePct: distanceValues[closestIdx],
        distancePctDisplay: (distanceValues[closestIdx] * 100).toFixed(2) + '%',
      }
    : null;

  // 输出：仅包装一层元信息，list 为 API 原生结构（最接近阈值项带 _isClosestToThreshold 标记）
  console.log('====== 结果（API 原生 JSON） ======\n');

  const result = {
    symbol,
    typeLabel,
    tradingMinutes,
    totalFetched: warrants.length,
    validCount: rawList.length,
    skippedCount,
    threshold: {
      distancePct: `${isBull ? '>' : '<'}${(distanceThreshold * 100).toFixed(0)}%`,
      minTurnoverPerMinute: MIN_TURNOVER_PER_MINUTE,
    },
    closestToThreshold,
    list: rawList,
  };

  console.log(JSON.stringify(result, null, 2));

  if (rawList.length === 0) {
    console.log(`\n没有符合条件的${typeLabel}`);
  } else {
    console.log(`\n统计: 总${warrants.length}, 符合条件${rawList.length}, 跳过${skippedCount}`);
    if (closestToThreshold) {
      console.log(`★ 最接近阈值: ${closestToThreshold.symbol} (距回收价 ${closestToThreshold.distancePctDisplay})`);
    }
  }

  return result;
}

try {
  await main();
  process.exit(0);
} catch (e) {
  console.error('错误:', e.message);
  process.exit(1);
}
