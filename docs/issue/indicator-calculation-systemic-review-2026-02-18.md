# 指标计算系统性复核报告（2026-02-18）

## 1. 复核目标

基于你的约束进行二次复核：

1. 允许保留 `ixjb94/indicators` 参考来源的第三方声明（`THIRD_PARTY_NOTICES.md` 必须存在）。
2. 重点检查"代码本身"是否仍有兼容旧写法残留、补丁式逻辑、冗余包装转发、或实质性计算问题。
3. 结论必须以可复现证据为基础。

## 2. 复核范围与方法

范围：

- 指标主链路：`src/main/processMonitor/indicatorPipeline.ts` -> `src/services/indicators/*.ts`
- 策略消费链路：`src/core/strategy/utils.ts`
- 配置/兼容相关：`src/utils/helpers/signalConfigParser.ts`
- 构建与脚本完整性：`package.json`

方法：

- 静态审查：逐文件查找兼容/适配语义、边界判断、对象池生命周期。
- 调用链审查：确认是否存在"仅包装转发"层。
- 动态验证：对横盘常数序列进行边界输入测试。
- 基础校验：`bun run type-check`、指标相关测试。

## 3. 总结结论

结论：**仍存在问题**，当前状态不能判定为"完全系统性且完整"的去兼容化重构。

关键点：

1. 存在一个明确的计算缺陷（MACD 零值被误判为无效）。
2. 存在明确的"兼容旧语义"残留（RSI 语义分支）。
3. 存在一处重构清理不完整（无效脚本残留）。
4. 指标快照对象池回收链路不完整（性能/一致性层面问题）。

## 4. 详细发现

### F1（严重）MACD 零值被当作无效值丢弃

- 位置：`src/services/indicators/macd.ts:163`
- 代码：`if (!lastMacd?.MACD || lastMacd.signal === undefined || lastMacd.histogram === undefined) { ... }`
- 问题：
  - `!lastMacd?.MACD` 会把 `0` 误判为 `false`，导致合法的 MACD=0 结果被直接丢弃。
- 复现：
  - 输入常数收盘价序列（60 个 100），执行 `calculateMACD`，实际输出 `null`。
  - 复现输出：`MACD(flat)= null`
- 影响：
  - `validateAllIndicators` 依赖 `macd` 有效：`src/core/strategy/utils.ts:44`、`src/core/strategy/utils.ts:49`
  - 横盘或弱趋势阶段可能错误地阻断信号流程。

### F2（重要）RSI 存在显式旧语义兼容残留

- 位置：
  - `src/services/indicators/rsi.ts:6`（注释"对齐旧输出语义"）
  - `src/services/indicators/rsi.ts:75`（`calculateRsiSeriesWithTechnicalPrecision`）
  - `src/services/indicators/rsi.ts:86`（非有限值直接返回 `100`）
- 问题：
  - 该分支属于典型"旧语义对齐"逻辑，不是纯新算法表达。
- 复现：
  - 常数序列下 `calculateRSI(closes, 6)` 输出 `100`。
  - 复现输出：`RSI6(flat)= 100`
- 影响：
  - 语义上偏向兼容旧行为，和"去兼容化"目标不一致。

### F3（重要）指标快照中的 `periodRecordPool` 对象未形成完整回收闭环

- 分配点：
  - `src/services/indicators/index.ts:85`（`rsi = periodRecordPool.acquire()`）
  - `src/services/indicators/index.ts:98`（`ema = periodRecordPool.acquire()`）
  - `src/services/indicators/index.ts:113`（`psyRecord = periodRecordPool.acquire()`）
- 回收点现状：
  - `releaseSnapshotObjects` 只回收 KDJ/MACD：`src/utils/helpers/index.ts:397`、`src/utils/helpers/index.ts:407`、`src/utils/helpers/index.ts:412`
  - 未见对快照内 `rsi/ema/psy` 的对应回收。
- 问题：
  - 对象池使用与回收策略不对称，形成"用了池但不闭环"的实现不一致。
- 影响：
  - 主要是性能/GC 压力风险，不是立即功能错误。

### F4（重要）重构清理不完整：遗留无效脚本

- 位置：`package.json:17`
- 配置：`"analyze-indicators": "bun tools/indicatorAnalysis.ts"`
- 实际：
  - `tools/indicatorAnalysis.ts` 文件不存在。
  - 执行 `bun run analyze-indicators` 失败：`Module not found "tools/indicatorAnalysis.ts"`。
