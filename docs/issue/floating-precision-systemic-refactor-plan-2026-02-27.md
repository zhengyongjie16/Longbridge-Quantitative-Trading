# 全项目浮点精度问题系统性重构方案（2026-02-27）

## 1. 背景与二次分析结论

在你已完成首轮修复后，本次二次分析结论是：项目仍存在“数值域不统一”问题，浮点风险并未在全链路被根治。

二次扫描结果（`src/`）：

- 高风险金额/价格算术命中约 `61` 处（乘法、除法、累计、均价、R1/R2/PnL）。
- 风控/换标/阈值比较命中约 `292` 处（`< <= > >=`）。
- `Decimal -> number` 转换调用命中约 `52` 处。
- `Math.floor/取模/toFixed(2)/parseFloat` 关键命中约 `29` 处。

核心结论：当前是“局部点状修复”，不是“统一数值语义”。

## 2. 本方案范围与约束

### 2.1 重构目标（必须同时满足）

1. 建立唯一数值域：所有交易决策口径统一使用 `Decimal`，禁止决策链路使用 `number` 参与金融计算。
2. 清除双轨口径：移除“同一业务既有 Decimal 比较又有 number 比较”的并存状态。
3. 保持业务语义不变：比较边界（包含/不包含）与现有业务规则完全一致。
4. 一次性完成：不引入兼容分支、补丁函数、过渡开关。

### 2.2 非目标

1. 不改变策略逻辑（买卖信号定义、风控顺序、席位状态机语义不变）。
2. 不改变交易规则常量（阈值数值、最小价格差等业务参数不变）。
3. 不做“临时 epsilon 容忍补丁”。

### 2.3 明确禁止项（防止补丁化）

1. 禁止继续新增 `Math.abs(a - b) < threshold` 这类 `number` 决策比较。
2. 禁止保留旧 `number` 路径并叠加“仅关键点 Decimal”的兼容式写法。
3. 禁止通过 `toFixed + parseFloat` 伪装精度修复。

## 3. 目标架构（最终态）

### 3.1 数值域三层模型

1. 输入边界层（API/配置/行情）
- 外部数据（SDK Decimal、string、number）统一在入口转换为 `Decimal`。

2. 业务计算层（核心域）
- 所有金额、价格、数量、百分比、PnL、距离阈值计算统一使用 `Decimal`。
- 仅使用统一比较器进行 `< <= > >= ==` 语义判断。

3. 输出边界层（日志/展示）
- 仅在日志与展示时格式化为字符串或 number。
- 展示转换不得回流至业务决策。

### 3.2 统一数值组件（新增）

新增模块（建议）：

- `src/core/numeric/types.ts`
- `src/core/numeric/utils.ts`

统一提供：

1. 入口转换：`toDecimalStrict`（非法值直接失败，不默认吞成 0）。
2. 比较器：`decimalLt/Lte/Gt/Gte/Eq`。
3. 运算器：`decimalAdd/Sub/Mul/Div/Floor/Abs/Neg`。
4. 整手校验：`isLotMultiple(quantity, lotSize)`（Decimal 取余）。
5. 展示格式：`formatDecimal(value, digits)`（仅输出用途）。

## 4. 业务语义保持表（逻辑正确性核心）

以下比较语义必须逐项保持，不得改变边界：

| 业务场景 | 现语义 | 重构后语义（Decimal） |
| --- | --- | --- |
| 单标的浮亏清仓（`unrealizedLossChecker`） | `unrealizedLoss < -threshold` | `decimalLt(unrealizedLoss, threshold.neg())` |
| 买入前单日浮亏限制（`riskController/index`） | `unrealizedPnL <= -maxDailyLoss` | `decimalLte(unrealizedPnL, maxDailyLoss.neg())` |
| 牛证停买阈值 | `distancePercent < bullMin` | `decimalLt(distancePercent, bullMin)` |
| 熊证停买阈值 | `distancePercent > bearMax` | `decimalGt(distancePercent, bearMax)` |
| 静态距回收价清仓（牛） | `distancePercent <= threshold` | `decimalLte(distancePercent, threshold)` |
| 静态距回收价清仓（熊） | `distancePercent >= threshold` | `decimalGte(distancePercent, threshold)` |
| 距离换标越界 | `<= min || >= max` | `decimalLte(value, min) || decimalGte(value, max)` |
| 指标条件 `<`/`>` | 直接 number 比较 | Decimal 比较，边界语义不变 |

## 5. 数据结构重构（系统性，不留旧口径）

