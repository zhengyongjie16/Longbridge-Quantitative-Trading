# Auto Symbol Search Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将自动寻标逻辑接入主程序，基于 `warrantList.turnover` 计算分均成交额筛选牛熊证，并支持换标、移仓与换标后的回收价/缓存刷新；彻底替换所有静态 long/short 标的假设。

**Architecture:** 新增 `AutoSymbolFinder`（按 `warrantList` + 分均成交额筛选）与 `AutoSymbolManager`（席位/换标/移仓状态机），引入 `SymbolRegistry + SeatVersion` 作为动态标的唯一来源；启动流程改为“全量订单一次获取→按归属分配订单记录”，实时监控仅在交易时段内触发寻标与换标；换标后通过 `warrantQuote` 刷新回收价缓存并同步订单/持仓/浮亏缓存。

---

## Systemic Refactor Scope（无兼容层）

- **静态标的彻底移除**：`processMonitor`、`strategy`、`signalProcessor`、`orderMonitor`、`doomsdayProtection`、`quoteHelpers` 不再直接读取 `config.longSymbol/shortSymbol`，统一从 `MonitorContext.seatState` 获取。
- **SymbolRegistry + SeatVersion**：为每个监控标的维护席位版本号，延迟信号、任务队列、订单监控都以版本号校验，避免换标后执行旧标的信号。
- **单方向单标的强约束**：同一监控标的同一方向仅允许一个标的；席位上只能存在一个标的，禁止并存、禁止多标的兼容逻辑。
- **行情订阅动态化**：`createMarketDataClient` 必须支持运行时订阅/退订，换标后实时行情立即覆盖新标的。
- **缓存一致性一体化**：换标成功的统一刷新入口必须包含：订单记录 → 持仓缓存 → 浮亏缓存 → 回收价缓存 → 标的名称。
- **席位为空强约束**：信号生成、延迟验证、买卖处理器必须统一在席位为空时“直接丢弃并记录日志”。

---

## Boundary Conditions & Edge Cases