- 影响：
  - 工程层面的可维护性问题，说明迁移清理未完成。

### F5（次要）旧格式兼容解析仍保留（非计算核心）

- 位置：`src/utils/helpers/signalConfigParser.ts:179`
- 注释：`不带括号的单个条件（兼容简单格式）`
- 说明：
  - 这不属于指标计算核心，但属于旧写法兼容路径残留。

## 5. 正向确认（已达成）

1. 第三方声明保留正确：
   - `THIRD_PARTY_NOTICES.md:5` 起明确记录 `ixjb94/indicators` 来源与涉及文件。
2. 运行时已无指标第三方包依赖：
   - `package.json` / `bun.lock` 检索 `technicalindicators`、`tulind`、`talib` 无命中。
3. 指标主调用链没有发现明显"仅透传包装器"：
   - `src/main/processMonitor/indicatorPipeline.ts:21`、`src/main/processMonitor/indicatorPipeline.ts:22` 直接调用指标构建函数与指纹函数。

## 6. 验证记录

1. `bun run type-check`：通过。
2. `bun test tests/services/indicators/business.test.ts tests/main/processMonitor/indicatorPipeline.business.test.ts`：通过（8 pass）。
3. 边界动态验证输出：
   - `MACD(flat)= null`
   - `RSI6(flat)= 100`
   - `MFI14(flat)= null`
   - `KDJ9(flat)= null`

测试缺口：

- 现有测试未覆盖 MACD 零值、横盘 RSI 语义等关键边界行为，因此未能暴露 F1/F2。

## 7. 最终判断

在"允许保留第三方声明"的前提下，当前实现仍有实质问题，不能认定为完全完成的系统性重构：

1. 存在明确计算缺陷（F1，严重）。
2. 存在兼容旧语义实现（F2）。
3. 存在工程和生命周期一致性问题（F3、F4）。

本报告仅做问题审查与证据归档，未改动业务代码。

## 8. 修复对照（补充，2026-02-18）

说明：本节为本报告的后续修复补充，逐项对应 F1~F5，且以"不改变原有业务逻辑"为原则。

| 问题ID | 修复状态 | 修复说明 | 关键文件 |
|---|---|---|---|
| F1 | 已修复 | 修正 MACD 末值判空逻辑，`0` 不再被当作无效值；仅修复错误判定，不改变 MACD 计算公式与参数。 | `src/services/indicators/macd.ts:164` |
| F2 | 已处理（语义残留清理） | 去除兼容语义命名/注释表达，保留原有计算行为与输出边界（包括非有限值回落 100 的既有行为）。 | `src/services/indicators/rsi.ts:6`, `src/services/indicators/rsi.ts:75`, `src/services/indicators/rsi.ts:87`, `src/services/indicators/index.ts:14`, `src/services/indicators/kdj.ts:26` |
| F3 | 已修复 | 在快照释放路径补齐 `ema/rsi/psy` 的池对象回收，仅在未被 `monitorValues` 引用时释放，避免影响现有对象引用语义。 | `src/utils/helpers/index.ts:393`, `src/utils/helpers/index.ts:405`, `src/utils/helpers/index.ts:417` |
| F4 | 已修复 | 删除失效脚本 `analyze-indicators`，保留有效脚本不变。 | `package.json:17` |
| F5 | 已处理（注释清理） | 将"兼容简单格式"注释改为中性描述，不改变解析逻辑。 | `src/utils/helpers/signalConfigParser.ts:179` |

## 9. 修复后验证（补充，2026-02-18）

### 9.1 回归测试

1. `bun run type-check`：通过。
2. `bun run lint`：通过。
3. `bun test`：通过（`239 pass, 0 fail`）。

### 9.2 指标边界验证

1. 新增用例：`tests/services/indicators/business.test.ts:107`  
用例名称：`keeps zero-value MACD as valid output on flat closes`。
2. 实测：横盘常数序列下 `calculateMACD` 结果为 `{ macd: 0, dif: 0, dea: 0 }`，不再返回 `null`。

### 9.3 与"原有逻辑不变"原则的符合性说明

1. 未改变策略触发条件与指标参数配置入口。
2. 未引入新的兼容分支、兜底分支或包装转发层。
3. 除 F1 缺陷修复外，其余调整为注释/命名清理与资源生命周期闭环修复。
