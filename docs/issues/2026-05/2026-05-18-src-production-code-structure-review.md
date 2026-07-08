# src 生产代码目录结构审查报告

审查日期: 2026-05-18  
审查范围: 仅限 `src/` 下生产代码的目录结构、模块语义、依赖边界与重复职责，不包含 tests、脚本、仓库根辅助文件或任何 `src/` 之外内容。

---

## 1. 总体结论

本次审查的结论可以概括为一句话：**项目核心业务层仍然稳定，但外围层同时存在少量明确的边界/组织问题，以及一批应按维护性问题处理的目录语义债。**

经二次独立复核后，本文将问题区分为“明确边界/组织问题”与“真实存在但应降级为维护性/语义问题的项”，避免把所有观察都写成同等强度。

当前架构并不存在“核心链路失控”或“必须推倒重建”的问题。相反，主运行链路依然清晰：

- 薄入口仍然成立：`src/index.ts:10`
- 顶层装配入口仍然清晰：`src/app/runApp.ts:84`
- 事件驱动主程序仍然明确：`src/main/businessEventProgram/index.ts:30`
- 生命周期重建链路仍然集中：`src/main/lifecycle/rebuildTradingDayState.ts:252`
- 外部行情适配器边界仍然清晰：`src/services/quoteClient/index.ts:276`

真正需要优化的不是核心业务逻辑，而是以下两类问题：

1. **明确的边界/组织问题**：`main/recovery` 中的通用 helper 反向泄漏到 `app`，`src/utils/utils.ts` 已形成 catch-all 文件，`src/types/queue.ts` 被提升到过高的全局层级
2. **真实存在但应降级处理的问题**：`orderRecorder` 边界未完全收口，`src/main`、`src/services`、`src/types/services.ts`、`src/constants/index.ts` 等位置的职责表达逐渐变宽

---

## 2. 正向结论（应明确保留的结构判断）

### 2.1 `src/core/` 整体仍然是当前仓库中最稳定的一层

`src/core/` 下的大多数目录名称与职责仍然基本一致，尤其是：

- `src/core/riskController/`
- `src/core/signalProcessor/`
- `src/core/orderRecorder/`
- `src/core/trader/`
- `src/core/strategy/`

这些模块仍然代表核心交易领域能力，而不是外围编排或展示逻辑。后续结构优化应优先收口外围层，不应优先扰动 `core` 本身。

### 2.2 `autoSymbolFinder` 与 `autoSymbolManager` 的拆分是合理的

虽然两者名称接近，但职责并不重复：

- `src/services/autoSymbolFinder/index.ts:218` 负责候选筛选
- `src/services/autoSymbolManager/index.ts:47` 负责席位/换标状态机编排

这是“筛选服务”与“流程编排器”的合理分层，不建议合并。

### 2.3 `src/types/orderRecorder.ts` 与 `src/core/orderRecorder/types.ts` 的双层类型划分是合理的

- `src/types/orderRecorder.ts:8` 暴露跨模块公共契约
- `src/core/orderRecorder/types.ts:18` 承载 `orderRecorder` 内部实现细节类型

这不是重复定义，而是公共契约与内部实现分离，应保持现状。

### 2.4 `positionCache` 虽然只有单创建点，但本质是共享运行态对象

- 创建点位于 `src/app/runtime/createPostGateRuntime.ts:238`
- 消费面分布在多条生产链路，例如 `src/main/utils.ts:18`、`src/main/lifecycle/rebuildTradingDayState.ts:252` 等

因此它属于“单装配点、多消费点”的共享运行态对象，而不是应被下沉的单链路私有模块。

---

## 3. 二次确认成立的问题

### 3.1 `orderRecorder` 边界尚未完全收口，但不宜定性为硬规范违规

> 状态：已修复（2026-05-21 复核确认）。当前依据：外部 owner 已统一通过 `src/core/orderRecorder/index.ts` 的正式边界使用相关能力，`tests/architecture/typeOrganization.test.ts` 也已阻止生产代码继续直接导入 `orderRecorder` 内部实现文件。

