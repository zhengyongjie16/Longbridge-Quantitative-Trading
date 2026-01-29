# 启动流程与席位优先级调整实施方案
 
> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
 
**Goal:** 启动阶段尽早确定席位标的，且风险检查/订单记录/浮亏监控统一基于席位标的执行，确保开启自动寻标时流程一致与可控。
 
**Architecture:** 以 `SymbolRegistry + SeatState/SeatVersion` 作为标的唯一事实源。启动流程先完成账户/持仓与全量订单获取，再解析席位并占位，随后所有初始化与运行逻辑均从席位读取标的。
 
**Tech Stack:** TypeScript, Node.js, LongPort OpenAPI
 
---
 
## 现状与问题（基于当前实现）
- 自动寻标开启时，`symbolRegistry` 初始席位为空，导致启动时 `collectAllQuoteSymbols` 只包含监控标的，初始行情与名称缓存缺失席位标的。
- 席位占用发生在 `monitorContext` 创建之后，且订单记录/浮亏初始化仍直接读取配置标的，导致“席位已占用但初始化仍基于配置”的分裂状态。
- `mainProgram` 的订单成交后浮亏刷新映射基于配置标的构建，自动寻标切换后的标的可能无法刷新。
- `doomsdayProtection` 在撤单与清理订单记录时仍使用配置标的，自动寻标切换后可能遗漏席位标的。
 
---
 
## 可行性与合理性分析
- **可行性高**：代码已全面引入 `SymbolRegistry` 与 `SeatVersion`，`processMonitor`、买卖处理器、`orderExecutor`/`orderMonitor` 都已使用席位验证，调整启动顺序与部分“配置直读”即可闭环。
- **合理性强**：席位是动态标的的唯一事实源。风险检查、订单记录与浮亏监控若仍读取配置，必然在自动寻标开启时产生一致性缺口。
- **依赖符合**：账户/持仓与全量订单获取仅依赖 `trader` 与 `marketDataClient`，可在初始化早期完成，不与指标缓存/队列等耦合。
 
---
 
## 方案设计与优先级
 
### 推荐的席位初始化优先级（安全优先）
1. **已有持仓优先**：若方向上存在持仓（`quantity > 0`），席位必须指向该标的，避免遗漏风控与清仓。
2. **配置标的优先**：无持仓时，使用配置标的作为默认席位（满足“配置最高优先级”的需求）。
3. **最新成交标的**：若配置为空或无效，再使用全量订单中解析出的最新成交标的。
4. **空席位等待寻标**：仍无标的则保持席位为空，按开盘延迟与交易时段触发自动寻标。
 
> 说明：此规则在保证“配置优先”的同时，以持仓安全为最高优先级，避免持仓遗漏与清仓失效。
 
### 备选方案与权衡
- **方案 A（严格配置优先）**：配置 > 持仓/订单 > 自动寻标。  
  优点：完全遵循配置；缺点：可能忽略实际持仓，风险与清仓遗漏。
- **方案 B（安全优先，推荐）**：持仓 > 配置 > 订单 > 自动寻标。  
  优点：风险覆盖最完整；缺点：配置可能被持仓覆盖。
- **方案 C（配置优先但持仓兜底）**：配置为主，但检测到持仓时强制覆盖席位。  
  优点：兼顾配置与安全；缺点：实现稍复杂。
 
---
 
## 启动流程调整（建议顺序）
1. 加载环境变量 → 解析交易配置 → 创建 `symbolRegistry`。
2. `validateAllConfig` 成功后创建 `trader` 与 `marketDataClient`。
3. **高优先级**：获取账户与持仓 → 初始化 `positionCache`（启动必要条件）。
4. **高优先级**：获取全量订单（历史 + 当日），用于解析最新成交标的。
5. 按“席位初始化优先级”占位（写入 `symbolRegistry`），同步 `SeatVersion`。
6. 计算 `allTradingSymbols`（基于席位）→ 获取 `initQuotesMap`。
7. 创建 `monitorContext`（优先使用席位标的的行情与名称缓存）。
8. 基于席位标的初始化牛熊证信息、订单记录与浮亏数据。
9. 注册延迟验证回调 → 启动买卖处理器 → 进入主循环。
10. 若席位为空且自动寻标开启，在交易时段内立即执行一次启动寻标。
 
---
 
## 模块级修改清单
- `src/index.ts`  
  - 启动阶段前置：账户/持仓与全量订单获取。  
  - 引入席位初始化优先级解析函数。  
  - 所有“初始化订单记录 / 浮亏 / 牛熊证信息”统一使用席位标的。
- `src/services/monitorContext/index.ts`  
  - 初始 `longQuote/shortQuote` 与名称缓存优先读取席位标的（避免初始行情为空）。
- `src/main/mainProgram/index.ts`  
  - 订单成交后浮亏刷新映射从席位生成（而非配置）。
- `src/core/doomsdayProtection/index.ts`  
  - 撤单与清理订单记录改为席位标的；席位不可用时再回退配置。
