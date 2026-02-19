# 启动流程与席位优先级调整实施方案
 
> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
 
**Goal:** 席位作为交易标的的唯一来源；自动寻标开启时不使用配置标的，席位确定后再执行席位相关初始化与交易流程。

**Architecture:** 以 `SymbolRegistry + SeatState/SeatVersion` 作为标的唯一事实源。启动阶段先完成账户/持仓与全量订单获取，基于"持仓优先 + 自动寻标"确定席位，席位确定后才初始化牛熊证信息、订单记录与浮亏监控；运行期所有模块仅从席位读取交易标的。
 
**Tech Stack:** TypeScript, Node.js, LongPort OpenAPI
 
---
 
## 现状与问题（基于当前实现）
- 自动寻标开启时，`symbolRegistry` 初始席位为空，导致启动时 `collectAllQuoteSymbols` 只包含监控标的，初始行情与名称缓存缺失席位标的。
- 席位占用发生在 `monitorContext` 创建之后，且订单记录/浮亏初始化仍直接读取配置标的，导致"席位已占用但初始化仍基于配置"的分裂状态。
- `mainProgram` 的订单成交后浮亏刷新映射基于配置标的构建，自动寻标切换后的标的可能无法刷新。
- `doomsdayProtection` 在撤单与清理订单记录时仍使用配置标的，自动寻标切换后可能遗漏席位标的。
- 运行期仍存在配置标的兜底路径，违背"席位唯一来源"的目标。
- 启动阶段未校验交易日/交易时段/开盘保护期，自动寻标可能在非交易时段初始化。
 
---
 
## 现状核查：仍使用配置标的的功能点
- `src/services/monitorContext/index.ts`：初始 `longQuote/shortQuote`、名称缓存与 `normalizedLong/ShortSymbol` 仍读取配置标的。
- `src/index.ts`：启动期牛熊证信息、订单记录与浮亏初始化在部分路径仍使用配置标的。
- `src/main/mainProgram/index.ts`：成交后刷新时构建 `monitorContextBySymbol` 仍用配置标的。
- `src/core/doomsdayProtection/index.ts`：撤单、清仓与订单记录清理仍使用配置标的。
- `src/core/trader/orderExecutor.ts`：`resolveMonitorConfigBySymbol` 存在配置兜底路径。
- `src/core/trader/orderMonitor.ts`：`resolveSeatOwnership` 在席位未命中时回退配置标的。
- `src/utils/helpers/quoteHelpers.ts`：`collectAllQuoteSymbols` 未传 `symbolRegistry` 时回退配置标的。
- `src/utils/helpers/index.ts`：`initMonitorState` 将配置标的写入 `MonitorState`（虽未被使用，但口径不一致）。

---

## 可行性与合理性分析
- **可行性高**：`SymbolRegistry`/`SeatVersion` 已成为运行时校验核心，买卖处理器、延迟验证与订单执行均基于席位版本，改动集中在席位确定阶段与配置直读清理。
- **合理性强**：席位唯一来源可避免"配置标的与席位标的并存"导致的风险检查、订单记录与浮亏监控错配。
- **依赖满足**：自动寻标仅依赖行情上下文与 `warrantList`，席位确定可在启动早期完成；席位相关初始化可延后执行，降低错误概率。
- **改造边界清晰**：配置仅用于校验与"自动寻标关闭时写入席位"，运行期交易标的不再读取配置。
 
---
 
## 方案设计与规则

### 席位作为唯一来源（核心规则）
- **自动寻标开启**：席位只能由"订单候选 + 持仓验证占位"或"寻标占位"得到，**严禁使用配置标的**。
- **自动寻标关闭**：席位固定为配置标的，不参与动态变更。
- **席位未就绪**：所有席位相关初始化与交易逻辑必须等待席位确定。
- **运行期统一约束**：订单监控、订单执行、风险检查、订单记录与末日保护均从席位读取交易标的。

