# K 线获取重构：从轮询 API 迁移到订阅模式

**日期**: 2026-02-06

**目标**: 将主循环中每秒轮询 `candlesticks()` HTTP API 的方式，重构为 SDK 原生的 K 线订阅模式（`subscribeCandlesticks` + `realtimeCandlesticks`），消除高频 API 调用，从 SDK 本地缓存读取实时 K 线数据。

**Tech Stack**: TypeScript (ES2022), Node.js, LongPort OpenAPI SDK, pino。

**规范约束**: 遵守 `typescript-project-specifications` skill 全部核心原则。

---

## 一、现状分析

### 1.1 当前数据流

```
主循环（每秒）
  └─ processMonitor（每个监控标的）
      └─ runIndicatorPipeline
          └─ marketDataClient.getCandlesticks(symbol, '1m', 200)
              └─ ctx.candlesticks(symbol, Period.Min_1, 200, NoAdjust, All)
                  └─ HTTP API 请求 ← 每秒每标的 1 次
```

- **调用位置**: `src/main/processMonitor/indicatorPipeline.ts:35-37`
- **底层实现**: `src/services/quoteClient/index.ts:355-370`
- **调用频率**: 每秒 × 监控标的数量（N），即 N 次/秒
- **数据量**: 每次请求返回 200 根 1 分钟 K 线（完整 OHLCV）
- **用途**: 下游 `buildIndicatorSnapshot()` 计算 RSI、EMA、PSY、KDJ、MACD、MFI

### 1.2 存在的问题

| 问题 | 影响 |
|------|------|
| 高频 HTTP 调用 | 行情 API 限频 10 次/秒，N 个标的占用 N 次额度，挤压其他行情 API 调用空间 |
| 大量冗余传输 | 200 根 K 线中仅最后 1 根在分钟内变化，前 199 根每秒重复拉取 |
| 网络延迟叠加 | HTTP 往返延迟（~50-200ms）阻塞主循环，降低节拍稳定性 |
| 与行情订阅模式不一致 | 实时报价已使用 WebSocket 推送（`SubType.Quote`），K 线仍使用 HTTP 轮询 |

### 1.3 当前行情订阅状态

```typescript
// src/services/quoteClient/index.ts:302
await withRetry(() => ctx.subscribe(newSymbols, [SubType.Quote]));
```

仅订阅 `SubType.Quote`（实时报价），K 线未使用订阅模式。

---

## 二、SDK K 线订阅能力

LongPort SDK 提供独立于 `subscribe/SubType` 体系的 K 线订阅 API。

### 2.1 核心机制

K 线订阅不需要应用层维护缓存。SDK 内部自行管理 K 线数据的接收、存储与更新：

1. **`subscribeCandlesticks`** — 向服务端发起 K 线订阅请求，SDK 在内部：
   - 从服务端拉取初始历史 K 线数据存入 SDK 内部缓存
   - 建立 WebSocket 推送通道，后续更新自动写入 SDK 内部缓存
   - 返回初始 K 线数据给调用方

2. **`setOnCandlestick`** — SDK 收到推送时触发回调（仅通知，不需要应用层处理数据存储）

3. **`realtimeCandlesticks`** — 从 SDK 内部缓存读取指定数量的 K 线（无 HTTP 请求、无网络 I/O）

**与报价订阅的对比**：

| 维度 | 报价订阅（当前已实现） | K 线订阅（本次重构） |
|------|----------------------|---------------------|
| 订阅方式 | `ctx.subscribe(symbols, [SubType.Quote])` | `ctx.subscribeCandlesticks(symbol, period, tradeSessions)` |
| 数据维护 | **应用层**维护 `quoteCache`（由 `setOnQuote` 回调写入） | **SDK 内部**自动维护缓存（应用层无需建立缓存） |
| 数据读取 | 应用层直接读取 `quoteCache` Map | 调用 `ctx.realtimeCandlesticks()` 读取 SDK 内部缓存 |
| 退订 | `ctx.unsubscribe(symbols, [SubType.Quote])` | `ctx.unsubscribeCandlesticks(symbol, period)` |