- `docs/startup-initialization-flow.md`  
  - 更新流程图与说明，体现“账户/订单前置 + 席位优先”。
 
---
 
## 风险与兼容性
- **配置与持仓冲突**：若配置与实际持仓不一致，需以持仓为最高优先级，否则清仓与风控会失效。
- **席位为空**：必须统一阻断信号并记录原因；启动阶段可在交易时段尝试一次寻标。
- **旧计划冲突**：`2026-01-29-auto-symbol-refactor` 中“自动寻标开启忽略配置”需要同步修订，以匹配“配置优先”要求。
 
---
 
## 验证策略（建议）
- 启动日志验证：打印席位初始化来源（持仓/配置/订单/空席位）。
- 自动寻标开启且无持仓：验证席位先为配置标的，随后寻标可替换。
- 自动寻标开启且有持仓：验证席位直接使用持仓标的，风险与清仓命中。
- 订单成交后刷新：验证浮亏刷新命中席位标的。
- 末日保护：验证撤单/清仓覆盖席位标的。
 
---
 
### Task 1: 席位初始化与启动顺序前置
 
**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/autoSymbolManager/utils.ts`（或新增 `resolveSeatOnStartup` 辅助函数）
- Test: `tests/seat-init.js`
 
**Step 1: Write the failing test**
```javascript
import assert from 'node:assert/strict';
import { resolveSeatOnStartup } from '../src/services/autoSymbolManager/utils.js';
 
// 仅示例：优先级 = 持仓 > 配置 > 最新成交 > 空
const result = resolveSeatOnStartup({
  configSymbol: 'ABC.HK',
  latestTradedSymbol: 'XYZ.HK',
  positionSymbol: 'POS.HK',
});
assert.equal(result, 'POS.HK');
```
 
**Step 2: Run test to verify it fails**
Run: `node tests/seat-init.js`  
Expected: FAIL with "resolveSeatOnStartup is not a function"
 
**Step 3: Write minimal implementation**
- 在 `utils.ts` 中新增 `resolveSeatOnStartup`，实现优先级逻辑。
 
**Step 4: Run test to verify it passes**
Run: `node tests/seat-init.js`  
Expected: PASS (无输出)
 
**Step 5: Commit**
```bash
git add tests/seat-init.js src/services/autoSymbolManager/utils.ts src/index.ts
git commit -m "feat: prioritize seat resolution during startup"
```
 
---
 
### Task 2: 启动初始化统一改用席位标的
 
**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/monitorContext/index.ts`
 
**Step 1: Write the failing test**
- 增加最小化启动模拟脚本（若不便编写单测，可先记录日志断言预期）。
 
**Step 2: Run test to verify it fails**
Run: `npm run type-check`  
Expected: PASS（类型检查不失败，但日志断言未满足）
 
**Step 3: Write minimal implementation**
- 初始化牛熊证信息、订单记录、浮亏数据统一使用 `symbolRegistry` 中的席位标的。
- `monitorContext` 的初始 `longQuote/shortQuote` 读取席位标的行情。
 
**Step 4: Run test to verify it passes**
Run: `npm run type-check`  
Expected: PASS
 
**Step 5: Commit**
```bash
git add src/index.ts src/services/monitorContext/index.ts
git commit -m "refactor: initialize risk/order/loss by seat symbols"
```
 
---
 
### Task 3: 运行期刷新与末日保护改用席位
 
**Files:**
- Modify: `src/main/mainProgram/index.ts`
- Modify: `src/core/doomsdayProtection/index.ts`
 
**Step 1: Write the failing test**
- 增加脚本模拟“席位标的非配置标的”的刷新场景（可在日志中标记命中）。
 
**Step 2: Run test to verify it fails**
Run: `npm run type-check`  
Expected: PASS（日志断言未满足）
 
**Step 3: Write minimal implementation**
- 成交后浮亏刷新映射从 `symbolRegistry` 的席位生成。
- 末日保护撤单/清理订单记录使用席位标的，席位不可用时回退配置。
 
**Step 4: Run test to verify it passes**
Run: `npm run type-check`  
Expected: PASS
 
**Step 5: Commit**
```bash
git add src/main/mainProgram/index.ts src/core/doomsdayProtection/index.ts
git commit -m "refactor: use seat symbols for refresh and doomsday"
```
 
---
 
### Task 4: 文档同步
 
**Files:**
- Modify: `docs/startup-initialization-flow.md`
- Modify: `docs/plan/2026-01-29-auto-symbol-refactor.md`（若需同步“配置优先”要求）
 
**Step 1: Update flow doc**
- 更新启动流程图，突出“账户/订单前置 + 席位优先”。
 
**Step 2: Validate docs**
Run: `git diff -- docs/startup-initialization-flow.md`  
Expected: 流程图与说明已更新
 
**Step 3: Commit**
```bash
git add docs/startup-initialization-flow.md docs/plan/2026-01-29-auto-symbol-refactor.md
git commit -m "docs: update startup flow and seat priority"
```