### 自动寻标开启时的席位确定流程
1. **获取账户/持仓与全量订单**：用于席位归属判断与后续订单记录初始化。
2. **订单候选**：从全量订单中按监控标的 + 方向筛选最后一笔成交订单，得到候选标的。
   - **归属判断**：使用全量订单的 `stockName` + 监控标的规则（RC/RP）确定监控标的与方向；无法归属则记录错误并跳过。
3. **持仓验证占位**：候选标的在持仓中存在且 `quantity > 0` 时，席位指向该标的。
4. **无匹配持仓则寻标占位**：调用 `warrantList` 过滤出符合条件的牛/熊证并占用席位。
5. **寻标失败**：席位保持为空，等待下一次寻标重试。

> 说明：该流程保证"席位唯一来源"，订单仅用于方向归属与候选标的，配置标的在自动寻标开启时不参与任何席位判断。

### 不采用的方案（已否决）
- **无持仓时使用配置标的占位**：与"自动寻标不使用配置值"冲突。
- **无匹配持仓时直接用最新订单标的占位**：会导致席位与持仓错配，阻塞寻标。
 
---
 
## 启动流程调整（建议顺序）
1. 加载环境变量 → 解析交易配置 → 创建 `symbolRegistry`。
2. `validateAllConfig` 成功后创建 `trader` 与 `marketDataClient`。
3. **启动时交易时段校验**（新增）：参考主循环逻辑校验交易日/交易时段/开盘保护期，满足条件才继续初始化。
4. **高优先级**：获取账户与持仓 → 初始化 `positionCache`（启动必要条件）。
5. **高优先级**：获取全量订单（历史 + 当日），用于席位归属与订单记录初始化。
6. **席位确定阶段**：
   - 自动寻标关闭：将配置标的直接写入席位（固定不变）。
   - 自动寻标开启：先用"最新订单候选 + 持仓匹配"占位；无匹配持仓则执行寻标占位（`warrantList`）。
7. 仅当席位确定后，继续执行席位相关初始化：
   - 计算 `allTradingSymbols`（基于席位）→ 获取 `initQuotesMap`。
   - 创建 `monitorContext`（使用席位标的行情与名称缓存）。
   - 初始化牛熊证信息、订单记录与浮亏数据（仅对席位标的）。
8. 注册延迟验证回调 → 启动买卖处理器 → 进入主循环。

> 自动寻标开启且无持仓时，必须等待寻标完成占位后再执行席位相关初始化；寻标失败则仅完成基础初始化并持续重试。
 
---
 
## 启动时交易时段门禁（新增需求）
- **触发时机**：在配置验证完成后（`validateAllConfig` 成功后），立即执行一次交易时段校验。
- **判定条件**：
  - `marketDataClient.isTradingDay` 返回交易日；
  - `isInContinuousHKSession` 为真；
  - 不处于开盘保护期（`isWithinMorningOpenProtection` 为假）。
- **处理策略**：条件不满足时暂停后续初始化，并按主循环节奏**每秒**重新判断（与主循环一致），直到满足条件再继续。
- **目的**：避免自动寻标在非交易时段或开盘保护期使用无效成交数据。

---

## 模块级修改清单（不止初始化）
- `src/index.ts`  
  - 启动阶段前置：账户/持仓与全量订单获取。  
  - 引入"席位确定阶段"（订单候选 + 持仓匹配占位 / 寻标占位）。  
  - 增加"启动时交易时段门禁"（交易日/时段/开盘保护期）。
  - 所有"初始化订单记录 / 浮亏 / 牛熊证信息"统一使用席位标的。
- `src/services/monitorContext/index.ts`  
  - 初始 `longQuote/shortQuote` 与名称缓存仅从席位标的读取（配置标的不再使用）。
- `src/main/mainProgram/index.ts`  
  - 订单成交后浮亏刷新映射从席位生成（而非配置）。
- `src/core/doomsdayProtection/index.ts`  
  - 撤单、清仓与订单记录清理基于席位标的；席位为空时跳过。
- `src/services/autoSymbolManager/index.ts`  
  - 自动寻标关闭时仅用于"席位初始化写入"，运行期不读取配置标的。
