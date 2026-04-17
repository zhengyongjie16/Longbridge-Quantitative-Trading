# 2026-04-14 Ink 事件驱动最短路径重构方案

> 状态：draft  
> 目标：在保持 `bun` 作为唯一运行时、使用 `Ink` 构建只读实时 TUI、保留本地文件日志的前提下，删除围绕终端字符串输出与多层中间投影建立的展示架构，改为“业务处理完成后直接更新 UI 展示态”的最短路径架构。

## 1. 最终结论

本次重构的唯一主路径是：

```text
原始事件到达
-> 对应业务链路完成计算与状态推进
-> 产出稳定业务结果
-> 直接 setState 写入 UI 展示态
-> Ink 根据状态订阅完成更新
```

这里的 `setState` 指更新 UI 专属展示态，不是回写业务 owner，也不是让 UI 参与交易判断。

这条路径必须满足四个前提：

1. UI state 只是展示态，不回写业务语义。
2. 更新发生在业务结果稳定之后。
3. Ink 组件只展示，不自己推导业务口径。
4. 不使用每秒全量轮询作为运行态主刷新机制。

因此，本方案不再引入大量中间模块来模拟“读取、投影、再渲染”的链路。业务链路已经完成计算时，应直接把最终展示所需结果写入 UI state。

## 2. 第一性原理

当前系统的业务变化来源已经是事件驱动的：行情推送、K 线推送、订单状态推送、成交后刷新、门禁变化、生命周期迁移、自动寻标和换标状态推进，都会在业务链路中产生确定结果。

UI 的职责不是重新读取并解释这些业务状态，而是在业务结果稳定后立即展示这些结果。

因此，正确目标不是建立新的中间状态体系，而是把“业务完成点”接到 UI 展示态更新：

```text
业务 owner 负责交易事实
业务链路负责计算最终结果
UI state 保存只读展示结果
Ink 组件只负责渲染
```

本方案明确删除以下旧方向：

- 旧 console 文本作为实时 UI 数据源。
- `logger` 文本解析成 UI 状态。
- 每秒或固定间隔全量扫描 runtime 后重建整屏。
- 为了 UI 引入大量 read port / read model / projection runtime / event bus / selector 中间层。
- 为兼容旧展示接口而保留双主路径。

## 3. 目标架构

### 3.1 分层只保留必要边界

本方案只保留三类必要边界。

#### 1) 业务运行态

业务运行态继续由现有 owner 与处理器负责：

- `lastState`
- `monitorContexts`
- `quoteClient`
- `trader`
- `postTradeConsistencyRuntime`
- `tradingGateEventRuntime`
- lifecycle runtime
- 自动寻标、换标、风控、订单、信号等现有业务处理器

这些对象继续拥有业务状态、业务时序与副作用能力。

#### 2) UI 展示态

UI 展示态是 Ink 唯一消费的数据源，只保存已经稳定的展示结果。

UI 展示态不允许：

- 作为交易判断输入。
- 反向修改业务 owner。
- 保存需要后续业务链路继续解释的半成品。
- 依赖日志文本恢复业务语义。

#### 3) Ink 组件

Ink 组件只消费 UI 展示态并渲染。

组件不允许：

- 计算指标。
- 判断交易信号。
- 推导风控结论。
- 推导订单可卖集合。
- 推导 freshness 业务状态。
- 从日志、订单原始文本或旧 console 输出中回收状态。

### 3.2 最小目录结构

首版只允许建立最少必要模块，并明确分离 `src/screens` 与 `src/store`：

```text
src/
├── app/
│   └── runApp.ts                      # 装配业务事件完成点、store 更新并调用 screens 入口
├── screens/
│   ├── index.ts                       # 暴露创建和挂载 Ink 的唯一入口
│   ├── app.tsx                        # Ink 根组件
│   ├── startup.tsx                    # 启动与门禁前屏幕
│   ├── runtime.tsx                    # 运行态主屏
│   ├── components/                    # 纯展示组件
│   └── format/                        # 数字、时间、颜色、标签等纯展示格式化
└── store/
    ├── index.ts                       # 暴露 getState / setState / subscribe
    ├── state.ts                       # UI 展示态初始值与 store 实现
    ├── types.ts                       # UI 展示态类型定义
    └── clock.ts                       # 只负责时间类字段更新
```

