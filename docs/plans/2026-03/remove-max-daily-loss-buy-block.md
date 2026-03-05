# 剔除 MAX_DAILY_LOSS_N 超阈值禁止买入检查

> 日期：2026-03-05
> 状态：待审批
> 影响范围：风控核心层、配置层、注入层、测试层、文档层

---

## 1. 背景

当前系统在买入执行链路中存在一项"超阈值禁止买入"风控检查：当单方向持仓浮亏超过 `MAX_DAILY_LOSS_N`（代码中为 `maxDailyLoss`）时，拒绝该方向的新买入操作。

该检查与系统已有的 **保护性清仓（`maxUnrealizedLossPerSymbol`）+ 买入冷却（`liquidationCooldown`）** 闭环存在功能重叠，且可能导致不合理的交易拦截。

## 2. 现有机制说明

### 2.1 超阈值禁止买入（待剔除）

| 配置项             | 代码字段       | 默认值 | 作用                                |
| ------------------ | -------------- | ------ | ----------------------------------- |
| `MAX_DAILY_LOSS_N` | `maxDailyLoss` | 1500   | 浮亏 ≤ -maxDailyLoss 时**禁止买入** |

- **检查位置**：`src/core/riskController/index.ts` → `checkBeforeOrder` → `checkUnrealizedLossBeforeBuy`
- **数据来源**：与保护性清仓共用 `unrealizedLossChecker.getUnrealizedLossData(symbol)` 的 R1/N1 缓存
- **效果**：仅阻止买入，不触发清仓，持仓继续暴露于市场风险

### 2.2 保护性清仓 + 买入冷却（保留）

| 配置项                             | 代码字段                     | 默认值 | 作用                             |
| ---------------------------------- | ---------------------------- | ------ | -------------------------------- |
| `MAX_UNREALIZED_LOSS_PER_SYMBOL_N` | `maxUnrealizedLossPerSymbol` | 3000   | 浮亏 < -阈值时**触发保护性清仓** |

- **检查位置**：`src/core/riskController/unrealizedLossChecker.ts` → `check` → 由浮亏监控定时触发
- **清仓后行为**：
  1. 提交清仓单（类型由全局配置决定）
  2. 清空该标的订单记录
  3. 立即刷新浮亏缓存
  4. 累加清仓触发计数器
  5. 达到触发上限时写入冷却记录 → **买入冷却期内禁止买入**

### 2.3 两者数据源对比

两个检查共用完全相同的数据管道：

```
unrealizedLossChecker.refresh()
  → 写入 R1/N1 缓存（含 dailyLossOffset 调整）
    → getUnrealizedLossData(symbol) → { r1, n1 }
      ├─ maxDailyLoss 检查：R2 - R1 ≤ -maxDailyLoss → 禁买
      └─ maxUnrealizedLossPerSymbol 检查：R2 - R1 < -阈值 → 清仓
```

## 3. 冗余性全链路分析

### 3.1 场景 A：浮亏持续扩大

```
浮亏扩大 → 超过 maxDailyLoss(1500) → 禁止买入
         → 浮亏继续扩大 → 超过 maxUnrealizedLossPerSymbol(3000) → 保护性清仓
         → 累计触发 → 写入冷却 → 冷却期内禁止买入
```

**分析**：maxDailyLoss 的禁买仅比保护性清仓"提前"几秒到几分钟生效。在 1500-3000 的区间内，持仓仍暴露于市场，禁买本身无法阻止亏损扩大。最终仍由清仓+冷却兜底。

### 3.2 场景 B：浮亏在中间区域震荡

```
浮亏在 -1500 ~ -3000 之间反复波动
  → maxDailyLoss 持续触发禁买
  → maxUnrealizedLossPerSymbol 未触发清仓
  → 系统处于"持仓暴露但无法加仓"的尴尬状态
```