#### 现状

`src/core/trader/index.ts:53` 的 `createTrader` 直接拼装了 `orderRecorder` 的内部零件，相关证据包括：

- `src/core/trader/index.ts:41` 导入 `createOrderStorage`
- `src/core/trader/index.ts:42` 导入 `createOrderAPIManager`
- `src/core/trader/index.ts:43` 导入 `createOrderFilteringEngine`
- `src/core/trader/index.ts:78` 开始内部装配

同时，`src/app/runtime/createPostGateRuntime.ts:13` 直接拿了订单链路内部 helper：

- `src/app/runtime/createPostGateRuntime.ts:13` 导入 `createOrderFilteringEngine`
- `src/app/runtime/createPostGateRuntime.ts:14` 导入 `classifyAndConvertOrders`
- `src/app/runtime/createPostGateRuntime.ts:15` 导入 `resolveOrderOwnership`

并在 `src/app/runtime/createPostGateRuntime.ts:215` 至 `src/app/runtime/createPostGateRuntime.ts:220` 将其注入 `dailyLossTracker`。此外：

- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:34` 直接依赖 `resolveOrderOwnership`
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:206` 用它解析保护性清仓归属
- `src/core/trader/orderMonitor/recoveryFlow.ts:15` 也直接依赖 `resolveOrderOwnership`
- `src/main/recovery/seatPreparation.ts:28` 直接依赖 `getLatestTradedSymbol`

需要修正的是，`src/main/lifecycle/rebuildTradingDayState.ts` 本体并未直接导入 `orderRecorder` 内部 helper，而是通过 `monitorContext.orderRecorder.refreshOrdersFromAllOrdersForLong/Short` 这类 `OrderRecorder` 门面方法工作。因此“snapshot / rebuild 链路”不能合并表述为同一种直接穿透。

#### 问题

该问题真实存在，但二次复核后应更准确地表述为：`orderRecorder` 的内部构件与算法没有被正式边界完全收口，导致多个外部 owner 直接引用订单链路内部能力。

- `trader` 直接装配 `orderRecorder` 内部部件
- `app/runtime` 直接桥接订单链路内部 helper
- snapshot 加载链路仍直接依赖订单归属解析逻辑
- `orderMonitor` recovery flow 与 `main/recovery` 也直接依赖订单归属解析相关 helper

需要特别收紧的是：`riskController` 与订单算法确有语义依赖，但不应表述成它在源码级直接穿透了 `orderRecorder` 边界。

同时，这一项不宜定性为“明确违反 TypeScript 项目规范”。当前规范明确约束的是依赖注入、types/utils 组织、re-export、类型安全等规则；并没有一条硬规则禁止跨目录直接导入子模块 helper。因此它是**真实的边界未封口与维护性架构问题**，不是硬规范违规。

#### 建议

优先采用最小收口方案：

1. 将 `createOrderStorage`、`createOrderAPIManager`、`createOrderFilteringEngine`、ownership parsing、classification 等能力收口为 `orderRecorder` 的正式工厂或正式对外契约
2. 保持必要外部依赖显式注入，避免把 `TradeContext`、`rateLimiter` 等外部依赖改成在 `orderRecorder` 内部隐式创建
3. 对确实需要跨域共享的订单归属解析能力，先定义正式边界；只有在确认多个业务域都独立需要它时，再评估是否提炼为独立订单子域

当前最合适的顺序仍是“先封正式边界，再评估是否提炼订单域”，不应为了封装而引入兼容层、隐式依赖或大抽象。

### 3.2 `main/recovery` 内混放了恢复流程与通用 helper

> 状态：已修复（2026-05-21 复核确认）。当前依据：通用 seat helper 已迁到 `src/utils/seat/symbols.ts`，`src/app` 对 `main/recovery` 的反向依赖已消除，相关 architecture 护栏已建立。

#### 现状

`src/main/recovery/seatPreparation.ts:146` 中的 `prepareSeatsForRuntime` 主要服务于生命周期恢复链路；但同文件中的 `resolveBoundSeatSymbol` 又被：

