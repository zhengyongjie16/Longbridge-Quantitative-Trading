# 监控标的按配置指标计算与显示重构最终方案

## 1. 目标与边界

本次重构只实现以下需求，不扩展其它业务语义：

1. 每个监控标的仅计算其配置实际使用的技术指标。
2. 每个监控标的仅显示其配置实际使用的技术指标。
3. 指标族联动规则必须生效：
   - 使用 `K`/`D`/`J` 任一项时，必须计算并显示 `K`、`D`、`J` 三项。
   - 使用 `MACD`/`DIF`/`DEA` 任一项时，必须计算并显示 `MACD`、`DIF`、`DEA` 三项。
4. 除“指标计算与显示范围收敛”外，不改变原有交易业务链路（风控顺序、门禁、席位校验、延迟验证时序、下单逻辑）。

## 2. 修正点再次复核结论

对上版方案的 3 个修正点已复核，结论为“逻辑正确且符合需求”。

### 2.1 策略层改法修正：全局硬校验改为 action 范围校验

结论：正确，且是必要修正。

原因：

1. 现有 `validateBasicIndicators`/`validateAllIndicators` 属于全局硬校验，会隐式要求未配置指标存在。
2. 这与“仅基于配置指标”目标冲突。
3. 直接删除前置校验可能让策略行为过于宽松，风险在于引入非预期信号。
4. 最终方案采用“按 action 的配置指标集合校验”，既消除全局耦合，又保持信号判定边界可控。

### 2.2 指标画像类型落位修正：统一进入现有 types 模块体系

结论：正确，符合项目规范约束。

原因：

1. 指标画像是跨模块共享类型，必须有单一来源，避免散落重复定义。
2. 由统一类型模块承载可减少 `as` 断言与隐式结构匹配，降低类型漂移风险。

### 2.3 测试迁移修正：必须同步替换对 `rsiPeriods/emaPeriods/psyPeriods` 的依赖

结论：正确，且为回归安全前置条件。

原因：

1. 现有测试广泛依赖旧字段。
2. 不迁移测试就无法证明“只改指标范围，不改业务行为”。

## 3. 最终架构设计（单一真相）

新增并强制使用“监控标的指标画像”作为全链路唯一输入：

1. `IndicatorUsageProfile`（每个 monitor 一份，启动时编译，运行期只读）。
2. Profile 来源：`signalConfig + verificationConfig`。
3. Profile 内容：
   - `requiredFamilies`：`mfi/kdj/macd/adx`。
   - `requiredPeriods`：`rsi/ema/psy` 周期集合。
   - `actionSignalIndicators`：`BUYCALL/SELLCALL/BUYPUT/SELLPUT` 各自所需指标集合。
   - `verificationIndicatorsBySide`：`buy/sell` 延迟验证指标集合。
   - `displayPlan`：最终展示顺序与展示项。

指标族展开规则在“编译 profile”阶段一次完成，不在运行时重复推导：

1. 命中 `K|D|J` => `kdj=true`，显示 `K/D/J`。
2. 命中 `MACD|DIF|DEA` => `macd=true`，显示 `MACD/DIF/DEA`。
3. `RSI:n/EMA:n/PSY:n` 收集周期并去重排序。

## 4. 全链路改造方案

## 4.1 monitorContext 编译层

涉及：

1. `src/services/monitorContext/utils.ts`
2. `src/services/monitorContext/index.ts`
3. `src/types/state.ts`
4. `src/services/monitorContext/types.ts`

改造：

1. 新增 profile 编译函数（纯函数）。
2. `MonitorContext` 从旧的 `rsiPeriods/emaPeriods/psyPeriods` 切换到 `indicatorProfile`。
3. 删除默认周期注入逻辑（RSI/EMA/PSY）。

## 4.2 指标计算层

涉及：

1. `src/services/indicators/snapshotBuilder.ts`
2. `src/main/processMonitor/indicatorPipeline.ts`

改造：

1. `buildIndicatorSnapshot` 入参切换为 `indicatorProfile`。
2. 仅计算 profile 指定指标；未指定字段写 `null`。
3. 指纹复用、缓存推送、对象池释放逻辑保持不变。

## 4.3 策略层（关键修正）

涉及：

1. `src/core/strategy/index.ts`
2. `src/core/strategy/utils.ts`
3. `src/core/strategy/types.ts`

改造：

1. 移除全局基础指标硬校验入口。
2. 新增 `validateIndicatorsForAction`（按 action 配置指标集合校验）。
3. `evaluateSignalConfig` 仍作为唯一条件求值器；指标缺失继续按条件不满足处理。
4. 卖出“必须存在买单记录”规则保持不变。
5. 延迟信号 `indicators1` 仍仅记录当前 side 的验证指标初值。