### 5.1 类型层统一（必须改）

涉及文件：

- `src/types/services.ts`
- `src/types/quote.ts`
- `src/types/account.ts`
- `src/core/riskController/types.ts`
- `src/core/orderRecorder/types.ts`

重构要求：

1. 交易决策字段改为 `Decimal`（价格、数量、成本、阈值、PnL、distancePercent）。
2. `UnrealizedLossData` 内 `r1/n1/baseR1/dailyLossOffset` 全改 `Decimal`。
3. `OrderRecord.executedPrice/executedQuantity` 改 `Decimal`。
4. 所有依赖这些字段的接口同步改签名，不保留旧 number 重载。

### 5.2 边界转换集中化

涉及文件：

- `src/utils/helpers/index.ts`
- `src/services/quoteClient/index.ts`
- `src/core/trader/accountService.ts`
- `src/core/orderRecorder/orderApiManager.ts`
- `src/core/trader/orderCacheManager.ts`

重构要求：

1. 仅边界模块允许读取 SDK Decimal/number/string。
2. 边界后输出统一为 `Decimal` 域对象。
3. 旧 `decimalToNumber` 从“决策可用工具”降级为“展示工具”；决策链路禁止使用。

## 6. 模块级完整改造清单

### 6.1 风控链路（最高优先）

涉及：

- `src/core/riskController/unrealizedLossChecker.ts`
- `src/core/riskController/index.ts`
- `src/core/riskController/dailyLossTracker.ts`
- `src/core/riskController/utils.ts`
- `src/core/riskController/positionLimitChecker.ts`
- `src/core/riskController/warrantRiskChecker.ts`

改造内容：

1. `R1/N1/R2/PnL` 全部改为 Decimal 运算。
2. `sumOrderCost/average/positionNotional` 全部用 Decimal 累计。
3. 所有阈值比较改为统一比较器。
4. 日内亏损偏移公式保持原定义：
- `realizedPnL = totalSell - totalBuy + openBuyCost`
- `realizedPnL > 0 => offset = 0`，否则 `offset = realizedPnL`
5. 浮亏刷新保持原定义：
- `adjustedR1 = baseR1 - dailyLossOffset`（dailyLossOffset 非正）

### 6.2 订单记录链路

涉及：

- `src/core/orderRecorder/utils.ts`
- `src/core/orderRecorder/orderStorage.ts`
- `src/core/orderRecorder/sellDeductionPolicy.ts`
- `src/core/orderRecorder/orderFilteringEngine.ts`

改造内容：

1. 成本统计与均价计算全部 Decimal。
2. “低价优先、整单不拆分”算法保持不变，仅数值类型替换。
3. 订单增量更新、重建、清仓后清理全部沿用旧流程，不改变时序。

### 6.3 交易执行链路

涉及：

- `src/core/trader/orderExecutor.ts`
- `src/services/autoSymbolManager/signalBuilder.ts`

改造内容：

1. 买入数量换算 `notional / price` 改 Decimal 除法+下取整。
2. 整手约束改 Decimal 取余判断，替代 `%`。
3. 显式数量校验与目标金额换算使用同一数值域，消除混算。

### 6.4 自动寻标/换标链路

涉及：

- `src/services/autoSymbolManager/switchStateMachine.ts`
- `src/services/autoSymbolManager/thresholdResolver.ts`
- `src/services/autoSymbolFinder/utils.ts`

改造内容：

1. `distancePercent`、`min/max range`、`turnover per minute` 等阈值比较统一 Decimal。
2. “越界触发换标”与“候选筛选”保持现有判定方向，边界语义不变。
3. `absDistance` 比较与并列打破规则（成交额优先）保留。

### 6.5 信号阈值与指标比较链路

涉及：

- `src/utils/helpers/signalConfigParser.ts`
- `src/services/indicators/utils.ts`
- `src/services/indicators/{rsi,mfi,kdj,macd,ema,psy}.ts`

改造内容：

1. `threshold` 解析后存储为 Decimal。
2. `evaluateCondition` 比较改 Decimal，不再直接用 number `<`/`>`。
3. 指标内部计算可继续使用 number（算法领域），但对外决策比较前统一转 Decimal。
4. `roundToFixed2` 仅保留展示语义，不再作为决策值来源。

### 6.6 订单监控链路

涉及：

- `src/core/trader/orderMonitor.ts`

改造要求：

1. 保持已完成的 Decimal 比较修复。
2. 将剩余 number 价格比较点统一收敛到 numeric utils。
3. 修改后禁止在该模块新增 number 差值判定。

