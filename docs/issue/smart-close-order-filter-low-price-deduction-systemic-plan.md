# 智能平仓订单记录过滤改造方案（低价整笔消除，全链路系统性修复）

## 1. 背景与目标

当前订单记录过滤逻辑依赖“买入价与卖出成交价比较”来识别剩余买入订单。该逻辑在卖出委托实时改价场景下会失真：  
卖出信号生成时依据的是“当前价下的盈利订单”，但最终成交价可能因改价而偏离，导致本地更新与重启重建都可能过滤错误。

本方案目标是将过滤依据从“价格比较”改为“与智能平仓一致的低价优先整笔消除”，并确保启动、运行、重建、风控口径一致，属于系统性重构，不采用兼容性补丁。

---

## 2. 现状问题（根因与链路）

### 2.1 现状规则（代码与文档一致，但业务上不稳）

- 文档规则：卖出数量不足时保留 `买入价 >= 卖出成交价` 的订单。  
  见：`.claude/skills/core-program-business-logic/SKILL.md`
- 启动/重建过滤：`orderFilteringEngine` 按“卖出成交价”过滤。  
  见：`src/core/orderRecorder/orderFilteringEngine.ts`
- 运行时成交更新：`updateAfterSell` 同样按“卖出成交价”过滤。  
  见：`src/core/orderRecorder/orderStorage.ts`

### 2.2 根因

- 卖出成交价在“实时监控+改单”机制下不是稳定边界；
- 真实不变式应是：每笔卖出只会从当时可卖买单中扣减“卖出数量”；
- 智能平仓本身是低买价优先卖出，因此回放/过滤应使用同一优先级。

### 2.3 影响链路

1. **运行中链路**：`orderMonitor -> recordLocalSell -> updateAfterSell`  
2. **启动/重建链路**：全量订单 -> `applyFilteringAlgorithm` -> 订单记录  
3. **风控链路**：`dailyLossTracker` 使用过滤引擎计算未平仓成本  

如果三条链路算法不一致，会出现“运行中正确、重启后错误”或“风控口径与持仓口径不一致”。

---

## 3. 可行性与合理性结论

### 3.1 结论

该方案**可行且合理**，前提是按“全链路统一算法”落地。

### 3.2 合理性依据

- 与智能平仓选单顺序一致（低价优先）；
- 与卖出改价机制解耦，不依赖最终成交价；
- 能同时覆盖运行时更新与重启重建；
- 可直接提升订单记录、浮亏计算、日内亏损偏移的一致性。

### 3.3 必须同时满足的约束

1. 过滤与本地更新必须共用同一个扣减策略函数；  
2. 只允许整笔订单参与消除，不允许在过滤阶段引入“按股拆分补丁”；  
3. 若存在系统外人工卖出且不遵循低价优先，系统只能按既定策略回放，需明确定义为业务边界。

---

## 4. 系统性修改方案（不保留旧规则）

### 4.1 统一策略内核（新增）

新增统一纯函数模块（建议）：  
`src/core/orderRecorder/sellDeductionPolicy.ts`

核心职责：

- 输入：候选买单列表、卖出数量；
- 排序：`executedPrice asc` -> `executedTime asc` -> `orderId asc`（稳定且可复现）；
- 扣减：从低到高整笔消除，直到消除量达到卖出数量或无单可消除；
- 输出：剩余买单列表（不依赖卖出成交价）。

> 说明：排序主键使用价格，时间与 orderId 仅用于同价稳定排序，保证重放一致性。

### 4.2 改造过滤引擎（启动/重建真相源）

文件：`src/core/orderRecorder/orderFilteringEngine.ts`

- 删除“按卖出成交价过滤”分支；
- 删除仅服务于旧逻辑的 `adjustOrdersByQuantityLimit` 路径；
- `applySingleSellOrderFilter` 改为调用统一扣减策略；
- 保留原有“按卖出时间顺序逐笔处理”“时间开区间合并”机制不变。