- `src/utils/helpers/quoteHelpers.ts`  
  - 行情订阅集合只依赖席位标的（自动寻标开启时不读取配置标的）。
- `src/core/trader/orderExecutor.ts`  
  - 订单归属解析仅使用席位映射，移除配置兜底路径。
- `src/core/trader/orderMonitor.ts`  
  - 订单归属解析仅使用席位映射，移除配置兜底路径。
- `src/core/risk/index.ts` / `src/core/orderRecorder/index.ts`  
  - 风险检查与订单记录刷新仅以席位标的为入口，杜绝配置标的路径。
- `src/core/orderRecorder/index.ts` / `src/core/orderRecorder/orderApiManager.ts` / `src/core/orderRecorder/types.ts` / `src/types/index.ts`  
  - 删除单标的订单拉取与刷新路径（`fetchOrdersFromAPI` / `refreshOrders`），订单记录仅允许从全量订单过滤（`refreshOrdersFromAllOrders`）。
- `src/utils/helpers/index.ts`  
  - `MonitorState` 中的 `longSymbol/shortSymbol` 改为席位来源或直接移除。
- `docs/startup-initialization-flow.md`  
  - 更新流程图与说明，体现"席位唯一来源 + 寻标完成后再初始化"。
 
---
 
## 风险与兼容性
- **席位未就绪**：自动寻标开启且寻标失败时，席位相关初始化会延后，需确保运行期补齐。
- **归属识别失败**：订单无法归属到监控标的与方向时，席位可能为空，需严格日志告警。
- **订单与持仓不一致**：候选标的无持仓时席位保持为空，需确保寻标可及时补齐。
- **启动阻塞风险**：若要求"席位就绪才能继续"，在非交易时段可能需降级为延后初始化。
- **交易时段门禁风险**：非交易日/非交易时段/开盘保护期会阻塞初始化，需明确等待策略与日志提示。
- **去配置兜底风险**：移除配置兜底后，任何未落席的信号/订单都应被明确丢弃并记录原因。
- **旧计划冲突**：`2026-01-29-auto-symbol-refactor` 中涉及"配置占位"内容需整体删除或改写。
 
---
 
## 验证策略（建议）
- 启动日志验证：打印席位初始化来源（订单候选+持仓占位 / 寻标占位 / 配置占位）。
- 非交易日/非交易时段/开盘保护期启动：验证初始化暂停并定期重试。
- 自动寻标开启且候选标的无持仓：验证不占位并触发寻标，不读取配置标的。
- 自动寻标开启且候选标的有持仓：验证席位使用该标的并归属正确监控标的与方向。
- 席位未就绪：验证席位相关初始化被延后，且后续补齐。
- 末日保护与成交刷新：验证仅覆盖席位标的。
- 代码扫描验证：交易链路中不再直接引用 `config.longSymbol/shortSymbol`。
- 代码扫描验证：`refreshOrders` / `fetchOrdersFromAPI` 已移除，订单记录仅从 `refreshOrdersFromAllOrders` 入口刷新。
 
---
 
### Task 1: 席位确定阶段与启动顺序前置
 
**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/autoSymbolManager/utils.ts`（或新增 `resolveSeatOnStartup` 辅助函数）
- Modify: `src/services/autoSymbolManager/index.ts`
 
**Step 1: Write the failing test**
```javascript
import assert from 'node:assert/strict';
import { resolveSeatOnStartup } from '../src/services/autoSymbolManager/utils.js';

// 仅示例：自动寻标开启且候选标的无持仓时不占位
const result = resolveSeatOnStartup({
  autoSearchEnabled: true,
  latestOrderSymbol: 'ABC.HK',
  hasPositionForLatest: false,
});
assert.equal(result, null);