### 2.2 API 签名

| API | 签名 | 说明 |
|-----|------|------|
| `subscribeCandlesticks` | `(symbol: string, period: Period, tradeSessions: TradeSessions) → Promise<Candlestick[]>` | 订阅并返回初始 K 线 |
| `unsubscribeCandlesticks` | `(symbol: string, period: Period) → Promise<void>` | 取消订阅 |
| `realtimeCandlesticks` | `(symbol: string, period: Period, count: number) → Promise<Candlestick[]>` | 从 SDK 内部缓存读取 |
| `setOnCandlestick` | `(callback: (err: Error, event: PushCandlestickEvent) → void) → void` | K 线推送回调 |

### 2.3 推送模式

通过 `Config` 的 `pushCandlestickMode` 属性配置（环境变量 `LONGPORT_PUSH_CANDLESTICK_MODE`）：

| 模式 | 枚举值 | 行为 |
|------|--------|------|
| `PushCandlestickMode.Realtime` | 0 | 实时推送：每笔成交更新当前正在形成的 K 线（**默认值**） |
| `PushCandlestickMode.Confirmed` | 1 | 确认模式：仅在 K 线完成（分钟结束）时推送 |

### 2.4 数据类型

`realtimeCandlesticks` 返回 `Candlestick[]`，与 `candlesticks` 返回类型**完全一致**：

| 属性 | 类型 | 说明 |
|------|------|------|
| `close` | `Decimal` | 收盘价 |
| `open` | `Decimal` | 开盘价 |
| `low` | `Decimal` | 最低价 |
| `high` | `Decimal` | 最高价 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `timestamp` | `Date` | 时间戳 |
| `tradeSession` | `TradeSession` | 交易时段 |

下游 `buildIndicatorSnapshot()` 使用的字段（close/open/high/low/volume）完全覆盖，无需修改。

### 2.5 订阅限制

- SDK 最多同时订阅 500 个标的
- K 线订阅仅需针对**监控标的**（如恒指），不需要订阅交易标的（牛熊证）的 K 线
- 监控标的数量通常 1-5 个，远低于上限

---

## 三、可行性评估

### 3.1 数据完整性 — 可行

| 维度 | `candlesticks()` (当前) | `realtimeCandlesticks()` (方案) |
|------|------------------------|--------------------------------|
| 返回类型 | `Candlestick[]` | `Candlestick[]`（**完全一致**） |
| OHLCV 字段 | 完整 | 完整 |
| count 参数 | 支持（200） | 支持（count 参数） |
| 初始历史数据 | HTTP 拉取 | `subscribeCandlesticks` 返回初始 K 线 |
| 下游兼容 | — | `buildIndicatorSnapshot` **无需修改** |

### 3.2 API 调用量 — 显著改善

| 指标 | 当前 | 重构后 |
|------|------|--------|
| K 线 HTTP 调用频率 | N 次/秒（N = 监控标的数） | **0 次/秒** |
| 启动时 K 线调用 | 0 | N 次（一次性订阅） |
| 数据读取方式 | HTTP 请求 → 网络 I/O | SDK 内部缓存读取 → 无 I/O |
| 限频影响 | 占用 N/10 的行情 API 额度 | **零占用** |

以 2 个监控标的、5.5 小时交易日计算：每日减少 **~39,600 次** HTTP API 调用。

### 3.3 延迟特性 — 同等或更优

- **当前**: 每秒轮询，有效延迟 ~1 秒 + HTTP 往返延迟
- **Realtime 推送模式**: 每笔成交实时更新 SDK 内部缓存，`realtimeCandlesticks` 读取延迟 < 1ms
- **主循环节拍**: 仍每秒读取一次，业务延迟特性不变；但读取操作从网络 I/O 变为缓存读取，主循环节拍稳定性提升

### 3.4 指标缓存兼容性 — 完全兼容