结果：全量订单重放不再受卖出成交价波动影响。

### 4.3 改造本地卖出更新（运行时链路）

文件：`src/core/orderRecorder/orderStorage.ts`

- `updateAfterSell` 在 `executedQuantity < totalQuantity` 分支不再按价格过滤；
- 改为对当前买单调用同一扣减策略函数；
- `executedPrice` 仅用于记录 `latestSellRecord`（展示/审计），不参与过滤。

结果：运行中成交后的订单记录与重启重建结果同构。

### 4.4 对齐智能平仓整笔语义（避免内部冲突）

文件：`src/core/orderRecorder/orderStorage.ts`

- `getProfitableSellOrders` 当前仍会构造“部分数量订单对象”（修改 `executedQuantity`）；
- 必须改为“仅选择完整订单”，避免与“整笔消除”原则冲突。

结果：智能平仓选单、防重占用、过滤回放三者语义一致。

### 4.5 文档与注释同步更新

- `.claude/skills/core-program-business-logic/SKILL.md` 的 3.2/3.3 章节；
- `orderFilteringEngine.ts` 顶部算法说明；
- `orderRecorder/index.ts`、`orderStorage.ts` 相关注释。

要求：删除所有“保留成交价 >= 卖出成交价”表述，统一为“低价优先整笔消除”。

---

## 5. 全链路一致性校验方案（必须）

### 5.1 核心一致性断言

对任一 `symbol + direction`，以下结果必须恒等：

1. **运行时路径**：按成交事件序列逐笔调用本地更新后的剩余买单；
2. **重建路径**：同一批历史订单一次性调用过滤引擎后的剩余买单。

若不一致，视为逻辑错误，不允许上线。

### 5.2 最小测试矩阵

1. **改单导致成交价低于部分买价**：旧逻辑会误删，新逻辑应稳定；  
2. **多笔卖出串行**：验证逐笔累计结果；  
3. **同价多单**：验证稳定排序重放一致；  
4. **卖出量大于等于总量**：应清空；  
5. **运行中后重启**：重建结果与重启前一致；  
6. **日内亏损偏移一致性**：`dailyLossTracker` 与订单记录口径一致。

---

## 6. 变更范围清单

必改代码：

- `src/core/orderRecorder/orderFilteringEngine.ts`
- `src/core/orderRecorder/orderStorage.ts`
- `src/core/orderRecorder/index.ts`（注释/调用口径）
- `src/core/riskController/dailyLossTracker.ts`（确保继续复用同一过滤引擎）
- （新增）`src/core/orderRecorder/sellDeductionPolicy.ts`

必改文档：

- `.claude/skills/core-program-business-logic/SKILL.md`
- 本 issue 文档（本文件）

---

## 7. 实施顺序（建议）

1. 提炼统一扣减策略函数并补纯函数单测；  
2. 改过滤引擎并验证重放场景；  
3. 改本地卖出更新并做“运行中 vs 重建”等价测试；  
4. 改智能平仓整笔选单；  
5. 回归风控（浮亏/日内亏损偏移）；  
6. 更新文档并做最终全链路回归。

---

## 8. 最终结论

该改造方向正确，且是对现有业务约束（智能平仓低价优先）的系统性收敛。  
只要严格执行“统一策略内核 + 启动/运行/重建同口径 + 整笔语义一致”，就能解决改单成交价导致的订单记录过滤错误，并避免后续风控与重建偏差。

## 二次验证