const resultWithPosition = resolveSeatOnStartup({
  autoSearchEnabled: true,
  latestOrderSymbol: 'ABC.HK',
  hasPositionForLatest: true,
});
assert.equal(resultWithPosition, 'ABC.HK');
```
 
**Step 2: Run test to verify it fails**
 
**Step 3: Write minimal implementation**
- 在 `utils.ts` 中新增 `resolveSeatOnStartup`，实现"自动寻标开启时仅在候选标的有持仓时占位"的规则。
- 在 `src/index.ts` 增加启动门禁：交易日/交易时段/开盘保护期校验通过后才继续初始化。
 
**Step 4: Run test to verify it passes**
 
**Step 5: Commit**
```bash
git add src/services/autoSymbolManager/utils.ts src/services/autoSymbolManager/index.ts src/index.ts
git commit -m "feat: prioritize seat resolution during startup"
```
 
---
 
### Task 2: 启动初始化等待席位就绪
 
**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/monitorContext/index.ts`
 
**Step 1: Write the failing test**
- 增加最小化启动模拟脚本（若不便编写单测，可先记录日志断言预期）。
 
**Step 2: Run test to verify it fails**
Run: `npm run type-check`  
Expected: PASS（类型检查不失败，但日志断言未满足）
 
**Step 3: Write minimal implementation**
- 仅在席位就绪时初始化牛熊证信息、订单记录、浮亏数据。
- `monitorContext` 的初始 `longQuote/shortQuote` 只读取席位标的行情。
 
**Step 4: Run test to verify it passes**
Run: `npm run type-check`  
Expected: PASS
 
**Step 5: Commit**
```bash
git add src/index.ts src/services/monitorContext/index.ts
git commit -m "refactor: initialize risk/order/loss by seat symbols"
```
 
---
 
### Task 3: 运行期全链路仅使用席位标的
 
**Files:**
- Modify: `src/main/mainProgram/index.ts`
- Modify: `src/core/doomsdayProtection/index.ts`
- Modify: `src/utils/helpers/quoteHelpers.ts`
- Modify: `src/utils/helpers/index.ts`
- Modify: `src/core/trader/orderExecutor.ts`
- Modify: `src/core/trader/orderMonitor.ts`
- Modify: `src/core/risk/index.ts`
- Modify: `src/core/orderRecorder/index.ts`
 
**Step 1: Write the failing test**
- 增加脚本模拟"席位标的非配置标的"的刷新场景（可在日志中标记命中）。
 
**Step 2: Run test to verify it fails**
Run: `npm run type-check`  
Expected: PASS（日志断言未满足）
 
**Step 3: Write minimal implementation**
- 成交后浮亏刷新映射从 `symbolRegistry` 的席位生成。
- 末日保护撤单/清理订单记录使用席位标的，席位不可用时直接跳过。
- 行情订阅与订单归属解析不再使用配置兜底（`orderExecutor`/`orderMonitor`）。
- 风险检查与订单记录刷新入口统一走席位标的。
 
**Step 4: Run test to verify it passes**
Run: `npm run type-check`  
Expected: PASS
 
**Step 5: Commit**
```bash
git add src/main/mainProgram/index.ts src/core/doomsdayProtection/index.ts src/utils/helpers/quoteHelpers.ts src/utils/helpers/index.ts src/core/trader/orderExecutor.ts src/core/trader/orderMonitor.ts src/core/risk/index.ts src/core/orderRecorder/index.ts
git commit -m "refactor: use seat symbols across runtime flow"
```
 
---
 
### Task 4: 文档同步
 
**Files:**
- Modify: `docs/startup-initialization-flow.md`
- Modify: `docs/plan/2026-01-29-auto-symbol-refactor.md`（若需同步"席位唯一来源"要求）
 
**Step 1: Update flow doc**
- 更新启动流程图，突出"席位唯一来源 + 寻标完成后再初始化"。
 
**Step 2: Validate docs**
Run: `git diff -- docs/startup-initialization-flow.md`  
Expected: 流程图与说明已更新
 
**Step 3: Commit**
```bash
git add docs/startup-initialization-flow.md docs/plan/2026-01-29-auto-symbol-refactor.md
git commit -m "docs: update startup flow and seat priority"
```