`buildIndicatorSnapshot` 内置 5 秒 TTL 指纹缓存（`src/services/indicators/index.ts:181-187`）：

- Realtime 模式下，SDK 缓存中的最新 K 线在每笔成交时更新
- 主循环每秒读取一次，指纹缓存自然适配
- K 线数据未变化时（该秒无成交）命中缓存，不做重复计算

### 3.5 架构一致性 — 与既有设计对齐

- 实时报价已采用 WebSocket 订阅模式（`subscribe(SubType.Quote)` + 应用层 `quoteCache`）
- K 线订阅采用同一范式的更简化版本（`subscribeCandlesticks` + SDK 内部缓存），应用层无需维护缓存
- 与 `2026-02-01-main-loop-async-refactor` 计划中"K 线获取/指标计算保留在主循环同步执行"的决策兼容——从 HTTP 同步调用变为缓存同步读取

---

## 四、合理性评估

### 4.1 收益

| 维度 | 说明 |
|------|------|
| **消除限频风险** | K 线不再占用行情 API 的 10 次/秒额度，为其他行情操作（warrantList、warrantQuote 等）腾出空间 |
| **提升主循环稳定性** | 去除 HTTP 网络 I/O，主循环每秒节拍由网络延迟支配变为纯计算支配 |
| **架构统一** | 行情数据获取方式统一为 WebSocket 订阅 + 缓存读取 |
| **降低服务端压力** | 大幅减少 API 请求量，降低被限频或报错的概率 |
| **代码简化** | 移除 `PeriodString` 类型、`normalizePeriod` 转换函数、`AdjustType` 导入等适配层代码 |

### 4.2 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| WebSocket 断线 | SDK 内部缓存停止更新 | SDK 内置自动重连；`setOnCandlestick` 回调可通过日志发现推送中断 |
| `realtimeCandlesticks` 返回数据量不足 | 技术指标计算异常 | `subscribeCandlesticks` 返回初始 K 线填充缓存；`buildIndicatorSnapshot` 已有空数据保护（返回 null） |

### 4.3 不采用的备选方案

| 方案 | 理由 |
|------|------|
| 保留 `getCandlesticks` 作为降级回退 | 引入兼容性代码和双路径分支，违反无兼容性代码原则 |
| 仅对部分标的使用订阅 | 增加条件分支和状态管理复杂度，无实际收益 |
| 使用 `Confirmed` 推送模式 | 最长延迟 60 秒才推送一次，不满足每秒计算指标的需求 |
| 应用层自建 K 线缓存（类似 quoteCache） | SDK 已内置缓存管理，重复建设无意义且增加维护成本 |

---

## 五、重构方案

### 5.1 变更概览

```
影响文件（共 6 个）:
├── src/config/config.index.ts                         [修改] 添加 pushCandlestickMode 配置
├── src/constants/index.ts                             [修改] CANDLE_PERIOD 从字符串改为 Period 枚举
├── src/types/index.ts                                 [修改] 移除 PeriodString，重构 MarketDataClient 接口
├── src/services/quoteClient/index.ts                  [修改] 实现新方法，移除旧方法，更新导入和模块文档
├── src/main/processMonitor/indicatorPipeline.ts       [修改] 切换数据源调用
├── src/index.ts                                       [修改] 启动时订阅监控标的 K 线

移除内容:
├── PeriodString 类型定义               （src/types/index.ts）
├── PeriodString 导入                   （src/services/quoteClient/index.ts）
├── AdjustType 导入                     （src/services/quoteClient/index.ts，仅被 getCandlesticks 使用）
├── normalizePeriod 函数                （src/services/quoteClient/index.ts）
├── getCandlesticks 方法定义            （src/types/index.ts MarketDataClient 接口）
├── getCandlesticks 实现                （src/services/quoteClient/index.ts）
```

### 5.2 详细变更

---

#### 变更 1：Config 添加 K 线推送模式

**文件**: `src/config/config.index.ts`