## 4.4 展示与变化检测层

涉及：

1. `src/services/marketMonitor/index.ts`
2. `src/services/marketMonitor/types.ts`
3. `src/types/data.ts`

改造：

1. `monitorIndicatorChanges` 入参改为 `indicatorProfile`。
2. 变化检测仅覆盖 profile 指标。
3. 展示仅输出 `displayPlan` 指定项，并严格执行 KDJ/MACD 族联动。
4. `price/changePercent` 保持始终展示。

## 4.5 延迟验证与缓存层

涉及：

1. `src/main/asyncProgram/delayedSignalVerifier/index.ts`
2. `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
3. `src/main/asyncProgram/indicatorCache/index.ts`
4. `src/main/asyncProgram/indicatorCache/utils.ts`

改造：

1. 验证时序与比较规则不变（含 ADX 既有口径）。
2. 仅消费按需快照。
3. 增加一致性保护：verification 需要的指标在快照缺失时，按失败处理并输出明确原因。

## 4.6 受控不变项（确保不影响原业务）

以下模块仅“透传新参数”或“不改”：

1. `runSignalPipeline` 席位状态/版本/标的一致性校验不变。
2. `buyProcessor` 与 `riskCheckPipeline` 的风控顺序不变。
3. `sellProcessor` 智能平仓逻辑不变。
4. `dayLifecycleManager`、任务队列与门禁控制不变。

## 5. 不影响原业务逻辑的证明口径

## 5.1 不变行为

1. 信号分流、任务入队、对象池释放时机不变。
2. 延迟验证时间点（T0/T0+5s/T0+10s）和容忍度不变。
3. 买入风控顺序与卖出处理链路不变。
4. 交易日生命周期门禁不变。

## 5.2 唯一行为变化（即需求本身）

1. 仅收敛“指标计算集合与显示集合”。
2. 取消默认指标注入。
3. 策略由“全局指标存在性约束”变为“按 action 配置约束”。

这三项均是需求直接要求或其必要前提，不属于额外业务扩展。

## 6. TypeScript 规范执行要求（typescript-project-specifications）

实施时必须满足：

1. 禁止 `any`，未知类型用 `unknown`。
2. 禁止无依据 `as` 断言；必要断言必须有明确边界理由。
3. 共享类型单一来源，不重复定义等价类型。
4. 采用对象入参，避免超 7 参数函数。
5. 保持工厂函数 + 依赖注入模式，不在内部创建外部依赖。
6. 不保留兼容/补丁式双轨字段（旧字段彻底替换）。
7. 代码完成后必须通过：
   - `bun lint`
   - `bun type-check`

## 7. 实施阶段（最终版）

### 阶段 A：类型与编译器

1. 定义 `IndicatorUsageProfile`。
2. 编写 profile 编译函数与族展开规则。
3. MonitorContext 切换到 `indicatorProfile`。

### 阶段 B：计算链路改造

1. `snapshotBuilder` 改为按 profile 计算。
2. `indicatorPipeline` 参数改造与链路打通。

### 阶段 C：策略链路改造

1. 引入 action 范围校验。
2. 移除全局硬校验调用点。

### 阶段 D：展示链路改造

1. `marketMonitor` 改为按 profile 检测和显示。
2. 验证 KDJ/MACD 配套输出。

### 阶段 E：测试迁移与回归

1. 替换旧字段依赖测试。
2. 补齐按需计算/按需显示/族联动/多标的隔离测试。
3. 跑完整 lint + type-check + 关键业务测试。

## 8. 测试与验收标准

## 8.1 必测场景

1. 单标的仅配置 `K`：仅算 KDJ，仅显 K/D/J。
2. 单标的仅配置 `DIF`：仅算 MACD 族，仅显 MACD/DIF/DEA。
3. 单标的无 RSI 配置：不计算 RSI，不显示 RSI。
4. 多标的配置不同指标集合：互不串扰。
5. 延迟验证指标可正常读取并保持通过/失败语义。

## 8.2 通过标准

1. 任一标的日志不出现未配置指标。
2. 未配置指标计算函数不被调用。
3. KDJ/MACD 联动规则严格生效。
4. 风控、门禁、执行链路行为与重构前一致。
5. `bun lint` 与 `bun type-check` 全绿。

## 9. 最终结论

经再次全链路分析，修正点逻辑正确且与需求一致。  
本最终方案可在不改变交易业务主逻辑的前提下，完成“按配置指标计算与按配置指标显示”的系统性重构，并满足 TypeScript 项目规范要求。