- `src/app/startup/runtimeValidation.ts:17`

直接复用。

#### 问题

这说明 recovery 文件里已经长出了更中性的 seat helper，导致非 recovery 链路反向依赖 recovery 目录。这不是单纯命名不理想，而是比较明确的目录边界泄漏。

#### 建议

- `prepareSeatsForRuntime` 继续保留在 recovery / lifecycle 恢复链
- `resolveBoundSeatSymbol` 抽到更中性的 seat helper 位置

### 3.3 `src/utils/utils.ts` 已形成 catch-all 文件

> 状态：已修复（2026-05-21 复核确认）。当前依据：`src/utils/utils.ts` 已删除，原 helper 已按 owner / 最近共同父级分别迁回 `src/utils/seat/`、`src/main/monitorQuoteEventRuntime/`、`src/main/seatRuntimeCleanupDispatcher/`、`src/services/accountDisplay/` 与 `src/utils/runtime/`。

#### 现状

- 文件：`src/utils/utils.ts:1`
- 体量：约 185 行

它同时承载：

- monitor context runtime snapshot 解析：`src/utils/utils.ts:61`
- set 比较：`src/utils/utils.ts:104`
- queue clear 汇总：`src/utils/utils.ts:125`
- env boolean 解析：`src/utils/utils.ts:138`
- account channel 展示格式化：`src/utils/utils.ts:178`

消费面也横跨多个 owner：

- `src/app/context/createMonitorContexts.ts:19`
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:14`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:15`
- `src/services/accountDisplay/index.ts:9`
- `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts:9`

#### 问题

这是典型的 catch-all 文件。更准确地说，它的问题不是“`utils.ts` 中定义了类型”这类硬违规，而是多个作用域不同的 helper 被上浮到祖父级公共 util，违反了按最近共同父级组织工具函数的项目规则。

问题集中在这个文件本身，而不是整个 `src/utils` 目录都已经失真。

#### 建议

优先按职责拆分并改名，降低“杂项 helper 持续堆叠到同一文件”的趋势：

- monitor context snapshot 解析应靠近 monitor context / runtime snapshot owner
- queue clear 汇总应靠近 `seatRuntimeCleanupDispatcher`
- account channel / number 展示格式化应靠近展示端口或更明确的 display utils
- set 比较若仍需跨 runtime 复用，可放在更明确的集合工具位置

### 3.4 `src/types/queue.ts` 挂在全局层级偏高

> 状态：已修复（2026-05-21 复核确认）。当前依据：`src/types/queue.ts` 已删除，`QueueClearResult` 已收回 `src/main/seatRuntimeCleanupDispatcher/types.ts`，不再挂在全局 `src/types/` 层级。

#### 使用面

仅被以下两处引用：

- `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts:11`
- `src/utils/utils.ts:4`

#### 问题

当前只定义 `QueueClearResult`，本质上属于 `seatRuntimeCleanupDispatcher` 的私有返回协议，并未形成全局队列抽象。文件自身注释也已明确写明其使用范围仅在该 dispatcher 附近。

`src/utils/utils.ts` 对它的引用是 catch-all 外溢导致的次生引用，不能反向证明 `QueueClearResult` 应属于全局 `src/types`。

#### 建议

优先迁移到：

- `src/main/seatRuntimeCleanupDispatcher/types.ts`

---

## 4. 真实存在但更适合作为维护性/语义问题处理的项

以下条目有充分观察价值，但更适合进入渐进重构清单，而不是直接作为“明确架构错误”处理。

### 4.1 `src/services` 已成为混合语义目录

#### 现状

`src/services` 当前混合了四类不同模块：

1. 基础设施适配器
   - `src/services/quoteClient/index.ts:276`

2. 领域能力
   - `src/services/autoSymbolFinder/index.ts:218`
   - `src/services/autoSymbolManager/index.ts:47`
   - `src/services/indicators/`