**变更说明**: 在 `new Config({...})` 中添加 `pushCandlestickMode: PushCandlestickMode.Realtime`。虽然 `Realtime` 是 SDK 默认值，但显式声明可明确意图、防止 SDK 默认值变更。

**导入变更**: 新增 `PushCandlestickMode` 导入。

**完整代码**:

```typescript
import { Config, PushCandlestickMode } from 'longport';
import { getRegionUrls } from './utils.js';

export function createConfig({ env }: { env: NodeJS.ProcessEnv }): Config {
  const appKey = env['LONGPORT_APP_KEY'] ?? '';
  const appSecret = env['LONGPORT_APP_SECRET'] ?? '';
  const accessToken = env['LONGPORT_ACCESS_TOKEN'] ?? '';

  const region = env['LONGPORT_REGION'] || 'hk';
  const urls = getRegionUrls(region);

  return new Config({
    appKey,
    appSecret,
    accessToken,
    enablePrintQuotePackages: true,
    pushCandlestickMode: PushCandlestickMode.Realtime,
    httpUrl: urls.httpUrl,
    quoteWsUrl: urls.quoteWsUrl,
    tradeWsUrl: urls.tradeWsUrl,
  });
}
```

---

#### 变更 2：常量类型修正

**文件**: `src/constants/index.ts`

**变更说明**: `CANDLE_PERIOD` 从字符串字面量 `'1m' as const` 改为 `Period.Min_1` 枚举值。下游直接使用 `Period` 枚举，无需字符串到枚举的转换。

**导入变更**: 新增 `Period` 导入。

**变更片段**（仅展示变更部分，文件其余内容不变）:

```typescript
// 导入新增 Period
import { OrderStatus, OrderType, Period } from 'longport';

/** 交易相关常量 */
export const TRADING = {
  /** 默认目标金额（港币），单次开仓的目标市值 */
  DEFAULT_TARGET_NOTIONAL: 5000,
  /** K线周期，用于订阅和获取实时K线数据 */
  CANDLE_PERIOD: Period.Min_1,
  /** K线数量，获取的实时K线条数 */
  CANDLE_COUNT: 200,
  /** 主循环执行间隔（毫秒），mainProgram 的执行频率 */
  INTERVAL_MS: 1000,
  /** 监控标的最大扫描范围（从 _1 扫描到 _100） */
  MAX_MONITOR_SCAN_RANGE: 100,
} as const;
```

---

#### 变更 3：MarketDataClient 接口重构

**文件**: `src/types/index.ts`

**删除**:
- `PeriodString` 类型定义（第 711 行）
- `getCandlesticks` 方法及其全部参数签名（第 750-756 行）

**新增**:
- `subscribeCandlesticks` 方法
- `unsubscribeCandlesticks` 方法
- `getRealtimeCandlesticks` 方法

**导入变更**: 由于接口中不再使用 `AdjustType`，检查此文件是否导入了 `AdjustType`——若仅被 `getCandlesticks` 签名使用，则一并移除。

**接口完整代码**:

```typescript
export interface MarketDataClient {
  /** 获取底层 QuoteContext（内部使用） */
  _getContext(): Promise<QuoteContext>;

  /**
   * 批量获取多个标的的最新行情
   * @param symbols 标的代码可迭代对象
   * @returns 标的代码到行情数据的 Map
   */
  getQuotes(symbols: Iterable<string>): Promise<Map<string, Quote | null>>;

  /** 动态订阅行情标的（报价推送） */
  subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;

  /** 取消订阅行情标的（报价推送） */
  unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;

  /**
   * 订阅指定标的的 K 线推送
   *
   * 订阅后 SDK 通过 WebSocket 实时推送 K 线更新到 SDK 内部缓存，
   * 后续通过 getRealtimeCandlesticks 从 SDK 内部缓存读取。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param tradeSessions 交易时段（默认 All）
   * @returns 初始 K 线数据
   */
  subscribeCandlesticks(
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ): Promise<Candlestick[]>;

  /**
   * 取消订阅指定标的的 K 线推送
   * @param symbol 标的代码
   * @param period K 线周期
   */
  unsubscribeCandlesticks(
    symbol: string,
    period: Period,
  ): Promise<void>;

  /**
   * 获取实时 K 线数据（从 SDK 内部缓存读取，无 HTTP 请求）
   *
   * 需先调用 subscribeCandlesticks 订阅，否则返回空数据。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param count 获取数量
   */
  getRealtimeCandlesticks(
    symbol: string,
    period: Period,
    count: number,
  ): Promise<Candlestick[]>;

  /** 判断指定日期是否为交易日 */
  isTradingDay(date: Date, market?: Market): Promise<TradingDayInfo>;
}
```