**分析**：此场景下禁买**阻止了可能有利的加仓摊低成本操作**，属于过度保守。若行情回升，错失的加仓机会不可挽回。

### 3.3 场景 C：浮亏回升

```
浮亏超过 maxDailyLoss(1500) → 禁买
  → 行情回升 → 浮亏收窄至 -1500 以内 → 禁买解除
```

**分析**：禁买期间错失了低价加仓的窗口。若行情快速反弹，禁买导致的机会成本不可忽视。

### 3.4 场景 D：保护性清仓后重新开仓

```
清仓 → 冷却期 → 冷却到期
  → lossOffsetLifecycleCoordinator 重置分段偏移
  → 新周期 R1 从零开始 → maxDailyLoss 检查自然通过
```

**分析**：冷却到期后分段偏移已重置，maxDailyLoss 在新周期内不会基于旧亏损拦截。即使没有该检查，冷却机制已充分控制了清仓后的再开仓时机。

### 3.5 dailyLossOffset 导致的误拦截

当日内已实现亏损偏移（dailyLossOffset）为负值时，会抬高 R1：

```
adjustedR1 = baseR1 - dailyLossOffset（dailyLossOffset ≤ 0）
→ adjustedR1 ≥ baseR1
→ unrealizedPnL = R2 - adjustedR1 更易为负
→ 更容易触及 maxDailyLoss 阈值
```

这意味着当日已有实现亏损后，即使当前持仓浮亏很小，maxDailyLoss 也可能因历史亏损偏移而误拦截新买入。

## 4. 去除后的风控完备性验证

去掉 `maxDailyLoss` 后，买入执行链路仍保留以下风控检查（顺序固定）：

| 顺序 | 检查项                 | 代码位置         | 说明                                 |
| ---- | ---------------------- | ---------------- | ------------------------------------ |
| 1    | 风险检查冷却（10s）    | buyProcessor     | 避免高频风控查询                     |
| 2    | 交易频率限制           | buyProcessor     | 同监控标的同方向最小买入间隔         |
| 3    | **保护性清仓冷却检查** | buyProcessor     | minutes / half-day / one-day 禁买    |
| 4    | 买入价格限制           | buyProcessor     | 当前价不得高于该标的该方向最新买入价 |
| 5    | 末日保护拒买           | buyProcessor     | 收盘前15分钟禁止买入                 |
| 6    | 牛熊证风险检查         | checkWarrantRisk | 回收价距离/价格下限/监控价有效性     |
| 7    | 现金充足性             | checkBeforeOrder | HKD 可用现金 ≥ 下单金额              |
| 8    | 持仓市值上限           | checkBeforeOrder | 单标的持仓市值上限控制               |

加上持续运行的监控链路：

- **浮亏监控** → 超过 `maxUnrealizedLossPerSymbol` → **保护性清仓**
- **清仓成交** → 累加触发计数 → 达到上限 → **写入买入冷却**
- **冷却到期** → `lossOffsetLifecycleCoordinator` 重置分段 → 新周期

风控链路完整，无遗漏。

## 5. 结论

| 维度       | 判定                                             |
| ---------- | ------------------------------------------------ |
| 功能冗余性 | 与保护性清仓+冷却高度重叠，提供的增量保护可忽略  |
| 误拦截风险 | dailyLossOffset 抬高 R1 后易触发不合理的买入拒绝 |
| 业务影响   | 去除后风控链路完整，无安全缺口                   |
| 可行性     | 可行，修改范围明确且可控                         |
| 合理性     | 合理，减少配置复杂度和不必要的交易限制           |

---

## 6. 详细剔除方案

### 6.1 配置层

#### 6.1.1 `src/config/config.trading.ts`

- **删除** `maxDailyLoss` 环境变量读取：
  ```typescript
  // 删除（约 L216）
  const maxDailyLoss = getNumberConfig(env, `MAX_DAILY_LOSS${suffix}`, 0) ?? 0;
  ```