- **换标竞态**：换标过程中旧信号/延迟信号需要版本校验，否则会错误下单。
- **阈值边界**：距回收价比值触发换标使用“包含等于”（≥/≤）。
- **换标后刷新**：换标完成后立即刷新账户/持仓/浮亏缓存，若需要移仓则移仓后刷新（相比与仅换标，移仓则是在换标后还需买入新标的，具体请看需求文档或其余重构文档）。
- **旧标的清理**：换标完成后立即清理旧标的订单记录与 API 缓存。
- **未成交订单**：换标时必须强制撤销旧标的所有挂单（指买入挂单），撤单完成后才允许寻标/分配新标的。
- **单方向单标的**：换标前必须确保旧标的无持仓/无挂单，严禁新旧标的并存。
- **持仓口径**：换标“仍有持仓”的判断以 `availableQuantity > 0` 为准。
- **换标阻断信号**：席位进入 `SWITCHING` 状态后，所有该方向信号直接丢弃（不生成、不入队）。
- **无候选标的**：自动寻标失败时席位保持空，必须阻断该方向交易信号。
- **寻标失败日志**：每次寻标失败都记录日志。
- **寻标条件组合**：价格阈值与分均成交额阈值必须同时满足。
- **换标后持仓处理**：若旧标的仍有持仓，则先撤销该方向全部未成交买入订单，再执行移仓（卖出旧标的全部持仓；完全成交后触发自动寻标并占位，再按“接近但小于”原则买入新标的）。
- **移仓市值基准**：使用旧标的卖出完全成交后的实际资金作为新标的买入上限。
- **回收价刷新时机**：换标完成后立刻调用 `warrantQuote` 更新回收价缓存。
- **席位与配置**：自动寻标成功仅更新运行时席位，不写回配置文件。
- **寻标触发冷却**：同一方向 30 秒内只允许触发一次自动寻标。
- **席位为空信号**：席位为空时产生的买入信号直接丢弃并记录日志。
- **换标触发频率**：仅在行情价格变化时检查换标条件。
- **移仓卖出委托类型**：固定使用 ELO（增强限价单）。
- **移仓买入委托类型**：固定使用 ELO（增强限价单）。
- **移仓数量取整**：买入数量向下取整到最小买卖单位（lotSize）。
- **回收价获取失败**：视为换标失败，席位保持空并记录错误。
- **延迟信号清理**：换标时清理该方向所有待验证信号。
- **任务队列清理**：换标时清理该方向买卖队列中待处理信号。
- **挂单撤销范围**：换标前仅撤销未成交买入订单，卖出挂单不撤。
- **寻标前置条件**：同一方向若仍有持仓或未成交买入挂单，不执行寻标；先完成撤单与旧持仓卖出，再启动寻标；寻标成功占位后才允许买入新标的。
- **撤单范围**：撤销包含部分成交在内的所有未完成买入订单（New/Partial/WaitToNew/WaitToReplace/PendingReplace）。
- **旧卖单失败处理**：换标后旧标的卖出挂单若撤单/失败，不重新触发移仓卖出。
- **可用持仓为 0**：若 `availableQuantity=0`，不执行移仓卖出，直接进入换标流程；总持仓>0 视为已有卖出挂单未成交，保持等待。
- **仅挂单无持仓**：若仅有未成交买入挂单，撤单完成后立刻寻标。
- **标的名称更新**：自动寻标/换标成功后立即更新 `monitorContext.longSymbolName/shortSymbolName`。
- **启动时最后交易标的**：按该监控标的+方向的“最新成交订单”（不区分买/卖）确定标的。
- **启动无历史且无持仓**：满足开盘延迟后立即自动寻标。
- **非交易时段寻标**：不允许，必须在 `canTradeNow=true` 时执行。
- **撤单失败处理**：换标时若撤销未成交买入订单失败，视为换标失败，席位保持空并记录错误。
- **移仓卖出未成交**：卖出旧标的订单失败或未成交时持续等待成交，不进行新标的分配。
- **移仓后寻标失败**：卖出完成后如未找到新标的，席位保持空，等待下次寻标。
- **换标期间卖出信号**：触发换标后立即清空席位，不再生成新的卖出信号；仅允许已存在的卖出挂单继续执行，并由移仓流程处理旧标的持仓。
- **开盘保护期寻标**：开盘保护期内不执行自动寻标。
- **寻标成功订阅**：自动寻标成功后立即订阅新标的行情。
- **旧标的退订**：换标完成后立即取消旧标的行情订阅。
- **移仓寻标时点**：先卖出旧标的并完全成交后再寻标，占位后按“接近但小于”原则买入新标的。
- **换标立即清席位**：触发换标后立即将该方向席位设为 `null`，并阻止任何买入。
- **席位为空重试寻标**：席位为空时允许每 30 秒重试自动寻标。
- **寻标黑名单**：不需要对近期否决标的建立黑名单。
- **指标缓存写入**：换标期间暂停旧标的方向的指标写入，其他标的不受影响。
- **指标缓存清理**：换标时清空旧标的在 `indicatorCache` 中的历史快照。
- **上市天数过滤**：不需要。
- **寻标开关粒度**：监控标的级别全开/全关（做多/做空一起）。
- **分均成交额阈值**：牛/熊分别配置。
- **下午分母计算**：13:00 以后分均成交额分母包含上午 150 分钟。
- **行情未到占位**：新标的已订阅但行情未到时允许暂时占位，等待首个行情到达后再继续。
- **行情等待上限**：不设上限，持续等待首个行情到达。
- **warrantList 失败**：视为寻标失败，席位保持空并记录错误。
- **寻标结果数量**：只取最优一个标的，其余忽略。
- **行情未到但席位已占用**：买入信号直接丢弃，原因标记为“行情未就绪”（不按席位空处理）。
- **卖出无行情**：允许生成并执行卖出信号，若因无行情导致交易失败则按失败处理。
- **寻标候选数量**：不限制候选数量，处理完整列表（这里指不限制api返回数量）。
- **发行商过滤**：不需要。
- **priceType 过滤**：不需要。
- **warrantList 分页**：不需要分页，单次完整调用。
- **成交额>0过滤**：寻标时先过滤 `turnover > 0` 再计算分均成交额。
- **价格阈值比较**：使用 `price >= threshold`。
- **分均成交额阈值比较**：使用 `turnoverPerMinute >= threshold`。
- **自动寻标关闭且标的为空**：视为配置错误，阻止启动。
- **自动寻标开启时配置标的**：忽略配置标的，完全由自动寻标决定。
- **多方向寻标结果**：做多与做空方向独立，成功方向正常交易，失败方向保持空。
- **监控标的行情缺失**：不阻止自动寻标。
- **call_price/to_call_price**：不作为寻标筛选条件。
- **订阅失败处理**：新标的订阅失败视为寻标失败，席位保持空并记录错误。
- **启动顺序约束**：自动寻标只能在账户/持仓缓存初始化完成后执行；启动流程必须先完成账户/持仓获取与 `positionCache` 初始化，再进入寻标与席位初始化。
- **换标触发来源**：仅距回收价比值越界触发换标。
- **到期日过滤**：支持配置 `AUTO_SEARCH_EXPIRY_MIN_MONTHS_N`，默认 3 个月。
- **寻标排序**：价格最低优先，价格相同则分均成交额最高优先。
- **分均成交额分母**：使用 `getTradingMinutesSinceOpen` 计算已开盘分钟数。
- **筛选顺序**：先按“当前价 > 价格阈值”过滤，再按“分均成交额阈值”过滤。
- **标的状态过滤**：仅筛选正常交易状态（Normal）的牛熊证。
- **开盘 5 分钟逻辑**：仅对上午开盘有效；下午开盘不等待。
- **stockName 解析规则**：使用 `monitorSymbol` 去掉 `.HK` 与 `stockName` 匹配归属（例如 `HSI.HK` → `HSI`）。
- **末日保护遗漏**：若旧标的仍有持仓，末日保护需能覆盖旧标的（动态集合）。
- **缓存污染**：`orderAPIManager` 与 `orderStorage` 必须支持按 symbol 清理缓存，避免旧标的污染新席位。