再次结论（可行性/合理性）

  - 现有问题真实存在：当前仍依赖“买入价 >= 卖出成交价”过滤（src/core/orderRecorder/orderFilteringEngine.ts:141、src/
    core/orderRecorder/orderStorage.ts:195），在卖单改价后不稳定。
  - 你的“低价单优先逐笔消除”与智能平仓一致（智能平仓低价优先见 src/core/orderRecorder/orderStorage.ts:477），业务语义对
    齐。
  - 该方案能同时修复两条主链：运行时成交更新（src/core/trader/orderMonitor.ts:173）和启动/重建重放（src/core/
    orderRecorder/index.ts:186）。
  - 还会直接影响日内亏损偏移计算（src/core/riskController/dailyLossTracker.ts:48），必须同步统一算法。

  必须同时修的关键点（否则不完整）

  - 过滤引擎改为“低价优先整笔消除”，彻底移除价格比较过滤。
  - 本地卖出更新改为同一扣减算法，不能保留旧“按卖价过滤”分支。
  - 智能平仓选单去掉“部分数量订单对象”（当前仍有，src/core/orderRecorder/orderStorage.ts:488），否则与你“订单整笔”原则冲
    突。
  - 待成交卖单占用同步要补齐：卖单合并改量/撤单时占用关系必须同步更新（src/core/trader/orderExecutor.ts:576、src/core/
    trader/orderExecutor.ts:595、src/core/trader/orderMonitor.ts:435）。

  更详细的系统性修改方案

  1. 建立统一扣减内核（唯一真相）
      - 新增 src/core/orderRecorder/sellDeductionPolicy.ts。
      - 规则：按 buyPrice asc -> executedTime asc -> orderId asc 稳定排序，整笔扣减。
      - 输出：remainingBuyOrders、deductedQuantity、invariantOk（用于一致性校验）。
  2. 重写启动/重建过滤引擎
      - 文件：src/core/orderRecorder/orderFilteringEngine.ts。
      - 删除旧逻辑：buyPrice >= sellPrice 过滤及其数量修正路径（src/core/orderRecorder/orderFilteringEngine.ts:141）。
      - applySingleSellOrderFilter 改为调用统一扣减内核。
      - 保留“按卖出时间顺序逐笔处理 + 时间开区间并回”框架不变。
  3. 重写运行时卖出更新
      - 文件：src/core/orderRecorder/orderStorage.ts。
      - updateAfterSell 中 executedQuantity < totalQuantity 分支不再按价格过滤（src/core/orderRecorder/
        orderStorage.ts:195）。
      - 改为调用同一扣减内核。
      - executedPrice 仅用于 latestSellRecord 审计/展示，不参与过滤判定。
  4. 统一“订单整笔”语义到智能平仓
      - 文件：src/core/orderRecorder/orderStorage.ts。
      - getProfitableSellOrders 禁止生成部分数量订单对象（src/core/orderRecorder/orderStorage.ts:488）。
      - 超限时仅返回完整订单集合，totalQuantity = sum(finalOrders)，可能小于 maxSellQuantity。
  5. 修正待成交占用的一致性（防重链路）
      - 文件：src/core/trader/orderExecutor.ts、src/core/trader/orderMonitor.ts、src/core/orderRecorder/
        orderStorage.ts。
      - REPLACE 合并改单后，必须同步更新 pendingSell 的 submittedQuantity/relatedBuyOrderIds（当前未更新）。
      - CANCEL_AND_SUBMIT 取消旧单后，必须立即释放旧占用（当前 cancelOrder 直接删 tracked，可能丢失取消回调占用释放，见
      - 更新 orderFilteringEngine.ts、orderStorage.ts、orderRecorder/index.ts 注释，删除所有“保留成交价 >= 卖出成交价”描
        述。
  7. 一致性验收（上线门槛）
      - 同一订单样本，以下两条结果必须完全一致：
          - 路径A：实时逐笔 recordLocalSell 后结果；
          - 路径B：全量历史 applyFilteringAlgorithm 重放结果。
      - 若不一致，判定失败，不可上线。
  8. 测试矩阵（最少）
      - 改价场景：卖单最终成交价低于部分买入价，结果仍正确。
      - 多笔卖出串行：逐笔累计一致。
      - 同价多单：稳定排序重放一致。
      - 卖单合并 REPLACE/CANCEL_AND_SUBMIT：占用不泄漏、不重复占用。
      - 重启一致性：重启前后订单记录一致。
      - 日内亏损偏移：dailyLossTracker 与订单记录口径一致。