- **删除** 返回对象中的 `maxDailyLoss` 赋值：
  ```typescript
  // 删除（约 L285）
  maxDailyLoss,
  ```

#### 6.1.2 `src/config/config.validator.ts`

- **删除** `maxDailyLoss` 的校验逻辑（约 L270-272）：
  ```typescript
  // 删除
  if (!Number.isFinite(config.maxDailyLoss) || config.maxDailyLoss < 0) {
    errors = [...errors, `${prefix}: MAX_DAILY_LOSS_${index} 未配置或无效（必须为非负数）`];
    missingFields = [...missingFields, `MAX_DAILY_LOSS_${index}`];
  }
  ```
- **删除** 配置摘要日志中的 `maxDailyLoss` 输出（约 L653）：
  ```typescript
  // 删除
  logger.info(`单日最大亏损: ${monitorConfig.maxDailyLoss} HKD`);
  ```

#### 6.1.3 `src/types/config.ts`

- **删除** `MonitorConfig` 类型中的 `maxDailyLoss` 字段（L151）：
  ```typescript
  // 删除
  readonly maxDailyLoss: number;
  ```

#### 6.1.4 `.env.example`

- **删除** `MAX_DAILY_LOSS_1=1500`（L126）
- **删除** `# MAX_DAILY_LOSS_2=1500`（L222）

### 6.2 风控核心层

#### 6.2.1 `src/core/riskController/index.ts`（核心修改）

1. **删除** `maxDailyLoss` 变量声明及其验证逻辑（L56-64）：

   ```typescript
   // 删除
   let maxDailyLoss = options.maxDailyLoss ?? 0;
   if (!Number.isFinite(maxDailyLoss) || maxDailyLoss < 0) {
     logger.warn(
       `[风险检查警告] maxDailyLoss 配置无效（${maxDailyLoss}），将使用默认值 0（禁止任何浮亏）`,
     );
     maxDailyLoss = 0;
   }
   ```

2. **删除** `checkUnrealizedLossForSymbol` 函数（L121-171）：

   ```typescript
   // 删除整个函数
   function checkUnrealizedLossForSymbol(...): RiskCheckResult | null { ... }
   ```

3. **删除** `checkUnrealizedLossBeforeBuy` 函数（L173-202）：

   ```typescript
   // 删除整个函数
   function checkUnrealizedLossBeforeBuy(...): RiskCheckResult { ... }
   ```

4. **删除** `checkBeforeOrder` 中的浮亏禁买检查段（L280-290）：

   ```typescript
   // 删除
   if (isBuy) {
     const unrealizedLossResult = checkUnrealizedLossBeforeBuy(
       signal,
       longCurrentPrice,
       shortCurrentPrice,
     );
     if (!unrealizedLossResult.allowed) {
       return unrealizedLossResult;
     }
   }
   ```

5. **删除** `checkBeforeOrder` 参数中的 `longCurrentPrice` 和 `shortCurrentPrice`（已确认这两个参数在函数内**仅**被 `checkUnrealizedLossBeforeBuy` 消费，无其他用途）：
   - 删除参数类型定义中的 `longCurrentPrice` 和 `shortCurrentPrice`（L214-215）
   - 删除解构赋值中的 `longCurrentPrice` 和 `shortCurrentPrice`（L223-224）

6. **同步删除** `src/types/services.ts` 中 `checkBeforeOrder` 接口定义的 `longCurrentPrice` 和 `shortCurrentPrice`（L741-742）

7. **同步删除** `src/core/signalProcessor/riskCheckPipeline.ts` 中调用 `checkBeforeOrder` 时传入的 `longCurrentPrice` 和 `shortCurrentPrice`（L275-276 变量声明 + L283-284 传参）