**Tech Stack:** TypeScript, Node.js, LongPort OpenAPI

---

### Task 1: 新增配置与类型

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/config/config.trading.ts`
- Modify: `src/config/config.validator.ts`（如有配置校验）
- Modify: `README.md`

**Step 1: 定义配置类型**
- 新增 `AutoSearchConfig`（每个监控标的独立）：
  - `autoSearchEnabled`
  - `autoSearchMinPriceBull` / `autoSearchMinPriceBear`
  - `autoSearchMinTurnoverPerMinuteBull` / `autoSearchMinTurnoverPerMinuteBear`
  - `autoSearchExpiryMinMonths`
  - `autoSearchOpenDelayMinutes`（默认 5）
  - `switchDistanceRangeBull` / `switchDistanceRangeBear`

**Step 2: 解析环境变量**
- 在 `config.trading.ts` 中解析 `_N` 后缀配置，并给出合理默认值。

**Step 3: 更新文档**
- 在 `README.md` 配置表中追加以上配置说明。

**Step 4: 运行类型检查**
- Run: `npm run type-check`
- Expected: 无 TypeScript 错误

---

### Task 2: 交易分钟数计算工具

**Files:**
- Modify: `src/utils/helpers/tradingTime.ts`
- Create: `tests/tradingMinutes.js`

**Step 1: 新增 helper**
- 添加 `getTradingMinutesSinceOpen(date: Date): number`
- 逻辑参考 `tests/getWarrants.js`，使用 `getHKTime()` 计算分钟数。
- 不单独处理半日交易日：仅在 `canTradeNow=true` 时调用即可。

**Step 2: 写脚本测试**
```javascript
import { strict as assert } from 'node:assert';
import { getTradingMinutesSinceOpen } from '../src/utils/helpers/tradingTime.js';