---

#### 变更 4：quoteClient 实现重构

**文件**: `src/services/quoteClient/index.ts`

##### 4.1 模块文档更新

```typescript
/**
 * 行情数据客户端模块（WebSocket 订阅模式）
 *
 * 功能：
 * - 通过 WebSocket 订阅实时行情推送（报价 + K 线）
 * - 检查交易日信息
 *
 * 订阅机制：
 * - 创建客户端时不自动订阅，需显式调用 subscribeSymbols / subscribeCandlesticks
 * - 报价数据由推送实时更新到应用层 quoteCache
 * - K 线数据由 SDK 内部维护缓存，通过 realtimeCandlesticks 读取
 * - getQuotes() 从应用层 quoteCache 读取，无 HTTP 请求
 * - getRealtimeCandlesticks() 从 SDK 内部缓存读取，无 HTTP 请求
 *
 * 缓存机制：
 * - 行情数据：随订阅实时更新（退订会清理缓存）
 * - 昨收价：订阅后缓存（退订会清理缓存）
 * - K 线数据：SDK 内部自动维护（订阅后实时更新，退订后自动清理）
 * - 交易日信息：24 小时 TTL 缓存
 * - 静态信息（name、lotSize）：缓存直到退订或显式清理
 *
 * 核心方法：
 * - getQuotes()：批量获取多个标的实时行情（从应用层 quoteCache 读取）
 * - subscribeCandlesticks()：订阅 K 线推送
 * - getRealtimeCandlesticks()：获取实时 K 线数据（从 SDK 内部缓存读取）
 * - isTradingDay()：检查是否为交易日
 */
```

##### 4.2 导入变更

**移除**:
- 值导入: `AdjustType`（仅被已删除的 `getCandlesticks` 使用）
- 类型导入: `PeriodString`（类型已删除）

**新增**:
- 类型导入: `PushCandlestickEvent`（用于 `setOnCandlestick` 回调类型）

```typescript
// 变更前
import {
  AdjustType,       // ← 移除
  Period,
  QuoteContext,
  TradeSessions,
  Market,
  NaiveDate,
  SubType,
} from 'longport';
import type { Candlestick, PushQuoteEvent } from 'longport';
import type { Quote, TradingDayInfo, MarketDataClient, TradingDaysResult, PeriodString } from '../../types/index.js';
//                                                                         ↑ 移除

// 变更后
import {
  Period,
  QuoteContext,
  TradeSessions,
  Market,
  NaiveDate,
  SubType,
} from 'longport';
import type { Candlestick, PushQuoteEvent, PushCandlestickEvent } from 'longport';
import type { Quote, TradingDayInfo, MarketDataClient, TradingDaysResult } from '../../types/index.js';
```

##### 4.3 删除代码

| 删除项 | 位置 | 原因 |
|--------|------|------|
| `normalizePeriod` 函数 | 第 55-67 行 | 不再需要字符串到枚举的转换 |
| `getCandlesticks` 函数 | 第 355-370 行 | 被 `getRealtimeCandlesticks` 替代 |
| 返回对象中的 `getCandlesticks` | 第 462 行附近 | 接口已移除此方法 |

##### 4.4 新增代码

**新增闭包状态**（在工厂函数内已有缓存声明处追加）:

```typescript
  // 已订阅 K 线跟踪（key: "symbol:period"）
  const subscribedCandlesticks = new Set<string>();
```

**新增 K 线推送回调**（在已有的 `setOnQuote` 注册之后）:

```typescript
  // K 线推送回调（错误监控）
  ctx.setOnCandlestick((err: Error | null, _event: PushCandlestickEvent) => {
    if (err) {
      logger.warn(`[K线推送] 接收推送时发生错误: ${formatError(err)}`);
    }
  });
```

**新增三个方法实现**（在 `cacheStaticInfo` 之后、`return` 之前）:

```typescript
  /**
   * 订阅指定标的的 K 线推送
   */
  async function subscribeCandlesticks(
    symbol: string,
    period: Period,
    tradeSessions: TradeSessions = TradeSessions.All,
  ): Promise<Candlestick[]> {
    const key = `${symbol}:${period}`;
    if (subscribedCandlesticks.has(key)) {
      logger.debug(`[K线订阅] ${symbol} 周期 ${period} 已订阅，跳过重复订阅`);
      return [];
    }

    const initialCandles = await withRetry(
      () => ctx.subscribeCandlesticks(symbol, period, tradeSessions),
    );
    subscribedCandlesticks.add(key);
    logger.info(`[K线订阅] 已订阅 ${symbol} 周期 ${period} K线，初始数据 ${initialCandles.length} 根`);
    return initialCandles;
  }

  /**
   * 取消订阅指定标的的 K 线推送
   */
  async function unsubscribeCandlesticks(
    symbol: string,
    period: Period,
  ): Promise<void> {
    const key = `${symbol}:${period}`;
    if (!subscribedCandlesticks.has(key)) {
      return;
    }

    await withRetry(() => ctx.unsubscribeCandlesticks(symbol, period));
    subscribedCandlesticks.delete(key);
    logger.info(`[K线订阅] 已退订 ${symbol} 周期 ${period} K线`);
  }

  /**
   * 获取实时 K 线数据（从 SDK 内部缓存读取，无 HTTP 请求）
   */
  async function getRealtimeCandlesticks(
    symbol: string,
    period: Period,
    count: number,
  ): Promise<Candlestick[]> {
    return ctx.realtimeCandlesticks(symbol, period, count);
  }
```

**更新返回对象**:

```typescript
  // 变更前
  return {
    _getContext,
    getQuotes,
    subscribeSymbols,
    unsubscribeSymbols,
    getCandlesticks,      // ← 移除
    isTradingDay,
  };

  // 变更后
  return {
    _getContext,
    getQuotes,
    subscribeSymbols,
    unsubscribeSymbols,
    subscribeCandlesticks,
    unsubscribeCandlesticks,
    getRealtimeCandlesticks,
    isTradingDay,
  };
```

##### 4.5 规范检查

| 规范要求 | 检查结果 |
|---------|---------|
| 工厂函数模式 | `createMarketDataClient` 工厂函数不变 |
| 非闭包函数提升 | 新增方法均使用闭包变量（`ctx`、`subscribedCandlesticks`、`withRetry`），必须留在工厂函数内部 |
| 依赖注入 | `MarketDataClientDeps` 不变，`config` 通过参数注入 |
| readonly / ReadonlyArray | 方法参数为基础类型（string/Period/number），无需 readonly |
| 函数参数 ≤ 7 | `subscribeCandlesticks` 3 个、`unsubscribeCandlesticks` 2 个、`getRealtimeCandlesticks` 3 个 |
| 禁止否定条件前置 | `subscribeCandlesticks` 中 `if (subscribedCandlesticks.has(key))` 为肯定条件守卫；`unsubscribeCandlesticks` 中 `if (!subscribedCandlesticks.has(key))` 为无 else 的守卫子句，符合例外规则 |
| 无兼容/临时代码 | 完全移除旧 API，无降级路径、无临时开关 |
| 无无用代码 | `AdjustType`、`PeriodString`、`normalizePeriod` 全部移除 |

---