目录边界必须满足：

- `src/screens` 只放 Ink 页面、纯展示组件与纯展示格式化。
- `src/store` 只放 UI 展示态、订阅更新能力与时间字段更新逻辑。
- 组件命名与模块命名优先使用中性词，例如 `app`、`startup`、`runtime`、`state`、`types`、`clock`、`components`、`format`。
- 不使用带强投影语义或中间层暗示的命名，例如 `projection`、`readModel`、`selector`、`eventBus`、`adapter`。

如果后续某个文件变大，再按实际职责拆分，但拆分后的命名仍应保持中性，并继续遵守“业务完成后直接写 store，再由 Ink 渲染”的单一路径。首版不预先创建以下模块体系：

- 通用 event bus。
- read ports 目录。
- read models 目录。
- projection runtime 目录。
- selectors 目录。
- 兼容旧展示接口的 adapter / wrapper。

如果某个展示字段必须跨多个业务 owner 汇总，也优先在对应业务完成点产出最终结果，再写入 UI state；不要为了未来可能复用而提前创建抽象层。

### 3.3 首版 Ink 布局设计

首版 UI 只做最小必要布局，不做视觉稿式复杂设计；重点是信息分区清晰、终端宽度自适应、业务结果稳定后立即可见。

运行态主屏按从上到下分为四个区块：

#### 1) 顶部状态摘要区

显示三行摘要信息：

- `时间 | 运行时长 | 账户类型 | 交易时段状态`
- `账户总资产 | 当日盈亏`
- `持仓总市值 | 持仓总盈亏`

设计要求：

- 使用 Ink `Box` 横向排布，并允许自动换行。
- 宽度足够时同排展示，宽度不足时自动折行。
- 不允许为对齐效果写死宽度或高度。
- 当日盈亏、持仓总盈亏、交易时段状态允许用颜色强化。

#### 2) 持仓分布区

标题为 `持仓分布`，下方展示持仓列表。

字段顺序固定为：

- `标的名（代码.HK）`
- `当前价/成本价格`
- `数量`
- `持有订单数`
- `持仓盈亏`

布局要求：

- 终端宽度足够时，每个持仓占一行，保持稳定列顺序。
- 终端宽度不足时，每个持仓自动折成两到三行，但字段语义和顺序不变。
- 不强求字符宽度完全对齐，优先保证信息完整可读。

#### 3) 监控标的区

每个 monitor 独立为一张纵向卡片，按列表顺序从上到下排列，不做多列瀑布式布局。

每张卡片必须包含：

- 标题行：`监控标的 X：标的名（代码.HK）`
- 行情摘要行：`最新推送时间 | 实时行情价格 | 涨跌幅`
- 指标行：`K线时间 | RSI6 | KDJ | MACD ...`
- 信号行：`最新信号状态：...`

布局要求：

- 指标区允许自动换行，不为单行展示强行压缩内容。
- 信号状态单独成行，避免与指标、行情混排。
- monitor 卡片之间使用简单分隔线或边框区分，不做复杂装饰。

#### 4) 席位区

每个 monitor 卡片内部包含 `做多席位` 与 `做空席位` 两个区块。

每个席位区块必须包含：

- 席位摘要行：`席位方向 | 席位状态 | 周期换标时间 | 距下次周期换标时间 | 回收价阈值`
- 标的行：`牛/熊证名称`
- 行情行：`最新推送时间 | 当前价 | 涨跌幅 | 距回收价百分比`

布局要求：

- 宽终端下，做多席位与做空席位可左右并排。
- 窄终端下，做多席位与做空席位必须自动改为上下堆叠。
- 席位内部字段也必须允许自动折行，不允许固定宽高。

### 3.4 自适应与视觉约束

首版 Ink 布局必须遵守以下约束：

- 布局只能依赖终端当前可用宽度做自适应，不使用固定宽度和固定高度。
- 不使用绝对定位、手工计算整屏字符坐标或依赖固定终端尺寸的排版方式。
- 顶部摘要区允许换行。
- 持仓区在窄终端下自动从“单行记录”退化为“多行卡片”。
- monitor 主卡片始终纵向排列，避免在窄终端出现横向拥挤。
- 分隔线长度跟随当前可用宽度，或直接改用 `Box` 边框。