3. 风险/运行时支撑
   - `src/services/liquidationCooldown/index.ts:28`

4. 展示层
   - `src/services/accountDisplay/index.ts:18`
   - `src/services/marketMonitor/index.ts:330`

#### 问题

这条更准确地说是“目录语义失焦”，而不是核心架构错误：`services` 目前同时承载 adapter、共享领域能力、展示渲染与风险支撑，导致“新模块该放哪里”越来越难一眼判断。

尤其明显的例子包括：

- `src/services/marketMonitor/index.ts:330` 实际是纯渲染器
- `src/services/accountDisplay/index.ts:18` 实际是日志展示模块
- `src/services/liquidationCooldown/utils.ts:13` 中的 `buildCooldownKey` 被 `core` 与 `main` 多处直接复用，说明它已经超出单纯“服务模块”的直觉语义

#### 建议

不建议一次性大搬迁，但建议分批纠偏：

- 先单独梳理展示/渲染相关模块与支撑类模块的命名和归位
- 再评估 `liquidationCooldown` 是否需要更中性的归属
- `quoteClient` 继续保留为清晰的适配器边界

### 4.2 `src/main` 的目录名已不完全贴合真实职责

#### 现状

`src/main` 已不再只是“主程序”或“主入口”的语义，而是承载了长期运行的 runtime / application orchestration 能力，典型模块包括：

- `src/main/businessEventProgram/`
- `src/main/monitorQuoteEventRuntime/`
- `src/main/tradingRiskEventRuntime/`
- `src/main/quoteSubscriptionRuntime/`
- `src/main/asyncProgram/`
- `src/main/lifecycle/`

#### 判断

这条成立，但更准确的说法是：`src/main` 的目录名已不足以表达其真实职责。它更像“事件程序 + runtime + lifecycle processor”的集合，而不是单纯入口层。

#### 建议

在后续命名收口时，可渐进评估更贴近真实语义的顶层目录，例如 `runtime/` 或 `application/`，但这属于语义优化项，而不是最高优先级边界问题。

### 4.3 `src/app` 与 `src/main` 有双编排倾向，但更准确是“顶层装配层 + 运行期编排层”

#### 现状

`src/app` 仍然是顶层 composition root，但同时持有大量运行期对象所有权与装配逻辑，例如：

- `src/app/runApp.ts:84`
- `src/app/runtime/createPostGateRuntime.ts:194`
- `src/app/context/createMonitorContexts.ts:82`
- `src/app/lifecycle/createLifecycleRuntime.ts`

而 `src/main` 负责承载被装配出来的 runtime program 与 lifecycle processor。

#### 判断

这条有事实基础，但“两个对等编排中心”说法偏强。更准确的是：`app` 负责顶层装配与启动排序，`main` 负责运行期程序实现，二者边界略显含混，但还不宜直接定性为结构性双主中心问题。

#### 建议

保留 `runApp` 作为 composition root，再逐步收缩 `createPostGateRuntime`、`createMonitorContexts` 等运行期装配职责的层级位置。

### 4.4 `src/types/services.ts` 已是高扇出共享契约汇聚点

- 文件：`src/types/services.ts:1`
- 体量：约 1019 行

该文件同时承载：

- `MarketDataClient`
- `Trader`
- `OrderRecorder`
- `RiskChecker`
- quote / candlestick 事件
- post-trade consistency 事件
- 各类跨层契约

#### 判断

问题不在于它当前已经错误，而在于它已经成为跨上下文共享契约汇聚点，后续每次扩展都容易继续向这一个文件堆叠。

#### 建议

不建议立刻重构，但应作为后续渐进拆分对象，至少可按上下文拆为：

- `types/marketData.ts`
- `types/trader.ts`
- `types/order.ts`
- `types/risk.ts`
- `types/runtimeEvents.ts`

### 4.5 `src/constants/index.ts` 已是高扇出共享常量汇聚点

- 文件：`src/constants/index.ts:1`
- 体量：约 431 行

当前混合了：

- runtime
- trading
- api
- logging
- lifecycle
- verification
- order
- display