8. **更新** 文件头注释（L9-14），移除 `maxDailyLoss` 相关描述：

   ```typescript
   // 删除此行
   // * - 买入风控阈值：maxDailyLoss（浮亏超过阈值则拒绝新开仓）
   ```

   同时更新 `checkBeforeOrder` 的 JSDoc（L205），将"账户数据有效性 → 港币可用现金 → 浮亏限制 → 持仓市值限制"改为"账户数据有效性 → 港币可用现金 → 持仓市值限制"

9. **清理** 不再需要的 import（已确认使用情况）：
   | import | 仅被待删除代码使用 | 处理 |
   |--------|---------------------|------|
   | `decimalLte` | 是（仅 L154） | **删除** |
   | `decimalNeg` | 是（仅 L154） | **删除** |
   | `IS_DEBUG` | 是（仅 L141） | **删除** |
   | `decimalMul` | 否（`buildUnrealizedLossMetrics` L103） | 保留 |
   | `decimalSub` | 否（`buildUnrealizedLossMetrics` L106） | 保留 |
   | `decimalToNumberValue` | 否（`buildUnrealizedLossMetrics` L107） | 保留 |
   | `toDecimalValue` | 否（`buildUnrealizedLossMetrics` L97） | 保留 |
   | `formatDecimal` | 否（`checkBeforeOrder` L272-275） | 保留 |
   | `decimalLt` | 否（`checkBeforeOrder` L269） | 保留 |
   | `isBuyAction` | 否（`checkBeforeOrder` L233） | 保留 |
   | `isValidPositiveNumber` | 否（`buildUnrealizedLossMetrics` L99） | 保留 |

#### 6.2.2 `src/core/riskController/types.ts`

- **删除** `RiskCheckerDeps.options` 中的 `maxDailyLoss` 字段（L158）：
  ```typescript
  // 删除
  readonly maxDailyLoss?: number | null;
  ```

### 6.3 注入层

#### 6.3.1 `src/index.ts`

- **删除** 创建 `riskChecker` 时传入的 `maxDailyLoss`（约 L459）：
  ```typescript
  // 删除
  maxDailyLoss: monitorConfig.maxDailyLoss,
  ```

### 6.4 测试层

#### 6.4.1 `tests/core/riskController/index.business.test.ts`

该文件共 5 个测试用例，逐一分析：

| #   | 测试名称                                                                   | 涉及 maxDailyLoss                                                      | 处理方式                                                                                | 理由                             |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | `rejects buy when HKD available cash is insufficient`                      | options 传入 maxDailyLoss: 1000，但测试目标是现金不足拒绝              | **保留，删除 options 中的 maxDailyLoss 并删除 longCurrentPrice/shortCurrentPrice 参数** | 测试现金检查逻辑，与浮亏禁买无关 |
| 2   | `rejects buy when unrealized loss exceeds configured maxDailyLoss`         | 核心测试浮亏禁买功能                                                   | **整个用例删除**                                                                        | 测试目标就是待剔除的功能         |
| 3   | `allows sell when account data is unavailable`                             | options 传入 maxDailyLoss: 100，但测试目标是卖出跳过检查               | **保留，删除 options 中的 maxDailyLoss 并删除 longCurrentPrice/shortCurrentPrice 参数** | 测试卖出放行逻辑，与浮亏禁买无关 |
| 4   | `returns position limit checker rejection after passing buy preconditions` | options 传入 maxDailyLoss: 1000，但测试目标是持仓市值限制              | **保留，删除 options 中的 maxDailyLoss 并删除 longCurrentPrice/shortCurrentPrice 参数** | 测试持仓限制逻辑，与浮亏禁买无关 |
| 5   | `builds unrealized-loss metrics from cached R1/N1 and current price`       | options 传入 maxDailyLoss: 1000，但测试目标是 getUnrealizedLossMetrics | **保留，删除 options 中的 maxDailyLoss**                                                | 测试指标构建逻辑，与浮亏禁买无关 |

**详细修改清单：**