颜色与视觉只保留最小语义强化：

- 涨为红，跌为绿。
- 阻塞、失败、风险、stale 使用黄或红。
- 普通标签、时间、说明性文本使用中性色。
- 不引入与业务无关的装饰性配色或复杂边框体系。

### 3.5 首版展示组件建议

首版只建议拆出最少必要的纯展示组件：

- `SummaryBar`
- `PositionList`
- `MonitorCard`
- `SeatCard`
- `LabelValue`
- `Divider`

这些组件只负责排版和展示，不承担业务计算，也不新增展示中间层。

## 4. UI 更新规则

### 4.1 业务完成后直接 setState

每条业务链路在结果稳定后，由 `app/runApp.ts` 装配层注册的轻量 UI 更新回调直接写入对应展示态：

```text
业务处理完成
-> app 装配层回调 updateXxxUiState(result)
-> store.setState(partialState)
-> Ink 更新
```

这里的 `updateXxxUiState(...)` 只是业务完成点附近的轻量写入函数，不允许演化为新的 projection runtime、event bus、adapter、selector 或二次聚合中间层。业务核心模块不得直接 import `src/screens` 或 `src/store` 的实现细节，也不得反向依赖 UI 实现。

示例：

```text
quote push
-> quoteClient 更新实时行情缓存
-> 相关监控行需要展示的新行情结果已确定
-> updateQuoteUiState(...)
-> setState 更新 quote / monitor 行
```

```text
candlestick push
-> business event program 完成指标、信号、席位校验等处理
-> 最新 monitor 展示结果已确定
-> updateMonitorUiState(...)
-> setState 更新对应 monitor 行与 signal 区
```

```text
order state changed
-> trader 完成订单状态推进
-> 订单记录、待成交占用、成交处理与必要刷新状态已稳定
-> updateOrderUiState(...)
-> setState 更新订单区、持仓摘要、freshness 或 recent event
```

### 4.2 setState 的输入必须是稳定结果

禁止在以下时机更新 UI 展示态：

- K 线事件刚到达但指标、信号、席位校验尚未完成。
- 订单状态刚推送但成交结算、待成交占用、订单记录更新尚未完成。
- 成交后刷新尚未确认 fresh，却提前显示为 fresh。
- 生命周期迁移中间阶段尚未完成，却提前显示可交易。
- 换标过程中席位版本、标的绑定、订单隔离、换标后刷新尚未稳定。

允许在以下时机更新 UI 展示态：

- 行情缓存已经更新，相关 symbol 的最新展示价格已确定。
- 指标与信号处理完成，最新 signal 状态已确定。
- 订单处理器完成当前订单状态推进，展示摘要已确定。
- 成交后刷新完成或 freshness 状态明确变化。
- gate 状态完成迁移。
- lifecycle 阶段完成迁移。
- 自动寻标或换标状态完成一次确定推进。

### 4.3 按业务结果增量更新

UI 不做整屏定时重建。

每个业务完成点只更新受影响的 UI slice：

- quote 结果只更新相关 symbol / monitor / seat 展示。
- K 线与指标结果只更新相关 monitor 与 signal 展示。
- 订单结果只更新订单、持仓摘要、freshness、recent event 等受影响区块。
- gate 结果只更新门禁、状态条与可交易提示。
- lifecycle 结果只更新启动、重建、交易日阶段与门禁提示。
- 自动寻标 / 换标结果只更新对应 seat、symbol、风险距离与切换状态。

### 4.4 高频事件只允许合并 UI 渲染，不允许合并业务语义

行情等高频事件可以做 UI 层渲染合并，例如同一 symbol 的多次 quote 更新只保留最新展示结果。

合并规则只影响 UI 渲染次数，不影响业务处理：

- 业务事件必须照常处理。
- 业务 owner 必须照常更新。
- UI 最终显示必须是最新稳定结果。
- 订单、freshness、lifecycle、gate 等语义状态迁移不得被合并吞掉。

### 4.5 clock 只更新时间字段

允许 clock tick 更新：

- 当前时间。
- 程序运行时长。
- 倒计时文本。
- 周期换标剩余时间展示。

clock tick 禁止触发：