#### 判断

问题不在于当前常量组织已经错误，而在于该文件已明显承担跨上下文共享常量总线的角色，未来会继续扩大扇出面。

#### 建议

后续按 bounded context 渐进拆分，而不是继续向 `index.ts` 堆叠：

- `constants/trading.ts`
- `constants/api.ts`
- `constants/logging.ts`
- `constants/signal.ts`

### 4.6 `src/utils` 存在局部语义上浮，但问题集中在部分模块

重点不是所有工具目录都有问题，而是部分模块已经带有较强的业务/运行时语义，例如：

- `src/utils/positionCache/`
- `src/utils/refreshGate/`
- `src/utils/runtime/index.ts:37`
- `src/utils/quoteRetry/`

#### 判断

这条应理解为“局部上浮”，而不是“整个 `src/utils` 已经全面总线化”。真正最突出的症状仍是 `src/utils/utils.ts` 这个 catch-all 文件。

#### 建议

优先从局部收口入手，而不是先整体重组 `src/utils` 顶层目录。

### 4.7 多个 runtime 中存在可提炼的相似调度骨架

#### 重复点 A：retain / wakeup bookkeeping

以下两个模块存在明显相似性：

- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`

两边都实现了近似同构的：

- retained symbols 集合管理
- retry 标记
- retain/release bookkeeping
- set equality 去重
- WAIT → wakeup → retry timer 流程

#### 重复点 B：single-flight + latest-only collapse 调度模板

以下模块都存在高度相似的调度骨架：

- `src/main/businessEventProgram/index.ts:53`
- `src/main/monitorDisplayRuntime/index.ts`
- `src/main/tradingQuoteDisplayRuntime/index.ts`
- `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`

#### 判断

这里更像刻意复用同一调度手法，而不是已经构成坏味道。只有当重复开始形成真实维护负担时，才值得提炼极小的共享 helper。

#### 建议

只考虑提炼**极小的共享 helper**，不要把多个 runtime 合并成大抽象。保留各 runtime 自己的业务门禁、路由与副作用边界。

### 4.8 `marketMonitor` 与 display runtime 存在命名域重叠

- `src/services/marketMonitor/index.ts:330`
- `src/main/monitorDisplayRuntime/index.ts`
- `src/main/tradingQuoteDisplayRuntime/index.ts`

#### 判断

`marketMonitor` 已明确是纯渲染器，而两个 display runtime 是调度 runtime。这里不是职责重复，更像命名域容易误导维护者。

#### 建议

在后续命名整理时，将其收口到更明确的 display / renderer 命名域。

---

## 5. 暂不建议作为结构问题处理的项

### 5.1 `src/core/utils.ts` 当前证据不足，不建议作为问题展开

`src/core/utils.ts` 当前体量较小，职责也未显示出足以支撑强批评的混杂程度。不应把它与 `src/utils/utils.ts` 的 catch-all 问题并列处理。

### 5.2 `ACTION_DESCRIPTIONS` 与 `SIGNAL_ACTION_DESCRIPTIONS` 的并存不能单独构成命名边界问题

两者 keyspace 接近，但一个偏简描述、一个偏执行链路描述；仅凭这两个常量并存，不足以推出 `src/constants/index.ts` 的命名边界已经出错。

### 5.3 `src/utils/trading/tradeLogPath.ts` 目前更像共享链路 helper，而不是高置信下沉项

它当前只被：

- `src/app/runtime/createPostGateRuntime.ts:45`
- `src/services/liquidationCooldown/tradeLogHydrator.ts:12`

使用，但这刚好对应同一 trade log 文件的生产者与消费者。现阶段将其保留为共享 util 并不牵强。

### 5.4 `src/services/marketMonitor/priceDisplayInfo.ts` 不宜直接列为高置信下沉项

它虽然只被 `src/app/runtime/createPostGateRuntime.ts:40` 与 `src/app/runtime/createPostGateRuntime.ts:421` 装配使用，但自身职责就是为 quote 显示链路聚合附加信息，继续留在 `marketMonitor` 同域并不构成当前问题。

### 5.5 `src/services/accountDisplay/index.ts` 更像展示端口，而不是当前需要优先迁移的模块

它本质上确实是账户/持仓日志展示端口，但已经通过依赖注入被：

- `src/app/runApp.ts:15`
- `src/main/lifecycle/rebuildTradingDayState.ts:288`

共同复用。把它保留为显示 service 目前仍说得通，最多算中等置信的后续归位建议。

---

## 6. 看似可动但建议保持现状的点

### 6.1 `autoSymbolFinder/policyResolver.ts` 不建议下沉

虽然 `src/services/autoSymbolFinder/policyResolver.ts` 的直接调用面不多，但它同时服务：

- 自动换标链路
- 启动恢复寻标链路

因此它承载的是跨链路阈值不变量，继续保留在共享层是合理的。

### 6.2 `positionCache` 不建议因为“单创建点”而下沉

`positionCache` 的创建点虽集中，但它承担的是共享运行态缓存职责，不应误判为 app 私有实现。

### 6.3 `quoteClient` 应继续保留为适配器边界

`src/services/quoteClient/index.ts:276` 对接外部 Longbridge QuoteContext，适配器语义清晰，属于 `services/` 中最不需要动的模块之一。

---

## 7. 建议的最小重构顺序

如果后续要推进结构优化，建议按照以下顺序实施，以获得最高收益并控制风险。

### 第一批：先处理明确边界/组织问题

1. 抽走 `resolveBoundSeatSymbol`
   - 从 `src/main/recovery/seatPreparation.ts` 分离到更中性的 seat helper 位置

2. 就地拆分局部高收益杂项点
   - 拆分 `src/utils/utils.ts`
   - 下沉 `src/types/queue.ts`

3. 收口 `orderRecorder` 正式边界
   - 收紧 `trader`、`app/runtime`、snapshot 加载链路对内部 helper 的直接访问
   - 保持必要依赖显式注入，不把封装做成隐式创建外部依赖

### 第二批：收口语义最混杂的目录与所有权边界

4. 梳理 `services` 中展示/渲染模块与支撑模块的命名和归位
5. 收紧 `app` 顶层装配层与 `main` 运行期编排层之间的归属边界
6. 在确认命名方向后，渐进评估 `src/main` 向 `runtime/application` 语义层的重组

### 第三批：处理共享总线与工程化重复

7. 渐进拆分 `src/types/services.ts`
8. 渐进拆分 `src/constants/index.ts`
9. 仅在重复已形成维护负担时，提炼极小的 runtime 调度 helper

---

## 8. 最终判断

本次 `src/` 生产代码审查的最终判断如下：

1. **核心业务层没有失序**，`core` 仍然是稳定层
2. **最值得优先修复的是少量明确的边界/组织问题**，尤其是 recovery helper 外溢、`src/utils/utils.ts` catch-all、`src/types/queue.ts` 上浮
3. **大量外围问题更适合定义为目录语义债或维护性问题**，而不是直接定性为架构错误
4. **`orderRecorder` 边界未完全收口真实存在**，但更准确是边界封装与维护性问题，不是硬 TypeScript 规范违规
5. **当前最优策略不是推倒重来，而是分批收口**

如果进一步压缩为一句话：

> 当前项目的问题不是“核心架构错误”，而是“外围层在连续重构后逐渐混合，其中少数位置已经出现明确边界/组织问题，其余更多是目录语义、共享总线与运行期装配归属逐步变宽带来的维护性压力”。

因此，后续重构应优先围绕以下四个目标展开：

1. 抽掉跨层泄漏的通用 helper
2. 拆掉 `src/utils/utils.ts` 与 `src/types/queue.ts` 这类明确组织问题
3. 封住订单链路的正式边界，但保持依赖显式注入
4. 将 `services`、`main/app`、共享类型/常量总线等命名与所有权漂移问题纳入渐进式重构，而不是一次性大搬迁