const mkUtc = (hh, mm) => new Date(Date.UTC(2026, 0, 2, hh, mm));
assert.equal(getTradingMinutesSinceOpen(mkUtc(1, 30)), 0);  // 09:30 HK
assert.equal(getTradingMinutesSinceOpen(mkUtc(2, 0)), 30);  // 10:00 HK
```

**Step 3: 运行测试**
- Run: `node tests/tradingMinutes.js`
- Expected: 无报错

---

### Task 3: 自动寻标服务化（基于 warrantList.turnover）

**Files:**
- Create: `src/services/autoSymbolFinder/index.ts`

**Step 1: 定义入口函数**
- `findBestWarrant({ ctx, monitorSymbol, isBull, tradingMinutes, minPrice, minTurnoverPerMinute, expiryMinMonths })`

**Step 2: 获取 warrantList**
- 使用 `warrantList`：
  - 按成交额排序（降序）
  - `expiryDateFilters` >= 3 个月
  - `status=Normal`
  - `warrantType=Bull/Bear`

**Step 3: 逐个筛选并择优**
- 过滤条件：
  - `price > minPrice`
  - `turnoverPerMinute >= minTurnoverPerMinute`
- 选优规则：
  - 价格更低优先
  - 价格相同则 `turnoverPerMinute` 更高优先

**Step 4: 无结果处理**
- 无满足条件时返回 `null`，不抛异常。

---

### Task 4: 自动寻标与席位管理状态机

**Files:**
- Create: `src/services/autoSymbolManager/index.ts`
- Modify: `src/services/monitorContext/index.ts`
- Modify: `src/types/index.ts`

**Step 1: 定义席位状态**
- `SeatStatus = 'READY' | 'SEARCHING' | 'SWITCHING' | 'EMPTY'`
- `SeatState = { symbol: string | null; status: SeatStatus; lastSwitchAt?: number }`

**Step 2: 提供核心接口**
- `ensureSeatOnStartup()`：根据持仓/订单初始化席位  
- `maybeSearchOnTick()`：满足开盘延迟后触发寻标  
- `maybeSwitchOnDistance()`：回收价比值越界触发换标  
- `clearSeat()`：换标时立即清空席位，防止误买  

**Step 3: 换标后回收价刷新**
- 在席位切换为新标的后调用 `warrantQuote` 更新该方向回收价缓存
- 同步更新 `monitorContext` 的 `longSymbolName/shortSymbolName`（用于日志显示）

**Step 4: SeatVersion 校验**
- 换标时递增 `seatVersion`
- 延迟信号与任务队列携带版本号，处理前必须匹配当前席位版本

**Step 5: 单方向单标的约束**
- 换标前必须确保旧标的无持仓/无挂单（强制撤单 + 平仓）
- 未完成平仓前，禁止为该方向分配新标的

---

### Task 5: 启动流程重排（全量订单一次获取）

**Files:**
- Modify: `src/index.ts`
- Modify: `src/core/orderRecorder/orderAPIManager.ts`
- Create: `src/core/orderRecorder/orderOwnershipParser.ts`
- Modify: `src/core/orderRecorder/index.ts`

**Step 1: 新增全量订单获取**
- `fetchAllOrdersFromAPI()`：直接调用 `historyOrders`（不传 symbol）+ `todayOrders`，合并去重

**Step 2: stockName 解析归属**
- 解析 `RC/RP + monitorSymbol` 判断所属监控标的与方向

**Step 3: 订单记录初始化**
- 从全量订单中过滤归属订单 → `refreshOrdersFromAllOrders()`  
- 未启用自动寻标的标的，按配置的 `longSymbol/shortSymbol` 过滤  
- 启用自动寻标的标的，按“最近一次交易标的”或持仓标的过滤  

**Step 4: 订单监控动态映射**
- `orderMonitor` 通过 `SymbolRegistry` 判断方向与所属监控标的
- 支持换标后继续监控旧标的挂单直到完成/撤单

---

### Task 6: 实时监控接入自动寻标

**Files:**
- Modify: `src/main/processMonitor/index.ts`
- Modify: `src/core/signalProcessor/index.ts`

**Step 1: 信号前置检查**
- 若席位为空，则该方向信号直接丢弃（记录日志）

**Step 2: 换标触发**
- 每次行情刷新检查回收价比值
- 若超出阈值 → `clearSeat()` → 触发寻标/移仓

**Step 3: 延迟信号无效化**
- 延迟验证通过时必须校验 `seatVersion`
- 若不匹配，直接丢弃并记录日志

---

### Task 7: 换标后缓存刷新与一致性

**Files:**
- Modify: `src/core/risk/warrantRiskChecker.ts`
- Modify: `src/utils/helpers/accountDisplay.ts`
- Modify: `src/core/orderRecorder/index.ts`

**Step 1: 回收价缓存更新入口**
- 新增 `refreshWarrantInfoForSymbol(symbol, isLong, quoteClient)`  
- 换标成功后必须调用一次以更新回收价缓存

**Step 2: 订单记录刷新**
- 换标后用新标的从“全量订单缓存”中过滤订单记录  
- 若无订单则记录为空并输出日志

**Step 3: 持仓与浮亏缓存更新**
- 换标后刷新持仓缓存与 `positionCache`
- 若该方向持仓存在，重新计算浮亏监控数据

---

### Task 8: 移仓流程

**Files:**
- Modify: `src/core/trader/index.ts`
- Modify: `src/core/trader/orderMonitor.ts`

**Step 1: 触发移仓**
- 若换标时仍有持仓：
  - 使用 ELO 卖出全部持仓
  - 完全成交后再寻标

**Step 2: 买入新标的**
- 以原持仓市值为上限，“接近但小于”原则下单

---

### Task 9: 动态行情订阅与交易标的列表

**Files:**
- Modify: `src/utils/helpers/quoteHelpers.ts`
- Modify: `src/index.ts`
- Modify: `src/main/mainProgram/index.ts`

**Step 1: 动态更新交易标的集合**
- 将 `lastState.allTradingSymbols` 改为动态维护  
- 席位变化时更新集合  

**Step 2: 行情获取与订单监控**
- `collectAllQuoteSymbols()` 同时包含监控标的 + 当前席位标的  
- `monitorAndManageOrders` 使用动态集合

**Step 3: WebSocket 订阅动态更新**
- 换标后调用 `subscribeSymbols([newSymbol])`
- 若旧标的无挂单/无持仓，可 `unsubscribeSymbols([oldSymbol])`

---

### Task 10: 验证与回归

**Step 1: 类型检查**
- Run: `npm run type-check`
- Expected: 无错误

**Step 2: 运行脚本**
- Run: `node tests/tradingMinutes.js`
- Expected: 无报错

**Step 3: 本地启动**
- Run: `npm run start`
- Expected: 日志中可见自动寻标/席位状态变更

---

## Module & Function 级改造清单（按文件列出）

### 1) 类型与配置

**`src/types/index.ts`**
- 新增/调整：`AutoSearchConfig`、`SeatStatus`、`SeatState`、`SeatVersion`、`SymbolRegistry`、`SeatUpdateResult`
- 扩展：`MonitorConfig` 增加自动寻标配置字段
- 扩展：`MonitorContext` 新增 `seatState`、`seatVersion`、`symbolRegistry`
- 扩展：`Signal` 增加 `seatVersion`（用于延迟验证/队列校验）

**`src/config/config.trading.ts`**
- 解析 `_N` 自动寻标配置（价格阈值、分均成交额阈值、开盘延迟等）
- 若开启自动寻标，允许 `longSymbol/shortSymbol` 为空
- 保留“单方向单标的”约束：任何时刻只允许一个席位标的

**`src/config/config.validator.ts`**
- 验证规则：自动寻标开启时，配置阈值必须完整有效
- 新增：`createMarketDataClient` 支持运行时订阅/退订（动态标的）
- 新增：监控标的别名配置校验（用于 `stockName` 归属解析）

---

### 2) 监控上下文与席位管理

**`src/services/monitorContext/index.ts`**
- 初始化 `seatState/seatVersion`（来自配置或启动订单/持仓推断）
- 暴露更新接口：`updateSeatState()`、`bumpSeatVersion()`

**`src/services/autoSymbolManager/index.ts`**（新增）
- `ensureSeatOnStartup()`：根据持仓/订单初始化席位
- `maybeSearchOnTick()`：开盘延迟后触发自动寻标
- `maybeSwitchOnDistance()`：距回收价阈值越界触发换标
- `clearSeat()`：换标时立即清空席位，阻断信号
- 强约束：换标前必须无持仓/无挂单

**`src/services/autoSymbolFinder/index.ts`**（新增）
- `findBestWarrant()`：使用 `warrantList.turnover` 计算分均成交额并择优
- 过滤：`price > minPrice`、`turnoverPerMinute >= threshold`
- 选优：价格低优先，价格相同选分均成交额高

---

### 3) 主循环与信号链路

**`src/index.ts`**
- 启动时全量订单一次获取
- 初始化 `SymbolRegistry` 与 `seatState`
- 替换静态 `allTradingSymbols` → 动态集合
- 启动时调用 `autoSymbolManager.ensureSeatOnStartup()`

**`src/main/mainProgram/index.ts`**
- 行情收集：使用动态席位标的集合
- 在每个监控标的处理前允许 `autoSymbolManager` 进行换标检查

**`src/main/processMonitor/index.ts`**
- 使用动态 `seatState.longSymbol/shortSymbol`
- 席位为空时直接跳过该方向信号生成
- 在生成/派发延迟信号前校验 `seatVersion`

**`src/core/strategy/index.ts`**
- 调整 `generateCloseSignals()` 签名，基于动态席位生成信号
- 席位为空时不生成对应方向信号

**`src/core/signalProcessor/index.ts`**
- `applyRiskChecks()` 使用动态席位标的
- 任何信号处理前校验 `seatVersion`

**`src/main/asyncProgram/delayedSignalVerifier/index.ts`**
- `addSignal()` 存储 `seatVersion`
- 触发验证通过时回查 `seatVersion`，不匹配直接丢弃

**`src/main/asyncProgram/buyProcessor/index.ts`**
- 处理前检查席位是否为空或版本是否一致
- 不一致直接丢弃并记录日志

**`src/main/asyncProgram/sellProcessor/index.ts`**
- 同买入处理器逻辑，必须通过席位版本校验

---

### 4) 行情订阅与动态标的集合

**`src/utils/helpers/quoteHelpers.ts`**
- `collectAllQuoteSymbols()` 改为接收 `monitorContexts` 或 `SymbolRegistry`
- 返回：监控标的 + 当前席位标的 + 必要的挂单标的

**`src/services/marketMonitor/index.ts`**（如涉及）
- 确保监控仅依赖动态行情数据，不依赖静态 symbol

---

### 5) 订单记录、缓存与聚合

**`src/core/orderRecorder/orderAPIManager.ts`**
- 新增 `fetchAllOrdersFromAPI()`（不传 symbol 获取全量）
- 新增 `clearCacheForSymbol(symbol)`
- 新增 `getAllOrdersFromCache()`

**`src/core/orderRecorder/orderOwnershipParser.ts`**（新增）
- `parseOwnership(stockName)`：解析 `RC/RP + monitorSymbol`
- 支持别名映射（如 `HSI.HK` → `HSI`）

**`src/core/orderRecorder/index.ts`**
- 新增 `refreshOrdersFromAllOrders(symbol, isLong, allOrders)`
- 换标后立即刷新新标的订单记录
- 旧标的订单记录必须清理

**`src/core/orderRecorder/orderStorage.ts`**
- 新增 `clearOrdersForSymbol(symbol, isLong)`
- 确保旧标的记录不会与新标的混用

---

### 6) 风险、回收价与浮亏

**`src/core/risk/warrantRiskChecker.ts`**
- 新增 `refreshWarrantInfoForSymbol(symbol, isLong, quoteClient)`
- 换标后更新回收价缓存并更新 `symbolName`

**`src/core/risk/unrealizedLossChecker.ts`**
- 新增 `clearDataForSymbol(symbol)`（换标后清理旧标的）
- 换标后调用 `refreshUnrealizedLossData()` 重新构建新标的浮亏数据

**`src/core/risk/index.ts`**
- 风险检查使用动态席位标的
- 买入前风险检查必须校验 `seatVersion`

---

### 7) 订单监控与交易执行

**`src/core/trader/orderMonitor.ts`**
- `isLongSymbolByConfig()` 替换为 `SymbolRegistry` 查询
- 监控动态标的，旧标的挂单未完成时继续监控

**`src/core/trader/index.ts`**
- 提供“换标前撤单/平仓”接口
- 移仓流程：卖出旧标的 → 成交 → 自动寻标 → 买入新标的

---

### 8) 末日保护与冷却

**`src/core/doomsdayProtection/index.ts`**
- 使用动态标的集合（席位标的 + 可能存在的旧标的持仓）
- 防止换标后遗漏清仓

**`src/services/liquidationCooldown/index.ts`**
- 保留 `monitorSymbol:direction` 作为 key
- 换标不改变 `monitorSymbol`，冷却逻辑不变

---

### 9) 缓存刷新入口

**`src/utils/helpers/accountDisplay.ts`**
- 新增 `refreshAccountAndPositions()`：供换标/移仓后统一刷新

**`src/utils/helpers/positionCache.ts`**
- 保持全量更新逻辑，换标后必须更新一次

---

### 10) 测试与参考脚本

**`tests/getWarrants.js`**
- 仅作参考；核心逻辑由 `AutoSymbolFinder` 实现

**`tests/tradingMinutes.js`**（新增）
- 测试 `getTradingMinutesSinceOpen()` 的时间计算正确性