- account 区全量重算。
- position 区全量重算。
- monitor 区全量重算。
- order 区全量扫描。
- freshness 区全量扫描。
- lifecycle / gate 状态猜测。

## 5. 各业务事件的 UI 更新点

### 5.1 启动与门禁前阶段

启动流程中的每个稳定阶段直接写入 startup UI state：

```text
startup phase changed
-> setState({ startup: nextStartupState })
```

必须展示：

- 当前 startup phase。
- OAuth 状态。
- gate 检查结果。
- 阻塞原因。
- fatal startup error。
- lifecycle readiness。

启动屏不等待 post-gate 后才挂载。启动过程中只展示已经确定的启动状态，不从日志文本解析进度。

### 5.2 行情事件

`quoteClient` 完成实时行情缓存更新后，直接更新相关展示态：

- 最新价。
- 涨跌幅。
- 买卖盘摘要。
- seat 当前报价。
- monitor 行 quote 区块。

行情展示不等待主循环下一次执行。

### 5.3 K 线、指标与信号事件

K 线推送到达后，必须先完成业务链路：

```text
CandlestickUpdatedEvent
-> business event program
-> indicator pipeline
-> signal pipeline
-> seat / gate / consistency validation
-> 最新 monitor 结果稳定
-> setState 更新 monitor / signal 展示
```

UI 不展示指标计算过程中的半成品。

### 5.4 账户与持仓事件

账户和持仓只在业务刷新结果稳定后更新 UI：

- 启动快照加载完成。
- 成交后刷新完成。
- 持仓缓存明确变化。
- 账户缓存明确变化。

UI state 可以保存：

- 账户摘要。
- 现金与购买力。
- 持仓行。
- 持仓市值。
- 已按业务口径计算完成的盈亏字段。
- freshness 状态。

UI 组件不得自行计算当日盈亏、行级盈亏、持仓总盈亏或 freshness。

### 5.5 订单事件

订单事件必须在订单处理链路完成当前状态推进后更新 UI：

- 订单状态摘要。
- 在途订单。
- 买卖方向。
- 成交状态。
- 待成交卖出占用摘要。
- 保护性清仓进度。
- 成交后刷新状态。

如果订单成交会触发账户、持仓、风控或 freshness 变化，则只能在对应业务结果各自稳定后写入相应 UI slice；所谓分阶段，也必须保证每一次写入对应的业务语义已经稳定，禁止把中间过程当作最终展示结果写入 UI。

禁止 UI 组件从原始订单列表自行推导智能平仓、可卖订单、待成交占用或保护性清仓完成状态。

### 5.6 freshness、queue、gate、lifecycle

这些状态都是业务运行态，不是展示猜测。

当状态完成迁移后直接 setState：

- `postTradeConsistencyRuntime` fresh/stale 变化。
- queue 长度、队首、积压摘要变化。
- gate 开关变化。
- lifecycle 阶段变化。
- open rebuild 开始、成功、失败、重试时间变化。

UI 不通过定时扫描猜测这些状态。

### 5.7 自动寻标与换标

自动寻标与换标必须在状态机完成一次确定推进后更新 UI：

- seat 状态。
- seat version。
- 当前交易标的。
- 回收价。
- 距回收价百分比。
- 寻标 / 换标阶段。
- 换标失败原因。
- 当日冻结状态。

UI 不自行判断候选筛选、风险距离边界、席位归属或换标完成条件。

## 6. UI state 字段边界

### 6.1 可以直接进入 UI state 的字段

以下字段可以由业务链路完成后直接写入 UI state：

- 启动阶段、阻塞原因、fatal error。
- 交易门禁状态。
- lifecycle 阶段。
- 行情价格、涨跌幅、买卖盘摘要。
- K 线更新时间。
- 指标快照。
- 最新 signal 状态。
- 账户摘要。
- 持仓行与持仓摘要。
- 订单摘要和在途订单状态。
- freshness 状态。
- queue 摘要。
- seat 状态、版本、symbol、回收价、距回收价结果。
- 自动寻标 / 换标状态。
- 风控拒绝原因与保护性清仓状态。
- recent UI events。

### 6.2 只允许 UI 层派生的字段

UI 层可以基于已稳定的 UI state 做纯展示派生：