1. **删除** 第 2 个测试用例整体（L76-102）：

   ```typescript
   // 删除整个 it 块
   it('rejects buy when unrealized loss exceeds configured maxDailyLoss', () => { ... });
   ```

2. **修改** 第 1、3、4 个测试用例的 `createRiskChecker` 调用——删除 `options: { maxDailyLoss: ... }`：

   ```typescript
   // 修改前
   const checker = createRiskChecker({
     warrantRiskChecker: createWarrantCheckerStub(),
     unrealizedLossChecker: createUnrealizedLossCheckerStub(),
     positionLimitChecker: createPositionLimitCheckerStub(),
     options: { maxDailyLoss: 1_000 },
   });
   // 修改后
   const checker = createRiskChecker({
     warrantRiskChecker: createWarrantCheckerStub(),
     unrealizedLossChecker: createUnrealizedLossCheckerStub(),
     positionLimitChecker: createPositionLimitCheckerStub(),
   });
   ```

3. **修改** 第 5 个测试用例同上——删除 `options: { maxDailyLoss: 1_000 }`。

4. **修改** 第 1、3、4 个测试用例的 `checkBeforeOrder` 调用——删除 `longCurrentPrice` 和 `shortCurrentPrice` 参数：

   ```typescript
   // 修改前
   const result = checker.checkBeforeOrder({
     account: createAccountSnapshotDouble(500),
     positions: [],
     signal: createSignalDouble('BUYCALL', 'BULL.HK'),
     orderNotional: 5_000,
     currentPrice: 5,
     longCurrentPrice: 5,
     shortCurrentPrice: 5,
   });
   // 修改后
   const result = checker.checkBeforeOrder({
     account: createAccountSnapshotDouble(500),
     positions: [],
     signal: createSignalDouble('BUYCALL', 'BULL.HK'),
     orderNotional: 5_000,
     currentPrice: 5,
   });
   ```

5. **更新** 文件头注释（L4-6），移除"日内亏损"相关描述：
   ```typescript
   // 修改前
   * - 验证风控组合（日内亏损/持仓/浮亏）场景意图与业务期望。
   // 修改后
   * - 验证风控组合（持仓/浮亏）场景意图与业务期望。
   ```

**保留用例的安全性验证**：

- 用例 1 测试的是 `checkBeforeOrder` 中 L264-278 的现金充足性检查，该检查在浮亏禁买之前执行，不受影响。
- 用例 3 测试的是 `checkBeforeOrder` 中 L243-246 的卖出无账户放行逻辑，且验证 `positionLimitCalls === 0`（卖出无账户时整体提前返回），不受影响。
- 用例 4 测试的是 `checkBeforeOrder` 中 L292-301 的持仓市值限制检查，删除浮亏禁买后该检查仍在原位置执行，不受影响。
- 用例 5 测试的是 `getUnrealizedLossMetrics` 方法（通过 `buildUnrealizedLossMetrics` 实现），该函数不依赖 `maxDailyLoss`，不受影响。

### 6.5 Mock 工厂层

#### 6.5.1 `mock/factories/configFactory.ts`

- **删除** `createMonitorConfig` 工厂函数中的 `maxDailyLoss: 3000,`（L34）
- **影响范围确认**：该工厂被 31 个测试文件引用，但所有引用处均通过 `createMonitorConfig()` 获取完整的 `MonitorConfig` 对象。删除 `maxDailyLoss` 字段后，由于 `MonitorConfig` 类型同步移除了该字段，工厂返回值仍然类型完整，**不会导致任何测试编译失败**。

### 6.6 文档层

#### 6.6.1 `README.md`

- **删除** `MAX_DAILY_LOSS_1=20000` 配置示例及其注释（约 L103）

#### 6.6.2 `docs/issues/protective-liquidation-cooldown-loss-offset-redesign-2026-03-02.md`

