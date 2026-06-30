# Mean Deviation Extreme Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每日最大向上和向下偏移显示对应收盘价、累计 VWAP 与香港 K 线时间，并删除分钟数显示。

**Architecture:** 保持现有入口、纯计算和渲染边界；为分钟输入补充时间，在一次累计 VWAP 遍历中生成两个不可变极值快照。表格只消费新的统计结果，不引入额外查询、回退或二次计算。

**Tech Stack:** Bun、TypeScript、Longbridge SDK、bun:test

---

### Task 1: 用测试定义极值快照契约

**Files:**

- Modify: `tests/tools/meanDeviationAnalysis/utils.business.test.ts`

- [ ] **Step 1: 更新计算测试输入**

为每根分钟 K 线增加确定的 `timestamp`，断言向上与向下结果分别包含 `deviationPct`、`currentPrice`、`averagePrice` 和香港时间 `klineTime`。

- [ ] **Step 2: 增加相同极值保留最早时间测试**

构造两根偏移率相同的 K 线，断言严格比较不会覆盖第一根快照。

- [ ] **Step 3: 更新表格测试**

断言新增向上/向下当前价、均价、时间列，并断言不再包含 `分钟数`。

- [ ] **Step 4: 运行测试并确认 RED**

Run: `bun test tests/tools/meanDeviationAnalysis/utils.business.test.ts`

Expected: FAIL，原因是现有类型和结果尚无时间与极值详情字段。

### Task 2: 实现极值快照计算和渲染

**Files:**

- Modify: `tools/meanDeviationAnalysis/types.ts`
- Modify: `tools/meanDeviationAnalysis/utils.ts`

- [ ] **Step 1: 更新类型**

为 `MinuteDeviationCandle` 增加 `timestamp: Date`；定义 `DeviationExtremeSnapshot`；将 `DailyDeviationMetrics` 改为 `maxUpDeviation`、`maxDownDeviation` 和 `averageDeviationPct`，删除 `minuteCount`。

- [ ] **Step 2: 更新标准化逻辑**

`normalizeMinuteCandle` 传递 SDK `timestamp`。

- [ ] **Step 3: 更新单次遍历计算**

在计算累计 VWAP 时，以严格大于/小于替换对应极值快照，并将时间格式化为香港时区 `HH:mm`。

- [ ] **Step 4: 更新表格**

输出偏移率、当前价、均价与时间，删除分钟数列。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `bun test tests/tools/meanDeviationAnalysis/utils.business.test.ts`

Expected: PASS。

### Task 3: 验证入口时间传递

**Files:**

- Modify: `tests/tools/meanDeviationAnalysis/index.business.test.ts`
- Modify: `tools/meanDeviationAnalysis/types.ts`

- [ ] **Step 1: 更新 SDK 模拟数据**

为历史分钟 K 线提供香港交易时段对应的 `timestamp`。

- [ ] **Step 2: 更新入口输出断言**

断言输出同时包含极值价格、累计 VWAP、香港 K 线时间，并且不包含分钟数列。

- [ ] **Step 3: 运行入口测试**

Run: `bun test tests/tools/meanDeviationAnalysis/index.business.test.ts`

Expected: PASS。

### Task 4: 清理与完整验证

**Files:**

- Check: `tools/meanDeviationAnalysis/**`
- Check: `tests/tools/meanDeviationAnalysis/**`
- Check: repository references

- [ ] **Step 1: 搜索旧字段和生产表格旧表头**

依次运行：

```powershell
rg -n "minuteCount|maxUpDeviationPct|maxDownDeviationPct" tools/meanDeviationAnalysis tests/tools/meanDeviationAnalysis
rg -n "\| .*分钟数.*\|" tools/meanDeviationAnalysis
```

Expected: 两条命令均无匹配结果。

- [ ] **Step 2: 运行相关测试**

Run: `bun test tests/tools/meanDeviationAnalysis`

Expected: PASS。

- [ ] **Step 3: 运行全量格式化与静态验证**

依次运行：

```powershell
bun format
bun lint
bun type-check
```

Expected: 全部退出码为 0。

- [ ] **Step 4: 运行全量测试与构建**

依次运行：

```powershell
bun test
bun run build
```

Expected: 全部退出码为 0。

- [ ] **Step 5: 检查工作区与遗留进程**

检查最终 diff，并确认没有遗留 Bun、Node、TypeScript 测试或构建进程。