- 排序。
- 分组。
- 标签文本。
- 颜色。
- 数字格式化。
- 时间格式化。
- 当前时间与运行时长。
- 倒计时显示。

这些派生不得改变业务语义。

### 6.3 禁止 UI 组件推导的字段

以下字段必须由业务链路产出后写入 UI state，组件不得自行推导：

- 当日盈亏。
- 持仓总盈亏。
- 行级持仓盈亏。
- 成本均价与浮亏口径。
- 最新 signal 业务语义。
- 买入风控拒绝原因。
- 保护性清仓完成状态。
- 买入冷却状态。
- 智能平仓可卖订单集合。
- 待成交卖出占用。
- freshness 判定。
- 距回收价风险口径。
- 自动寻标候选筛选结果。
- 换标完成条件。
- lifecycle 是否可交易。

## 7. 日志边界

文件日志继续保留，但日志不参与 UI 状态生产。

允许：

- 业务链路继续写审计日志。
- fatal 错误保留最小 console 输出。
- UI 内部错误写入日志。

禁止：

- `logger.info(...) -> Ink panel`。
- file log 反推当前 screen state。
- 从 console 文本解析 account / position / monitor / order / freshness 状态。
- 用日志格式反向决定 UI state 类型。

## 8. 删除旧展示路径

本次重构不做兼容旧架构的过渡主路径。

必须删除或停止作为主路径使用：

- `accountDisplay` 的实时 console 展示职责。
- `marketMonitor` 中的终端文本组装职责。
- logger console sink 的实时主展示职责。
- 旧展示字符串中间对象。
- 任何把旧 console 文本接到 Ink 的 adapter。
- 任何为了兼容旧展示接口而保留的 wrapper。

如果某个旧模块同时包含业务状态更新与文本输出，必须保留业务状态更新，删除文本输出职责。

## 9. 实施顺序

### 阶段 A：建立最小 UI state 与 Ink 壳

目标：先让 UI 有稳定展示态和订阅更新能力。

任务：

1. 新建 `src/store/state.ts`、`src/store/types.ts` 与 `src/store/index.ts`。
2. 定义 startup 与 runtime 两类 UI state。
3. 提供 `getState`、`setState`、`subscribe`。
4. 新建 `src/screens/app.tsx`、`src/screens/startup.tsx`、`src/screens/runtime.tsx` 与 `src/screens/index.ts`。
5. 新建 `src/store/clock.ts`，且 clock 只更新当前时间和运行时长。

完成标准：

- Ink 可以渲染初始状态。
- UI state 与业务 owner 分离。
- 没有全量轮询 runtime。

### 阶段 B：接入启动、gate、lifecycle 完成点

目标：先覆盖 pre-gate 与生命周期可见性。

任务：

1. 在启动流程稳定阶段直接更新 startup UI state。
2. 在 gate 状态完成迁移后更新 gate UI state。
3. 在 lifecycle 状态完成迁移后更新 lifecycle UI state。
4. 同步删除对应 console 实时展示路径，禁止该 slice 出现新旧双主路径。

完成标准：

- 启动阶段无需依赖 console 输出。
- gate/lifecycle 不靠定时扫描刷新。

### 阶段 C：接入 account、position、freshness、queue 完成点

目标：账户、持仓、一致性与队列状态由业务结果直接驱动 UI。

任务：

1. 账户快照加载或刷新完成后 setState。
2. 持仓快照加载或刷新完成后 setState。
3. freshness 状态变化后 setState。
4. queue 摘要变化后 setState。
5. 同步删除旧账户持仓 console 展示主路径，禁止该 slice 新旧并行。

完成标准：

- UI 展示的是业务已计算完成的账户、持仓、freshness 结果。
- 组件不自行计算盈亏或 freshness。

### 阶段 D：接入 quote、monitor、signal、seat 完成点

目标：运行态主监控区由业务事件完成点直接驱动。

任务：

1. quote 缓存更新完成后更新相关 UI 行。
2. K 线业务链路完成后更新 monitor、indicator、signal 展示。
3. seat 状态变化后更新 seat 展示。
4. 自动寻标与换标状态推进后更新 UI。
5. 同步删除 `marketMonitor` 的文本展示职责，禁止监控区新旧展示并行。

完成标准：