- **更新** L169 的描述，移除 `maxDailyLoss` 拒买的引用：

  ```markdown
  // 修改前

  - 浮亏口径仍可能触发 `maxDailyLoss` 拒买。
    // 修改后（删除该行或改为标注该功能已移除）
  - ~~浮亏口径仍可能触发 `maxDailyLoss` 拒买。~~（该检查已在 2026-03-05 剔除）
  ```

### 6.7 不受影响的模块（无需修改）

以下模块虽然与浮亏/亏损相关，但不依赖 `maxDailyLoss`，无需修改：

| 模块                              | 说明                                                      |
| --------------------------------- | --------------------------------------------------------- |
| `unrealizedLossChecker.ts`        | 使用 `maxUnrealizedLossPerSymbol`，与 `maxDailyLoss` 无关 |
| `unrealizedLossMonitor.ts`        | 保护性清仓逻辑，不涉及禁买检查                            |
| `dailyLossTracker.ts`             | 维护 dailyLossOffset，仍被浮亏监控使用                    |
| `lossOffsetLifecycleCoordinator/` | 冷却到期后重置分段，不涉及 `maxDailyLoss`                 |
| `liquidationCooldown/`            | 冷却机制，独立于 `maxDailyLoss`                           |
| `postTradeRefresher/`             | 成交后刷新，仅刷新缓存数据                                |

---

## 7. 风险评估

| 风险项       | 等级 | 说明                                                             |
| ------------ | ---- | ---------------------------------------------------------------- |
| 功能回归     | 低   | 删除的是独立的禁买检查，不影响其他风控路径                       |
| 现有持仓影响 | 无   | 不影响已有持仓和卖出逻辑                                         |
| 配置兼容性   | 低   | 已有 `.env` 中的 `MAX_DAILY_LOSS_N` 配置将被忽略（代码不再读取） |
| 测试覆盖     | 低   | 删除相关测试即可，不影响其他测试逻辑                             |

## 8. 修改文件完整清单

| #   | 文件路径                                           | 操作      | 说明                                                        |
| --- | -------------------------------------------------- | --------- | ----------------------------------------------------------- |
| 1   | `src/config/config.trading.ts`                     | 删除      | 移除环境变量读取和返回赋值                                  |
| 2   | `src/config/config.validator.ts`                   | 删除      | 移除校验逻辑和日志输出                                      |
| 3   | `src/types/config.ts`                              | 删除      | 移除 MonitorConfig.maxDailyLoss 字段                        |
| 4   | `.env.example`                                     | 删除      | 移除 MAX_DAILY_LOSS_1 和 MAX_DAILY_LOSS_2                   |
| 5   | `src/core/riskController/index.ts`                 | 删除+清理 | 核心：移除 3 个函数、参数、import                           |
| 6   | `src/core/riskController/types.ts`                 | 删除      | 移除 RiskCheckerDeps.options.maxDailyLoss                   |
| 7   | `src/types/services.ts`                            | 删除      | 移除 checkBeforeOrder 的 longCurrentPrice/shortCurrentPrice |
| 8   | `src/core/signalProcessor/riskCheckPipeline.ts`    | 删除      | 移除变量声明和传参                                          |
| 9   | `src/index.ts`                                     | 删除      | 移除注入 maxDailyLoss                                       |
| 10  | `mock/factories/configFactory.ts`                  | 删除      | 移除 maxDailyLoss: 3000                                     |
| 11  | `tests/core/riskController/index.business.test.ts` | 删除+修改 | 删除 1 个用例，修改 4 个用例                                |
| 12  | `README.md`                                        | 删除      | 移除配置示例                                                |
| 13  | `docs/issues/...redesign-2026-03-02.md`            | 更新      | 标注该检查已移除                                            |

## 9. 验证清单

- [ ] `bun run type-check` 通过
- [ ] `bun test` 全部通过
- [ ] `bun run lint` 无新增警告
- [ ] 手动确认 `.env` 中残留的 `MAX_DAILY_LOSS_N` 不会导致启动报错