#### 变更 5：指标流水线切换数据源

**文件**: `src/main/processMonitor/indicatorPipeline.ts`

**变更说明**: 将 `getCandlesticks` 调用替换为 `getRealtimeCandlesticks`。

**导入变更**: 无（`TRADING` 导入不变，只是 `TRADING.CANDLE_PERIOD` 的底层类型从 `'1m'` 变为 `Period.Min_1`）。

**变更行**（仅第 35-37 行变化，其余代码完全不变）:

```typescript
  // 变更前
  const monitorCandles = await marketDataClient
    .getCandlesticks(monitorSymbol, TRADING.CANDLE_PERIOD, TRADING.CANDLE_COUNT)
    .catch(() => null);

  // 变更后
  const monitorCandles = await marketDataClient
    .getRealtimeCandlesticks(monitorSymbol, TRADING.CANDLE_PERIOD, TRADING.CANDLE_COUNT)
    .catch(() => null);
```

**类型兼容性**: `TRADING.CANDLE_PERIOD` 类型从 `'1m'` 变为 `Period.Min_1`，`getRealtimeCandlesticks` 接受 `Period` 枚举，类型匹配。返回类型 `Candlestick[]` 不变，下游 `buildIndicatorSnapshot` 无需修改。

---

#### 变更 6：启动流程 — 订阅监控标的 K 线

**文件**: `src/index.ts`

**变更说明**: 在报价订阅 `subscribeSymbols` 之后，为所有监控标的订阅 K 线。

**导入变更**: 无新增导入。`TRADING` 已在现有导入中（第 44 行）。`subscribeCandlesticks` 通过已注入的 `marketDataClient` 调用，无需额外导入。`tradeSessions` 参数使用接口默认值（`TradeSessions.All`），无需导入 `TradeSessions`。

**新增代码位置**: 在 `await marketDataClient.subscribeSymbols([...allTradingSymbols])` 之后（当前第 331 行附近），`const initQuotesMap = ...` 之前。

```typescript
  // 订阅所有监控标的的 K 线推送（SDK 内部自动维护缓存，主循环通过 getRealtimeCandlesticks 读取）
  for (const monitorConfig of tradingConfig.monitors) {
    await marketDataClient.subscribeCandlesticks(
      monitorConfig.monitorSymbol,
      TRADING.CANDLE_PERIOD,
    );
  }
```

**说明**:
- 监控标的在运行时不会变更（由配置决定），因此只需启动时订阅一次
- K 线订阅独立于报价订阅，不影响 `subscribeSymbols` / `unsubscribeSymbols` 的运行时动态管理
- 无需在主循环中动态订阅/退订 K 线
- `tradeSessions` 参数省略，使用实现层默认值 `TradeSessions.All`

---

### 5.3 移除内容清单

| 移除项 | 文件 | 原因 |
|--------|------|------|
| `PeriodString` 类型定义 | `src/types/index.ts` | 不再需要字符串周期类型 |
| `getCandlesticks` 方法签名 | `src/types/index.ts` MarketDataClient 接口 | 被三个新方法替代 |
| `AdjustType` 值导入 | `src/services/quoteClient/index.ts` | 仅被已删除的 `getCandlesticks` 使用 |
| `PeriodString` 类型导入 | `src/services/quoteClient/index.ts` | 类型已删除 |
| `normalizePeriod` 导出函数 | `src/services/quoteClient/index.ts` | 不再需要字符串到枚举的转换 |
| `getCandlesticks` 函数实现 | `src/services/quoteClient/index.ts` | 被 `getRealtimeCandlesticks` 替代 |

---

## 六、数据流对比

### 6.1 重构前

```
每秒循环 ──────────────────────────────────────────────
  │
  ├─ processMonitor(标的A)
  │   └─ getCandlesticks("HSI.HK", "1m", 200)
  │       └─ ctx.candlesticks(...)  ← HTTP 请求（网络 I/O）
  │           └─ 服务器返回 200 根 K 线
  │       └─ buildIndicatorSnapshot(candles)
  │
  ├─ processMonitor(标的B)
  │   └─ getCandlesticks("HSTECH.HK", "1m", 200)
  │       └─ ctx.candlesticks(...)  ← HTTP 请求（网络 I/O）
  │           └─ 服务器返回 200 根 K 线
  │       └─ buildIndicatorSnapshot(candles)
```