## 7. 执行顺序（完整重构路径）

### 阶段 1：建立统一数值基础设施

1. 新增 numeric `types.ts/utils.ts`。
2. 定义统一比较与运算 API。
3. 新增禁止性 lint 规则（禁止决策层 `decimalToNumber`、禁止直接 `Math.abs(a-b)<x`）。

### 阶段 2：类型层一次性切换

1. 批量修改核心类型定义（OrderRecord、UnrealizedLossData、Risk metrics、Warrant distance）。
2. 同步调整工厂函数与依赖注入签名。
3. 移除旧 number 决策类型，不保留兼容别名。

### 阶段 3：边界层改造

1. 行情、账户、订单 API 输出统一转换到 Decimal 域。
2. 决策模块仅接收 Decimal 数据结构。

### 阶段 4：风控 + 订单记录主链改造

1. 完成风险计算与阈值比较替换。
2. 完成成本统计、均价、扣减算法替换。
3. 跑核心业务测试集。

### 阶段 5：执行链路 + 自动换标链路改造

1. 完成数量换算与整手校验替换。
2. 完成距离阈值、候选筛选替换。

### 阶段 6：策略阈值比较收口

1. 完成 signalConfigParser 的 Decimal 判定。
2. 指标数据输出与决策输入边界明确分层。

### 阶段 7：清理与收敛

1. 删除旧 number 决策辅助函数与死分支。
2. 全量扫描确保无遗留 number 金融决策计算。

## 8. 测试重构方案（必须同步）

### 8.1 必补测试矩阵

1. 风控边界：
- `unrealizedLoss < -threshold`（小于、等于、大于三点）
- `unrealizedPnL <= -maxDailyLoss`（小于、等于、大于三点）

2. 牛熊证边界：
- 牛证 `< threshold` 与 `== threshold`
- 熊证 `> threshold` 与 `== threshold`
- 清仓 `<= / >=` 双向边界

3. 数量换算：
- `notional/price` 在临界价下是否少一手
- `lotSize` 取余边界

4. 换标越界：
- `<= min`、`>= max`、区间内三类

5. 信号比较：
- 指标值与阈值在边界小数下的 `<`/`>` 一致性

### 8.2 已有测试复用与扩展

复用并扩展以下测试集：

- `tests/regression/order-monitor-regression.test.ts`
- `tests/core/trader/orderMonitor.business.test.ts`
- `tests/core/riskController/warrantRiskChecker.business.test.ts`
- `tests/core/orderRecorder/costAveragePrice.test.ts`
- `tests/utils/signalConfigParser.business.test.ts`
- `tests/services/autoSymbolManager/*`

### 8.3 验证命令

1. `bun run lint`
2. `bun run type-check`
3. `bun test`（至少执行风控、订单监控、换标、信号解析相关测试集）

## 9. 全链路正确性校验点

### 9.1 公式不变性

以下公式必须在重构前后结果一致（仅精度提升，不改语义）：

1. `R1 = Σ(price_i * quantity_i)`
2. `N1 = Σ(quantity_i)`
3. `R2 = currentPrice * N1`
4. `unrealizedLoss = R2 - R1`
5. `realizedPnL = totalSell - totalBuy + openBuyCost`

### 9.2 时序不变性

1. 风控执行顺序不变（冷却 -> 账户/持仓 -> 价格限制 -> 末日保护 -> 牛熊证 -> 基础风控）。
2. 订单记录更新顺序不变（成交 -> 本地更新 -> 偏移更新 -> 缓存刷新标记）。
3. 换标状态机迁移顺序不变（READY -> SWITCHING -> READY/EMPTY）。

### 9.3 边界不变性

所有比较的“开闭区间”保持现有业务契约，不允许在重构中被隐式更改。

## 10. 验收标准（Definition of Done）

1. `src/` 决策链路中不再存在 number 金融计算（金额/价格/数量/阈值比较）。
2. 所有关键比较统一通过 numeric utils 完成。
3. 旧 number 决策工具与临时补丁逻辑被删除。
4. 全量 lint/type-check 通过。
5. 核心业务测试与新增边界测试全部通过。
6. 回放以下历史问题场景无回归：
- 订单监控 1 tick 改单边界。
- 浮亏阈值触发边界。
- 距回收价换标边界。

## 11. 实施备注

本方案是完整系统重构方案，不包含兼容分支和补丁方案；执行时应按阶段落地，但最终必须一次收敛到“单一 Decimal 决策口径”。