- 行情与监控区不等待主循环刷新。
- UI 不计算指标、信号或候选筛选。

### 阶段 E：接入 order、trade、risk、recent events 完成点

目标：订单、成交、风控和最近事件都由业务结果直接写入 UI。

任务：

1. 订单状态推进完成后更新 order UI state。
2. 成交处理完成后更新 recent event。
3. 风控拒绝或保护性清仓状态稳定后更新 risk UI state。
4. 成交后刷新状态变化后更新 freshness UI state。

完成标准：

- UI 不从原始订单列表推导智能平仓、待成交占用或保护性清仓状态。
- recent events 不由日志文本生成。

### 阶段 F：删除旧展示与过度中间层

目标：只保留最新最短路径。

任务：

1. 删除旧 console 实时主展示调用。
2. 删除旧展示字符串对象。
3. 删除旧展示 adapter / wrapper。
4. 不新增通用 event bus / read model / projection runtime / selector 体系。
5. 确认所有运行态 UI 数据都来自业务完成后的直接 setState。

完成标准：

- 不存在新老展示双主路径。
- 不存在 logger 文本到 UI 的链路。
- 不存在每秒全量扫描 runtime 的主刷新逻辑。

## 10. 验证策略

### 10.1 架构验证

必须验证：

- `src/screens` 不被业务核心模块反向依赖。
- `src/store` 不被业务核心模块当作交易判断输入。
- UI state 不作为交易判断输入。
- Ink 组件不 import 交易 owner。
- 没有 logger 文本进入 UI state。
- 没有旧 console 展示路径继续作为主路径运行。
- 布局不依赖固定宽度、固定高度或固定终端尺寸。

### 10.2 更新语义验证

必须验证：

- quote 更新后 UI 立即显示最新稳定价格。
- K 线业务链路完成后 UI 显示最新指标和 signal。
- order 状态推进完成后 UI 显示最新订单摘要。
- freshness 状态变化后 UI 立即显示 fresh/stale。
- gate/lifecycle 状态迁移后 UI 立即更新。
- clock tick 只更新时间字段。
- 终端宽度变化后，顶部摘要区、持仓区、席位区都能自动折行或堆叠，不出现依赖固定宽高的布局失效。

### 10.3 业务语义验证

必须覆盖：

- 启动与 gate 阻塞场景。
- 开盘保护状态。
- 成交后刷新完成与未完成状态。
- 订单完全成交、部分成交、撤单、改单。
- 待成交卖出占用。
- 保护性清仓完成确认。
- 买入冷却。
- 自动寻标成功、失败、冻结。
- 距离换标与周期换标。
- lifecycle 午夜清理与开盘重建失败重试。

### 10.4 禁止项验证

以下情况一旦出现，视为重构失败：

- 为展示方便每秒重读所有 runtime 状态。
- Ink 组件自行计算业务指标、信号、风控或订单可卖集合。
- UI 从 logger 或 console 文本恢复状态。
- 业务 owner 依赖 UI state 做交易判断。
- 保留旧 console 展示与 Ink 展示双主路径。
- 为首版实现新增大量 read port / read model / projection runtime / event bus / selector 中间模块。
- 通过写死终端宽度、高度或字符坐标来实现布局。

## 11. 最终通过条件

本重构完成时必须满足：

1. 运行态 UI 主刷新链路为：业务完成后直接 setState。
2. UI state 是只读展示态，不参与业务决策。
3. 组件只展示，不推导业务口径。
4. quote、monitor、order、freshness、gate、lifecycle 都由业务完成点驱动更新。
5. clock tick 只影响纯时间字段。
6. 旧 console 实时展示主路径已删除。
7. 日志与 UI 状态生产彻底分离。
8. 没有为首版引入无实际必要的中间模块体系。
9. 运行态主屏布局可随终端宽度自适应，且不依赖固定宽高。

## 12. 最终结论

本方案的核心不是增加架构层，而是减少不必要的展示中间层。

最终系统应形成以下直接链路：

```text
业务事件
-> 业务处理完成
-> 稳定业务结果
-> UI state setState
-> Ink render
```

这条链路同时满足：

- 事件驱动。
- 最短路径。
- 业务语义先稳定。
- UI 只读展示。
- 无旧展示兼容层。
- 无过度中间模块。