### 6.2 重构后

```
启动阶段 ──────────────────────────────────────────────
  │
  ├─ subscribeCandlesticks("HSI.HK", Min_1)
  │   └─ ctx.subscribeCandlesticks(...)  ← 一次性
  │       └─ WebSocket 订阅建立 + SDK 拉取初始 K 线存入内部缓存
  │
  ├─ subscribeCandlesticks("HSTECH.HK", Min_1)
  │   └─ ctx.subscribeCandlesticks(...)  ← 一次性
  │       └─ WebSocket 订阅建立 + SDK 拉取初始 K 线存入内部缓存
  │
  ↓
  SDK 后台通过 WebSocket 持续接收 K 线推送，自动更新内部缓存
  ↓
每秒循环 ──────────────────────────────────────────────
  │
  ├─ processMonitor(标的A)
  │   └─ getRealtimeCandlesticks("HSI.HK", Min_1, 200)
  │       └─ ctx.realtimeCandlesticks(...)  ← SDK 内部缓存读取
  │       └─ buildIndicatorSnapshot(candles)
  │
  ├─ processMonitor(标的B)
  │   └─ getRealtimeCandlesticks("HSTECH.HK", Min_1, 200)
  │       └─ ctx.realtimeCandlesticks(...)  ← SDK 内部缓存读取
  │       └─ buildIndicatorSnapshot(candles)
```

---

## 七、实施顺序

按依赖关系从底层到上层依次修改：

| 步骤 | 变更 | 文件 | 说明 |
|------|------|------|------|
| 1 | Config 添加推送模式 | `src/config/config.index.ts` | 底层配置，无下游依赖 |
| 2 | 常量类型修正 | `src/constants/index.ts` | 底层常量，供后续步骤使用 |
| 3 | 接口重构 | `src/types/index.ts` | 移除 `PeriodString`，重新定义 `MarketDataClient` |
| 4 | 实现重构 | `src/services/quoteClient/index.ts` | 实现新方法、移除旧代码、更新导入和模块文档 |
| 5 | 指标流水线切换 | `src/main/processMonitor/indicatorPipeline.ts` | 替换数据源调用 |
| 6 | 启动流程更新 | `src/index.ts` | 添加 K 线订阅 |

---

## 八、验证清单

### 编译与静态检查

- [ ] `npm run type-check` 通过
- [ ] `npm run lint` 通过

### 移除完整性

- [ ] `PeriodString` 在 `src/` 中无残留引用
- [ ] `normalizePeriod` 在 `src/` 中无残留引用
- [ ] `getCandlesticks` 在 `src/` 中无残留引用（接口和实现）
- [ ] `AdjustType` 在 `src/services/quoteClient/index.ts` 中无残留引用

### 功能正确性

- [ ] Config 设置 `pushCandlestickMode: PushCandlestickMode.Realtime`
- [ ] `TRADING.CANDLE_PERIOD` 类型为 `Period.Min_1`
- [ ] 所有监控标的在启动时通过 `subscribeCandlesticks` 订阅 K 线
- [ ] `indicatorPipeline` 使用 `getRealtimeCandlesticks` 读取数据
- [ ] 返回的 `Candlestick[]` 类型与下游 `buildIndicatorSnapshot` 兼容
- [ ] `setOnCandlestick` 回调已注册（错误日志）

### 规范符合性

- [ ] 无兼容性/补丁性代码（无 `getCandlesticks` 降级路径）
- [ ] 无临时或多余注释
- [ ] 无无用导入/变量
- [ ] 新方法遵循工厂函数 + 依赖注入模式
- [ ] 新方法参数 ≤ 7 个
