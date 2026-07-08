# 趋势验证与多档订单簿验证模块拆分重构方案

日期：2026-06-17

最终复核修订日期：2026-06-20

API / SDK 核验日期：2026-06-19

锁定 SDK：`longbridge@4.2.1`

## 1. 结论

本次重构将现有单一“延迟趋势验证”拆成两种互斥验证语义：

```text
trend：
确认技术指标在信号产生后继续沿既定方向推进。

orderBook：
确认极值回归买入信号产生后，
十档显示订单簿、最优档报价位置和价格路径出现反转与恢复。
```

最终设计必须满足：

1. Strategy 只生成未分类候选信号，不决定验证模式。
2. Signal Pipeline 是 `none / trend / orderBook` 的唯一分流 owner。
3. `orderBook` 只允许用于 `BUYCALL / BUYPUT`。
4. 保护性清仓、末日清仓、智能平仓和普通卖出不等待订单簿验证。
5. 行情订阅由一个 requirement-aware owner 串行维护，不创建两套并发操作同一 `QuoteContext` 的订阅状态机。
6. Depth 与 Broker Queue 是两条独立数据流，不做伪事件级配对。
7. 权限、订阅事实、合法稀疏市场状态和非法 payload 必须严格区分。
8. 不使用 L1、五档、成交涨跌方向或其他残缺数据替代缺失的完整指标。
9. 可完整构造的指标与数据全部保留；没有独立信息增量证据的指标不默认成为首版核心硬门禁。
10. 配置错误和内部不变量错误 fail-fast；单次信号数据不足只拒绝该信号，不得误报为全局权限故障。
11. `orderBook`验证的事实对象固定为`monitorSymbol`的订单簿，不读取牛熊证等`tradingSymbol`的订单簿。
12. `orderBook`只适用于静态信息明确为`SecurityBoard.HKEquity`的 monitor；指数 monitor 仍可使用`none / trend`，配置`orderBook`时直接失败。
13. Quote、Candlestick、Depth 与 Brokers 的订阅、服务端事实确认、seed、reset 和 shutdown 由同一个串行 owner 管理。
14. 首版不引入未经实证的档位权重；十档指标使用公开十档的等权聚合，后续只有在 replay 和样本外验证证明稳定收益后才能另立权重方案。

本方案不声明订单簿指标已经具有稳定 alpha。指标的预测能力和阈值只能由事件录制、确定性回放、消融和 walk-forward 验证。

### 1.1 业务适用范围

当前系统允许股票或指数作为`monitorSymbol`，但 Longbridge 公开十档 Depth / Broker Queue 能力不能由“港股后缀”推导，也不能假设指数 monitor 具备与港股股票相同的订单簿能力。

因此首版明确采用以下业务边界：

```text
股票 monitor + orderBook
-> 使用该股票 monitor 的十档 Depth / 可选 Broker Queue 验证信号
-> 验证通过后仍交易当前席位绑定的 tradingSymbol

指数 monitor
-> 只允许 none / trend
-> 不改用 tradingSymbol 盘口代替指数事实
-> 不使用成分股、ETF 或其他代理盘口
```

这是能力边界，不是运行时 fallback。若未来需要指数策略的微观结构验证，必须基于独立且可证明的事实源重新立项，不能复用本方案时临时切换到交易标的盘口。

## 2. 当前程序问题

当前链路为：

```text
1 分钟 K 线事件
-> businessEventProgram 推进指标
-> strategy.generateSignals 内部决定 immediate / delayed
-> runSignalPipeline 再处理 immediate / delayed
-> delayedSignalVerifier 读取技术指标样本
-> registerDelayedSignalHandlers 回流买卖任务队列
```

该结构存在两个所有权问题：

1. Strategy 已经根据验证配置决定立即或延迟。
2. 新方案又要求 Pipeline 决定 `none / trend / orderBook`。

重构后必须删除 Strategy 内部的验证分类：

```text
SignalTypeCategory
SignalWithCategory
needsDelayedVerification
calculateVerificationTime
immediateSignals
delayedSignals
pushSignalToCorrectArray 的 delayed 分支
```

Strategy 的唯一职责是根据策略条件输出候选信号及其原始信号时间。

## 3. Longbridge API / SDK 确定边界

### 3.1 权限前提

账户拥有港股完整行情权限。该事实允许调用港股十档 Depth 和 Broker Queue，但不改变以下市场事实：

- 任意时点不保证买卖两侧都有十个非空价格层。
- Broker Queue 返回 top-40 范围内当前公开的队列记录，不保证连续出现 `1..40`。
- Broker Queue position 不等于 Depth price level。
- 未变化的数据流可以不产生新的推送。

完整权限不能被解释为“任意快照必须完整填满所有位置”。

### 3.2 Trade

Node SDK 逐笔成交公开字段：

```text
price
volume
timestamp
tradeType
direction
tradeSession
```

`direction` 表示：

```text
Up
Down
Neutral
```

公开 API / SDK 不提供：

```text
aggressorSide
buyerInitiated
sellerInitiated
matchedAtBid
matchedAtAsk
```

因此必须删除：

```text
activeBuyVolume
activeSellVolume
activeTotalVolume
dominanceRatio
CVD
TickCVD
upTickVolume / downTickVolume 订单流验证
真实主动买卖量
基于主动成交量的吸收指标
```

删除原因是完整构造条件不存在，不是账户权限不足。

Trade 推送不属于本次订单簿验证依赖。

### 3.3 Depth

API 协议提供：

```text
sequence
bid[]
ask[]
```

每个价格层提供：

```text
position
price
volume
order_num
```

Node SDK 4.2.1 公共类型提供：

```text
PushDepthEvent.symbol
PushDepthEvent.data
PushDepth.bids
PushDepth.asks
Depth.position
Depth.price
Depth.volume
Depth.orderNum
```

其中`Depth.volume`和`Depth.orderNum`的 Node SDK 公共类型均为`number`。标准化层只接受有限、非负、安全整数；业务缓存继续使用`number`，不转换为`bigint`。价格由 SDK Decimal 转为有限正数后参与计算；任一派生结果必须保持有限，否则属于非法 payload。

Node SDK 公共对象未暴露：

```text
Depth sequence getter
Depth 交易所事件时间
```

因此可以构造：

- 每次公开快照的多档显示数量失衡。
- 每次公开快照的多档显示订单数失衡。
- Mid-price、quoted spread、L1 Microprice。
- 十档单侧显示数量和显示名义金额。
- 本进程观察窗口内的显示深度收缩与再扩张。

不得构造：

```text
严格 OFI
严格 MLOFI
Observed OFI
Observed Book Delta
依赖连续交易所事件的撤单/新增流量
交易所事件时间恢复速度
Trade 与 Depth 严格因果匹配
```

### 3.4 Broker Queue

SDK 提供：

```text
bidBrokers[]
askBrokers[]
position
brokerIds[]
```

Broker Queue 不提供：

```text
broker 级挂单量
broker 级成交量
broker 客户身份
broker 主动成交方向
broker 与十档 Depth 数量的映射
```

可完整构造：

- API 本次返回集合中指定 position 上限内的唯一 broker ID 数。
- 买卖两侧 Broker Queue 参与多样性。
- 恢复阶段参与多样性相对触发前基线的保留比例。

Broker breadth 的准确业务语义是：

> 当前公开 Broker Queue 中的唯一 broker ID 多样性。

不得描述为：

- 恢复数量由多个 broker 共同提供。
- 防止单一 broker 支撑全部显示深度。
- broker 的买卖意图或成交方向。

### 3.5 静态信息与订阅事实

SDK 提供：

```text
staticInfo
quoteLevel
quotePackageDetails
subscribe
unsubscribe
subscriptions
realtimeDepth
realtimeBrokers
setOnDepth
setOnBrokers
```

`quoteLevel()` 只返回字符串。

`QuotePackageDetail` 只公开：

```text
key
name
description
startAt
endAt
```

官方契约没有公开稳定的 package key 到“十档 Depth / Broker Queue capability”的结构化映射。

因此：

- `quoteLevel()` 和 `quotePackageDetails()`只用于诊断日志。
- 不允许通过名称、描述或猜测 package key 建立权限不变量。
- 权威订阅事实来自 `subscribe()`结果和 `subscriptions()`。
- `realtimeDepth()`与`realtimeBrokers()`用于读取 SDK 当前实时状态，不把返回内容是否稠密解释为权限结论。

## 4. 指标保留、用途和删除

### 4.1 核心硬门禁

首版 `orderBook` 的核心硬门禁固定为：

| 门禁                         | 数据来源                     | 作用                    |
| ---------------------------- | ---------------------------- | ----------------------- |
| Spread BPS                   | bid1 / ask1                  | 排除 quoted spread 异常 |
| 十档显示数量失衡反转         | 10-level volume              | 多档方向状态            |
| 单侧十档显示深度收缩与再扩张 | 10-level volume              | 时间路径确认            |
| Mid-price 极值与回收         | bid1 / ask1                  | 价格路径确认            |
| 最终参考价容忍度             | mid-price / signal reference | 防止恢复后价格偏离过大  |

核心硬门禁必须全部通过。

### 4.2 可选确认指标

以下指标完整保留，但不默认宣称具有独立信息增量：

| 指标                            | 数据来源            | 准确定位                      |
| ------------------------------- | ------------------- | ----------------------------- |
| Top-10 Order Count Imbalance    | 十档 orderNum       | 订单拆分结构确认              |
| Microprice Premium BPS          | L1 price + volume   | L1 显示数量派生的报价偏移确认 |
| Top-10 Displayed Depth Notional | 十档 price × volume | 流动性规模质量门禁            |
| Broker Breadth Retention        | Broker Queue        | 经纪队列参与多样性确认        |

配置通过 `confirmations`判别联合明确选择需要参与决策的确认指标。

规则：

1. 没有默认 confirmation 集合。
2. 被配置的 confirmation 必须通过。
3. 未配置的 Depth 派生指标可以作为审计观测计算，但不影响决策。
4. Broker breadth 未配置时不建立 Brokers 数据依赖，也不伪造审计值。
5. 不允许在运行时因数据缺失临时移除已配置 confirmation。
6. 已配置 confirmation 的数据不完整时，当前信号返回 `data-incomplete`。

该结构保留全部可行指标和原始数据，同时避免把相关性较高的指标未经实证全部固化为 AND 门禁。

### 4.3 删除指标

永久删除：

```text
主动买量 / 主动卖量
主动成交量占比
CVD / Tick CVD
基于 Trade.direction 的订单流代理
严格 OFI / MLOFI
Observed OFI / Observed Book Delta
成交吸收
broker volume concentration
broker 净买卖意图
交易所事件时间恢复速度
```

不得提供回退版本、兼容字段或替代代理。

## 5. 目标架构

### 5.1 模块结构

```text
src/main/asyncProgram/trendSignalVerifier/
  index.ts
  types.ts
  utils.ts

src/main/asyncProgram/orderBookSignalVerifier/
  index.ts
  types.ts
  utils.ts

src/main/signalVerificationRuntime/
  index.ts
  types.ts

src/main/marketDataSubscriptionRuntime/
  index.ts
  types.ts

src/main/orderBookCache/
  index.ts
  types.ts
  utils.ts

src/services/quoteClient/
  index.ts
  types.ts
```

职责：

- `trendSignalVerifier`：趋势延续算法。
- `orderBookSignalVerifier`：订单簿窗口算法。
- `signalVerificationRuntime`：pending verification 的唯一对外 owner，内部按 mode 委托算法。
- `marketDataSubscriptionRuntime`：所有 QuoteContext Quote / Candlestick / Depth / Brokers 订阅、服务端事实确认与 seed 的唯一串行协调器。
- `orderBookCache`：Depth 与 Brokers 两条独立流的短窗口事实。
- `quoteClient`：完整封装 SDK 公共接口、错误分类和回调 fan-out。

### 5.2 信号链路

```text
K 线事件
-> strategy.generateCandidateSignals()
-> prepareSignal()
-> resolveVerificationMode(action)
   -> none
      -> 普通守卫
      -> IMMEDIATE queue
   -> trend
      -> 构造趋势验证请求
      -> signalVerificationRuntime
   -> orderBook
      -> 构造订单簿验证请求
      -> signalVerificationRuntime
```

Strategy 不读取 verification config，不创建未来验证时间。

Pipeline 是唯一模式解析 owner。

订单簿请求的时间来源固定为：

1. `signalObservedEpochMs`与`signalObservedMonotonicMs`：原始 K 线 callback 命中 monitor route 时立即从同一个注入时钟同时捕获；前者用于审计与外部业务时间关联，后者是订单簿验证窗口的唯一起点。
2. `signalDetectedEpochMs`与`signalDetectedMonotonicMs`：Pipeline 在本次候选评估开始时从同一个注入时钟同时捕获；它们用于候选产生时间、内部延迟审计和`Signal.triggerTime`，不得改写订单簿验证窗口起点。
3. `monitorReferencePrice`：本次候选所使用的`IndicatorSnapshot.price`，即同一 monitor K 线快照价格；不额外读取 realtime quote，也不使用 trading symbol 价格。

`businessEventProgram`必须把 route state 中的 observed epoch / monotonic 成对传给 Pipeline。Pipeline 负责捕获 detected 时间并写入候选信号；`Signal.triggerTime`恢复为真实候选产生时间，不再承载未来验证时间。single-flight 等待时间可以体现在 detected 与 observed 的差值中，但不得通过推迟订单簿窗口起点来掩盖。

### 5.3 Trend 迁移契约

删除 Strategy 内部分类后，Pipeline 负责构造 `TrendVerificationRequest`，并完整保持当前趋势验证业务语义：

1. 候选信号产生时，从当前 `IndicatorSnapshot`读取该动作配置的全部初始指标。
2. 任一初始指标缺失或无效时，不登记趋势验证，返回 `data-incomplete`。
3. Schema 将 `delaySeconds`转换为内部 `DurationMs`，通过 `addEpochDuration(candidateDetectedEpochMs, delay)`得到`trendBaseEpochMs`。
4. verifier 的目标样本时间仍为：

```text
T0 = trendBaseEpochMs
T1 = trendBaseEpochMs + 5s
T2 = trendBaseEpochMs + 10s
```

5. verifier 在 `T2`到达后由一次性 scheduler 唤醒。
6. 三个时间点继续使用 IndicatorCache 当前约定的最近样本读取语义，不增加时间容差或补值。
7. 三个时间点的全部配置指标都必须存在且通过。
8. `BUYCALL / SELLPUT`普通指标要求高于初始值。
9. `BUYPUT / SELLCALL`普通指标要求低于初始值。
10. `ADX`对所有动作仍要求后续值低于初始值。
11. timer、pending、取消和 fatal error 所有权归 `signalVerificationRuntime`，趋势纯算法不单独拥有生命周期。

该迁移只改变职责归属，不改变现有趋势判断结果和取样时序。

### 5.4 统一回流

验证通过后的统一路径：

```text
verification result = verified
-> 生命周期交易门禁
-> 末日接管门禁
-> 席位状态
-> 席位版本
-> 标的一致性
-> VERIFIED_BUY / VERIFIED_SELL queue
```

`openProtectionActive`不属于验证通过后的统一回流门禁。它只阻断新的普通信号评估与新的验证注册；已进入等待中的普通验证若在保护期内通过，仍按上述统一回流路径继续分流。末日接管门禁保持现有更强语义：阻断回流，并清理仍在等待中的普通验证。

执行层继续使用信号原始产生时间做跨交易日和失效判断。

时间使用独立品牌字段：

```text
signalObservedEpochMs
signalObservedMonotonicMs
signalDetectedEpochMs
signalDetectedMonotonicMs
verificationReadyEpochMs
```

不得重新把 `Signal.triggerTime`解释成“未来验证时间”。

### 5.5 验证结果

结果使用判别联合：

```ts
type VerificationResult =
  | {
      readonly status: 'verified';
      readonly verificationReadyEpochMs: EpochTimestampMs;
      readonly audit: CompleteVerificationAudit;
    }
  | {
      readonly status: 'rejected';
      readonly reasonCode: VerificationRejectionReason;
      readonly audit: VerificationAudit;
    }
  | {
      readonly status: 'data-incomplete';
      readonly reasonCode: VerificationDataReason;
      readonly missingSources: ReadonlyArray<VerificationDataSource>;
      readonly audit: VerificationAudit;
    }
  | {
      readonly status: 'cancelled';
      readonly reasonCode: VerificationCancellationReason;
    };

type ConfirmationEvaluation =
  | {
      readonly status: 'passed';
      readonly kind: ConfirmationConfig['kind'];
      readonly measuredValue: number;
    }
  | {
      readonly status: 'rejected';
      readonly kind: ConfirmationConfig['kind'];
      readonly measuredValue: number;
      readonly reasonCode: VerificationRejectionReason;
    }
  | {
      readonly status: 'undefined';
      readonly kind: ConfirmationConfig['kind'];
      readonly reasonCode: VerificationDataReason;
    };

type CompleteVerificationAudit = Brand<VerificationAudit, 'CompleteVerificationAudit'>;
```

语义：

- `verified`：全部必需业务条件通过。
- `rejected`：数据完整，但策略条件未通过。
- `data-incomplete`：必需数据缺失、合法 sparse observation、容量溢出或已配置 confirmation 无定义。
- `cancelled`：生命周期、席位版本、方向清理或 shutdown 取消。

预期业务拒绝不得使用异常控制流。

内部不变量、非法 payload、缓存契约、订阅状态机和 verified handler 异常不属于普通验证结果。它们生成独立 fatal audit event，并提交应用级统一 fatal sink；对应 pending verification 被取消，不得再额外发布`data-incomplete`或其他普通结果。

`CompleteVerificationAudit`只能由单一纯构造函数产生。该函数必须验证：

1. 核心门禁结果全部存在且通过。
2. validated config 的 confirmation kind 集合与 evaluation kind 集合完全相等。
3. 不存在重复 evaluation。
4. 全部 confirmation evaluation 均为 `passed`。

缺少、拒绝或 undefined 任一已配置 confirmation 时，无法构造`CompleteVerificationAudit`，因此无法构造`verified`。

## 6. 配置设计

### 6.1 外部配置键

每个 monitor 使用动作级模式：

```text
VERIFICATION_MODE_BUYCALL_N=NONE|TREND|ORDER_BOOK
VERIFICATION_MODE_BUYPUT_N=NONE|TREND|ORDER_BOOK
VERIFICATION_MODE_SELLCALL_N=NONE|TREND
VERIFICATION_MODE_SELLPUT_N=NONE|TREND
```

趋势配置使用动作级键：

```text
TREND_VERIFICATION_DELAY_SECONDS_BUYCALL_N
TREND_VERIFICATION_INDICATORS_BUYCALL_N
TREND_VERIFICATION_DELAY_SECONDS_BUYPUT_N
TREND_VERIFICATION_INDICATORS_BUYPUT_N
TREND_VERIFICATION_DELAY_SECONDS_SELLCALL_N
TREND_VERIFICATION_INDICATORS_SELLCALL_N
TREND_VERIFICATION_DELAY_SECONDS_SELLPUT_N
TREND_VERIFICATION_INDICATORS_SELLPUT_N
```

订单簿配置使用每个 monitor 唯一 JSON：

```text
ORDER_BOOK_VERIFICATION_CONFIG_N
```

同一 monitor 的 BUYCALL 与 BUYPUT 共用镜像对称的订单簿配置。

最终 `.env.example` 与当前活动文档至少提供两组可直接通过 parse 的正向示例：

1. 一个 `SecurityBoard.HKEquity` monitor 使用 `ORDER_BOOK`。
2. 一个非 `ORDER_BOOK` monitor 使用合法的 `TREND` / `NONE` 组合。

必须删除并停止读取旧键：

```text
VERIFICATION_DELAY_SECONDS_BUY_N
VERIFICATION_DELAY_SECONDS_SELL_N
VERIFICATION_INDICATORS_BUY_N
VERIFICATION_INDICATORS_SELL_N
```

不保留兼容解析。

### 6.2 内部类型

```ts
type TrendVerificationConfigInput = {
  readonly mode: 'trend';
  readonly delaySeconds: number;
  readonly indicators: ReadonlyArray<VerificationIndicator>;
};

type OrderBookVerificationConfigInput = {
  readonly mode: 'orderBook';
  // 外部 JSON 输入结构，字段由单一 Schema 校验。
};

type NoVerificationConfig = {
  readonly mode: 'none';
};

type ValidatedTrendVerificationConfig = Brand<
  {
    readonly mode: 'trend';
    readonly delay: DurationMs;
    readonly indicators: ReadonlyArray<VerificationIndicator>;
  },
  'ValidatedTrendVerificationConfig'
>;

type ValidatedOrderBookVerificationConfig = Brand<
  OrderBookVerificationConfig,
  'ValidatedOrderBookVerificationConfig'
>;

type BuyActionVerificationMode =
  | NoVerificationConfig
  | ValidatedTrendVerificationConfig
  | {
      readonly mode: 'orderBook';
    };

type SellActionVerificationMode = NoVerificationConfig | ValidatedTrendVerificationConfig;

type MonitorVerificationConfig = {
  readonly byAction: {
    readonly BUYCALL: BuyActionVerificationMode;
    readonly BUYPUT: BuyActionVerificationMode;
    readonly SELLCALL: SellActionVerificationMode;
    readonly SELLPUT: SellActionVerificationMode;
  };
  readonly orderBook: ValidatedOrderBookVerificationConfig | null;
};
```

`ValidatedOrderBookVerificationConfig`只在 monitor 根配置中存在一份。动作级`orderBook`分支只表达模式选择，不携带配置副本，因此 BUYCALL 与 BUYPUT 无法表示两份不同订单簿配置。

`MonitorVerificationConfig`是配置校验边界产出的内部对象，不接受手写对象字面量直入运行时；6.5 的跨字段规则负责保证 `byAction` 与 `orderBook` 的对应关系，无需再引入交叉乘积式兼容类型。

`OrderBookVerificationConfig` 按职责分组：

```ts
type OrderBookVerificationConfig = {
  readonly mode: 'orderBook';
  readonly sampling: {
    readonly windowMs: DurationMs;
    readonly shockWindowRatio: number;
    readonly minDepthSamplesPerPhase: number;
    readonly maxDepthGapMs: DurationMs;
    readonly maxDepthAgeMs: DurationMs;
  };
  readonly quality: {
    readonly maxSpreadBps: number;
  };
  readonly bookReversal: {
    readonly shockThreshold: number;
    readonly recoveryThreshold: number;
  };
  readonly depthRecovery: {
    readonly minDepletionRatio: number;
    readonly minRecoveryRatio: number;
  };
  readonly pricePath: {
    readonly maxAdverseMoveBps: number;
    readonly minRecoveryBps: number;
    readonly finalReferenceToleranceBps: number;
  };
  readonly confirmations: ReadonlyArray<ConfirmationConfig>;
};

type ConfirmationConfig =
  | {
      readonly kind: 'orderCountImbalance';
      readonly shockThreshold: number;
      readonly recoveryThreshold: number;
    }
  | {
      readonly kind: 'micropricePremium';
      readonly shockPremiumBps: number;
      readonly recoveryPremiumBps: number;
    }
  | {
      readonly kind: 'depthNotional';
      readonly minTop10DepthNotionalHkd: number;
    }
  | {
      readonly kind: 'brokerBreadth';
      readonly maxPosition: number;
      readonly minSamplesPerPhase: number;
      readonly maxGapMs: DurationMs;
      readonly maxAgeMs: DurationMs;
      readonly minBaselineBreadth: number;
      readonly minRetentionRatio: number;
    };
```

`confirmations`本身就是 required confirmation 集合，不再维护“配置对象 + required 名称数组”两套事实。

Schema 输出按 `kind`去重的只读 opaque confirmation set。验证评估结果也按 `kind`形成判别结果，决策函数只接受已经完整评估全部 confirmation 的结构。

Pipeline 不接收通用 `VerificationMode`继续分流。模式解析函数按 action 返回对应的动作配置联合，从类型上阻止卖出进入 `orderBook`。

### 6.3 固定常量

以下不是 monitor 策略配置自由度：

```text
ORDER_BOOK_DEPTH_LEVELS = 10
ORDER_BOOK_MAX_BROKER_POSITION = 40
ORDER_BOOK_CACHE_MAX_DEPTH_OBSERVATIONS_PER_SYMBOL
ORDER_BOOK_CACHE_MAX_BROKER_OBSERVATIONS_PER_SYMBOL
```

固定值统一定义在 `src/constants`。

不保留 `depthLevels: 10` 配置字段。

缓存容量属于共享运行时资源不变量，不属于单 monitor 策略。容量常量必须根据“最大允许窗口 + 压测 push burst + 安全余量”确定，并由性能测试验证；两个 monitor 共享 symbol 时只有一套容量事实。

首版十档聚合使用等权求和，不定义`ORDER_BOOK_LEVEL_WEIGHTS`。事件回放证明确有稳定的档位加权收益后，再单独设计并重新验证权重模型；本次重构不提前引入该自由度。

### 6.4 Schema 与类型封口

外部 JSON 通过单一 Schema 校验后输出 branded validated config。

Schema 必须验证：

1. `windowMs > 0`。
2. `shockWindowRatio` 严格位于 `(0, 1)`。
3. Depth 最小样本数大于零。
4. Depth 最大间隔和最大年龄均大于零。
5. spread 和价格路径阈值为有限值且范围合法。
6. brokerBreadth confirmation 存在时，`maxPosition`位于 `[1, 40]`。
7. brokerBreadth confirmation 存在时，其样本数、gap、age 和 baseline breadth 均大于零。
8. depthNotional confirmation 存在时，其门槛为有限正数。
9. imbalance 阈值位于 `[-1, 1]`。
10. depletion / recovery / retention 比率范围合法。
11. `confirmations.kind` 无重复项。
12. 每个 confirmation 分支自身字段完整。

删除冗余的 `minBookImbalanceReversal` 和 `minOrderCountImbalanceReversal`。

冲击端点与恢复端点已经完整定义反转，不再增加可能恒成立的第三个差值条件。

Schema 放在 `src/config/`对应配置模块或独立 `schema.ts`，不得放入 `types.ts`。`types.ts`只定义有独立注释的数据类型和行为契约。

### 6.5 模式与配置键矩阵

每个动作严格执行：

| mode | 必需键 | 禁止键 |
| --- | --- | --- |
| `NONE` | mode 键 | 该动作全部 trend 键 |
| `TREND` | mode、正数 delay、非空合法 indicators | orderBook 只属于 monitor 级共享配置，不由该动作单独读取 |
| `ORDER_BOOK` | mode、`ORDER_BOOK_VERIFICATION_CONFIG_N` | 该动作全部 trend 键 |

monitor 级规则：

1. BUYCALL 与 BUYPUT 均未选择 `ORDER_BOOK`时，`ORDER_BOOK_VERIFICATION_CONFIG_N`禁止存在。
2. 任一买入动作选择 `ORDER_BOOK`时，`ORDER_BOOK_VERIFICATION_CONFIG_N`必须存在且通过 Schema。
3. `NONE`动作存在 trend 残留键时直接失败。
4. `TREND`动作 delay 非正、指标为空或存在不支持指标时直接失败。
5. `ORDER_BOOK`动作存在 trend 残留键时直接失败。
6. 任何旧 BUY/SELL verification 键存在时直接失败，不静默忽略。

## 7. 标的和订阅准入

### 7.1 标的类型

`orderBook`验证固定读取`monitorSymbol`的订单簿。`tradingSymbol`只用于最终买入任务和席位一致性，不参与订单簿订阅、指标或价格路径判断。

`orderBook` 只允许：

```text
SecurityBoard.HKEquity
```

以下 board 配置 `orderBook` 时，在订阅前的静态信息准入阶段 fail-fast：

```text
SecurityBoard.HKHS
SecurityBoard.HKWarrant
SecurityBoard.HKSector
US*
CN*
SG*
```

不使用 symbol 后缀猜测 board。

指数 monitor 不自动改用 trading symbol、ETF、成分股或其他代理订单簿。该行为会改变策略事实源，属于禁止的 fallback。

### 7.2 权限与市场状态分层

必须区分：

#### 系统级准入失败

- board 不支持。
- `SubType.Depth`订阅失败。
- 配置包含 brokerBreadth confirmation 且 `SubType.Brokers`订阅失败。
- `subscriptions()`无法确认已提交 subtype。
- SDK 返回结构违反公开类型契约。

这些失败阻断本次 startup / rebuild。

#### 合法市场状态

- 少于十个非空 Depth price levels。
- Broker Queue 返回位置较少。
- Broker Queue position 不连续。
- 某个合法 position 的 `brokerIds`为空。
- 盘前、竞价、午休或收盘后没有连续交易盘口。

这些状态不解释为权限失败，不阻断 7x24 程序启动。

连续交易期间注册订单簿验证时，必需数据不足会拒绝当前信号。

### 7.3 初始化

订阅成功后：

1. 使用`subscriptions()`确认本次目标 Quote / Candlestick / Depth / Brokers requirement。
2. Candlestick subscribe 返回值建立 1 分钟 K 线 seed。
3. 始终调用`realtimeDepth()`读取 SDK 当前状态。
4. 仅在配置包含 brokerBreadth confirmation 时订阅 Brokers 并调用`realtimeBrokers()`。
5. 合法返回写入对应缓存。
6. `301603 No quotes`记录为`seed-unavailable`，不解释为权限失败，允许 startup / rebuild 继续。
7. 空或稀疏返回作为合法市场状态记录。
8. 后续首个有效 push 可以建立本 generation 的首个可用事实。
9. 连续交易信号注册时仍无有效 Depth 基线，只拒绝当前信号。

订阅 Promise 成功不等于实时缓存已经收到首个稠密快照。

订单簿模块不通过轮询等待数据，不降低档位，不临时关闭已配置 confirmation。

本次重构不新增 quote API 请求级重试。外部数据可用性失败返回给现有 lifecycle rebuild 状态机；单次 rebuild 尝试立即停止，交易门禁保持关闭。

### 7.4 错误分类

| 错误 | 分类 | 处理 |
| --- | --- | --- |
| 配置、Schema、board 不支持 | 配置/能力错误 | startup 立即终止 |
| `301604 No access` | 非暂态能力准入错误 | startup 立即终止；rebuild 提交 fatal sink 并保持交易关闭，不进入自动重试 |
| `301603 No quotes` | 合法无 realtime seed | 写入 `seed-unavailable`，等待 push，不阻断启动 |
| 网络、限流、服务端暂态失败 | 外部请求错误 | 请求内重试次数固定为零，包装为 `ExternalApiRequestError(attempts=1)`交给现有 lifecycle |
| `subscriptions()`请求本身失败 | 外部请求错误 | 当前 rebuild 失败，可由现有 lifecycle 对明确暂态错误重评估 |
| `subscriptions()`成功返回但缺少已请求 requirement | 非暂态能力/事实错误 | 应用级 fatal sink，交易保持关闭 |
| realtime 接口除 `No quotes`外的请求失败 | 外部请求错误 | 当前 rebuild 失败 |
| 非法 SDK payload、generation、缓存或状态机矛盾 | 内部错误 | 应用级 fatal sink |
| QuoteClient callback adapter 暴露的连接/推送错误 | 外部运行时错误 | 应用级 fatal sink，等待应用统一退出与恢复 |

不修改现有 lifecycle 对 `ExternalApiRequestError`的恢复入口，不在订单簿模块内部另建重试循环。

错误码分类只允许读取 SDK 错误对象的结构化 code 字段，或由锁定版本集成测试确认的精确错误契约；禁止通过宽泛文本包含关系把普通网络错误误判为`301603 / 301604`。若运行环境无法稳定取得结构化业务码，必须在生产启用前先完成真实 API 集成验证，不能自行猜测分类。

## 8. MarketDataClient 与订阅 owner

### 8.1 MarketDataClient 契约

现有`MarketDataClient`的行情读取、K 线读取、交易日和轮证查询能力继续保留。低层 mutation/readback 能力单独形成只供订阅协调器注入的内部行为端口：

```text
QuoteContextMutationPort:
getStaticInfo
getQuoteDiagnosticInfo
subscribeSubtypes
unsubscribeSubtypes
getSubscriptions
getRealtimeDepth
getRealtimeBrokers
onDepth
onBrokers
subscribeCandlestick
unsubscribeCandlestick
resetRuntimeMarketData
```

订阅结果必须表达每个`symbol + subtype`或`symbol + candlestick period`的提交事实，不能只返回`Promise<void>`。

`QuoteContextMutationPort`只注入`marketDataSubscriptionRuntime`。`loadTradingDayRuntimeSnapshot`、CacheDomain、MonitorContext 和业务模块依赖的类型中不得出现 subscribe、unsubscribe、subscriptions 或 reset 等低层方法；不能仅依赖代码评审约定限制调用权。

`marketDataSubscriptionRuntime`向 lifecycle 暴露高层事务端口：

```text
resetAndReconcile(targetRequirements)
seedCurrentRealtimeState()
stopAndDrain()
```

`loadTradingDayRuntimeSnapshot`只提交目标订阅事实并消费高层事务结果。

### 8.2 唯一订阅协调器

现有 `quoteSubscriptionRuntime` 重构为 requirement-aware `marketDataSubscriptionRuntime`。

retain key：

```text
owner
symbol
requirement
```

统一维护：

```text
desired Quote / Candlestick / Depth / Brokers requirement
committed requirement
single mutation chain
generation
running state
```

Quote、Candlestick 与 order-book 保留独立业务 retain 来源，但所有操作同一`QuoteContext`的 SDK mutation 必须经过同一串行链。

禁止创建独立 `orderBookSubscriptionRuntime`直接并发操作 `QuoteContext`。

### 8.3 状态机

```ts
type MarketDataSubscriptionState =
  | {
      readonly status: 'stopped';
      readonly generation: MarketDataGeneration;
      readonly committed: readonly [];
    }
  | {
      readonly status: 'reconciling';
      readonly generation: MarketDataGeneration;
      readonly desired: ReadonlyArray<SubscriptionRequirement>;
      readonly committed: ReadonlyArray<AdmittedSubscriptionRecord>;
    }
  | {
      readonly status: 'active';
      readonly generation: MarketDataGeneration;
      readonly reconciled: ReconciledSubscriptionSet;
    }
  | {
      readonly status: 'stopping';
      readonly generation: MarketDataGeneration;
      readonly committed: ReadonlyArray<AdmittedSubscriptionRecord>;
    }
  | {
      readonly status: 'failed';
      readonly generation: MarketDataGeneration;
      readonly reasonCode: SubscriptionFailureReason;
      readonly lastKnownFacts: ReadonlyArray<SubscriptionFact>;
    };

type SubscriptionFact = {
  readonly symbol: string;
  readonly requirement:
    | {
        readonly kind: 'subtype';
        readonly subtype: SubType;
      }
    | {
        readonly kind: 'candlestick';
        readonly period: Period;
        readonly tradeSessions: TradeSessions;
      };
  readonly state: 'committed' | 'rejected' | 'unknown';
};

type ReconciledSubscriptionSet = Brand<
  {
    readonly requirements: ReadonlyArray<SubscriptionRequirement>;
    readonly admitted: ReadonlyArray<AdmittedSubscriptionRecord>;
  },
  'ReconciledSubscriptionSet'
>;
```

`stopped`只允许在退订完成且`subscriptions()`确认 requirement 集合为空后进入。任一退订或事实确认失败时必须停留在`failed`并保留`lastKnownFacts`；shutdown 可以继续清理其他本地资源，但不得把未知或仍 committed 的服务端事实改写为空。

稳态`active`只允许保存已经通过服务端事实确认的 requirement。

`AdmittedSubscriptionRecord`只能由`subscriptions()`确认的 subtype / candlestick period 结果构造，并携带当前 branded generation。

`ReconciledSubscriptionSet`只能在 requirements 与 admitted 按 requirement identity 完全相等、没有`rejected/unknown`事实时构造。`active`状态不能保存部分确认结果。

部分成功处理：

1. mutation 前读取并保存服务端`subscriptions()`权威 baseline。
2. 提交目标 requirement。
3. 再次读取服务端事实，精确确认本事务新增项。
4. 整体未完成时只撤销`after - baseline`，不得退订事务开始前已存在的 requirement。
5. 事实查询或撤销失败进入`failed`，不得伪造 committed truth。

该过程属于状态恢复，不属于业务 fallback。

### 8.4 所需 requirement 编译

每个 monitor 从 validated action config 编译确定性数据依赖：

```text
每个 monitor
-> 必需 Quote
-> 必需 1 分钟 Candlestick

任一动作使用 orderBook
-> 必需 SubType.Depth

任一 orderBook config 包含 brokerBreadth confirmation
-> 额外必需 SubType.Brokers
```

未配置 brokerBreadth 时：

- 不订阅 Brokers。
- 不调用 realtimeBrokers。
- 不创建 Broker 完整性门禁。
- Brokers 不可用不得影响 startup、rebuild 或信号验证。

这是按策略声明裁剪依赖，不是运行时 fallback。

完整目标 requirements 还必须包含当前恢复席位、持仓和在途订单要求的 Quote。requirements 只能在账户、持仓、全量订单和席位恢复事实加载完成后统一编译，不能在这些事实产生前提前提交。

`resetAndReconcile()`只允许在业务事件 owner 已停止、旧 generation 的 transient retain 已清理且没有并发 retain mutation 时调用。rebuild 期间的 ACTIVATING 席位直接编译进本次目标 requirements；新 generation 激活后产生的临时 retain 才进入稳态增量 mutation chain。

## 9. Depth 与 Broker Queue 标准化

### 9.1 时间与顺序

时间使用不可互换的品牌类型：

```ts
type EpochTimestampMs = Brand<number, 'EpochTimestampMs'>;
type MonotonicTimestampMs = Brand<number, 'MonotonicTimestampMs'>;
type DurationMs = Brand<number, 'DurationMs'>;
type ArrivalOrdinal = Brand<number, 'ArrivalOrdinal'>;
type MarketDataGeneration = Brand<number, 'MarketDataGeneration'>;
```

上述品牌类型、`Brand`、`AdmittedHkEquitySymbol`和`SeatIdentity`必须在一个公共类型源中定义。裸值只能通过以下边界构造：

- clock adapter 构造 epoch / monotonic 时间。
- Schema 构造 duration。
- subscription runtime 构造 generation 与 arrival ordinal。
- static-info admission 构造`AdmittedHkEquitySymbol`。
- symbol registry 席位投影构造`SeatIdentity`。

禁止在业务模块散布`as EpochTimestampMs`等断言。

时间运算只能通过纯函数：

```ts
addMonotonicDuration(
  base: MonotonicTimestampMs,
  duration: DurationMs,
): MonotonicTimestampMs;

addEpochDuration(
  base: EpochTimestampMs,
  duration: DurationMs,
): EpochTimestampMs;

scaleDuration(
  duration: DurationMs,
  ratio: number,
): DurationMs;

elapsedMonotonic(
  start: MonotonicTimestampMs,
  end: MonotonicTimestampMs,
): DurationMs;
```

禁止直接使用 `timestamp + number`构造窗口边界。

每次回调入口记录：

```text
receivedEpochMs
receivedMonotonicMs
arrivalOrdinal
generation
```

- `receivedEpochMs`用于日志与业务时间关联。
- `receivedMonotonicMs`用于本进程间隔和新鲜度。
- `arrivalOrdinal`用于本进程观察顺序。
- 这些字段均不能证明交易所事件连续性。
- 订单簿窗口、gap 和 freshness 全部使用 monotonic 时间。
- epoch 时间只用于日志、审计和与外部业务事件关联。
- 禁止 epoch、monotonic 和 duration 裸 `number`交叉比较。

### 9.2 Depth 分类

Depth 输入分为三类：

#### 合法且策略可用

- symbol 合法。
- bid / ask 均有 position 1..10。
- position 唯一且顺序可标准化。
- price 非空、有限且大于零。
- volume 为合法非负整数。
- orderNum 为合法非负整数。

写入 `ValidatedTenLevelDepthSnapshot`。

核心类型：

```ts
type DepthPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

type ValidatedDepthLevel = {
  readonly position: DepthPosition;
  readonly price: number;
  readonly volume: number;
  readonly orderNum: number;
};

type TenDepthLevels = readonly [
  ValidatedDepthLevel,
  ValidatedDepthLevel,
  ValidatedDepthLevel,
  ValidatedDepthLevel,
  ValidatedDepthLevel,
  ValidatedDepthLevel,
  ValidatedDepthLevel,
  ValidatedDepthLevel,
  ValidatedDepthLevel,
  ValidatedDepthLevel,
];

type ValidatedTenLevelDepthSnapshot = Brand<
  {
    readonly symbol: AdmittedHkEquitySymbol;
    readonly bids: TenDepthLevels;
    readonly asks: TenDepthLevels;
    readonly receivedEpochMs: EpochTimestampMs;
    readonly receivedMonotonicMs: MonotonicTimestampMs;
    readonly arrivalOrdinal: ArrivalOrdinal;
    readonly generation: MarketDataGeneration;
  },
  'ValidatedTenLevelDepthSnapshot'
>;
```

只有标准化工厂可以构造该品牌类型。SDK 原始对象不得直接进入缓存。`volume`和`orderNum`必须为有限、非负、安全整数；任何聚合、比例或名义金额计算结果必须为有限值。

#### 合法但当前策略不可用

- SDK payload 结构合法。
- 任一侧当前少于十个非空价格层。

记录 `sparse-market-state`，不写入十档指标样本，不标记系统故障。

覆盖当前验证窗口时，该信号返回 `data-incomplete`。

#### 非法 payload

- position 重复或非法。
- 数值违反公开字段契约。
- symbol 或 generation 不一致。

立即进入 fatal error channel，不写入普通缓存 observation，也不生成普通 VerificationResult。

### 9.3 Broker Queue 分类

合法 Broker Queue：

- 输入数组存在。
- 每个返回 entry 的 position 是正整数且不大于 40。
- 同侧 position 不重复。
- broker ID 为正整数。
- `brokerIds`空数组是合法市场状态。
- position 不连续是合法市场状态。

不要求买卖两侧完整覆盖 `1..maxPosition`。

计算时只使用：

```text
returnedEntry.position <= configured maxPosition
```

非法字段结构立即进入 fatal error channel，不写入普通缓存 observation。

标准化 Broker 类型：

```ts
type ValidatedBrokerQueueEntry = {
  readonly position: number;
  readonly brokerIds: ReadonlyArray<number>;
};

type ValidatedBrokerQueueSnapshot = Brand<
  {
    readonly symbol: AdmittedHkEquitySymbol;
    readonly bids: ReadonlyArray<ValidatedBrokerQueueEntry>;
    readonly asks: ReadonlyArray<ValidatedBrokerQueueEntry>;
    readonly receivedEpochMs: EpochTimestampMs;
    readonly receivedMonotonicMs: MonotonicTimestampMs;
    readonly arrivalOrdinal: ArrivalOrdinal;
    readonly generation: MarketDataGeneration;
  },
  'ValidatedBrokerQueueSnapshot'
>;
```

Broker position 上限和唯一性由标准化工厂校验，原始 SDK entry 不进入业务缓存。

### 9.4 不做跨流配对

Depth 与 Brokers：

- 没有公开共同 sequence。
- 没有公开共同交易所事件时间。
- 推送频率独立。

因此删除：

```text
maxSnapshotGapMs
最近 Depth/Broker 配对
每个 Depth 必须存在 Broker 配对
PairedOrderBookObservation
```

两条流分别进行：

- 基线选择。
- 冲击阶段聚合。
- 恢复阶段聚合。
- 最小样本数判断。
- 最大相邻间隔判断。
- 最终新鲜度判断。

Broker Queue 未变化而复用最新状态，不得伪装成产生了多个 Broker 样本。Broker 样本数只按真实 Broker 回调或 realtime seed 计数。

## 10. OrderBookCache

缓存按：

```text
symbol
stream
generation
```

分别保存 Depth 与 Brokers。

功能：

1. 写入标准化十档 Depth。
2. 写入标准化 Broker Queue。
3. 按到达顺序写入每个 Depth observation 的分类事实，包括 validated 或 sparse。
4. 非法 payload 不写入普通 observation，直接提交 fatal sink。
5. 按时间窗口读取各自样本。
6. 查询触发前最近 observation；只有最近 observation 为 validated 时才能形成基线，禁止穿透 sparse observation 回退到更旧完整样本。
7. 查询窗口内 sparse 状态与 overflow marker。
8. 按 symbol 清理。
9. 按 generation 整体清理。

缓存不感知 LONG / SHORT direction。

direction / action 清理由 `signalVerificationRuntime`负责。

### 10.1 有界容量

每个 symbol、每条流同时受应用级固定容量与时间窗口上限约束：

- 时间窗口上限。
- 最大条目数上限。

容量溢出时：

1. 标记该 stream 窗口不完整。
2. 相关 pending signal 返回 `data-incomplete`。
3. 不允许静默覆盖后继续验证。

写缓存时预计算不依赖信号方向的快照指标，减少每个 pending signal 重复转换和遍历。容量不从 monitor 配置读取。

## 11. 指标公式

首版全部十档指标使用 position 1..10 的等权聚合。该选择不额外引入未经验证的权重参数，同时完整保留十档公开数据。

### 11.1 Mid-price

```text
mid = (ask1 + bid1) / 2
```

### 11.2 Spread BPS

```text
spreadBps = (ask1 - bid1) / mid * 10000
```

该指标只衡量 quoted spread，不代表佣金、印花税、冲击成本或完整滑点。

### 11.3 L1 Microprice

```text
microprice =
  (ask1 * bidVolume1 + bid1 * askVolume1)
  / (bidVolume1 + askVolume1)
```

分母为零时指标无定义。

### 11.4 Microprice Premium BPS

```text
micropricePremiumBps =
  (microprice - mid) / mid * 10000
```

它是 L1 显示数量失衡派生的报价偏移，不解释为真实主动订单压力。

### 11.5 Top-10 Displayed Volume Imbalance

```text
top10BidVolume = Σ(bidVolume_i)
top10AskVolume = Σ(askVolume_i)

bookImbalance =
  (top10BidVolume - top10AskVolume)
  / (top10BidVolume + top10AskVolume)
```

结果范围：

```text
[-1, 1]
```

分母为零时无定义。

### 11.6 Top-10 Order Count Imbalance

```text
top10BidOrderCount = Σ(bidOrderNum_i)
top10AskOrderCount = Σ(askOrderNum_i)

orderCountImbalance =
  (top10BidOrderCount - top10AskOrderCount)
  / (top10BidOrderCount + top10AskOrderCount)
```

分母为零时无定义。

### 11.7 Top-10 Displayed Depth Notional

```text
top10BidNotional = Σ(bidPrice_i * bidVolume_i)
top10AskNotional = Σ(askPrice_i * askVolume_i)
top10TotalNotional = top10BidNotional + top10AskNotional
```

该指标是当前显示盘口规模，不代表实际可完全成交金额。

### 11.8 单侧显示深度

恢复指标统一使用十档等权显示数量，不使用 notional：

```text
bidDisplayedDepth = Σ(bidVolume_i)
askDisplayedDepth = Σ(askVolume_i)
```

### 11.9 单侧显示深度收缩比例

BUYCALL 使用 bid side：

```text
bidContractionRatio =
  (baselineBidDepth - shockMinBidDepth)
  / baselineBidDepth
```

BUYPUT 使用 ask side：

```text
askContractionRatio =
  (baselineAskDepth - shockMinAskDepth)
  / baselineAskDepth
```

基线必须大于零。

### 11.10 单侧显示深度再扩张比例

```text
bidReExpansionRatio =
  recoveryBidDepth / baselineBidDepth

askReExpansionRatio =
  recoveryAskDepth / baselineAskDepth
```

术语必须使用“Top-10 单侧显示深度收缩与再扩张”。

不得描述为同一订单队列被成交耗尽后得到补充，因为窗口内价格梯级可以移动。

### 11.11 Broker Breadth

```text
bidBrokerBreadth =
  count(unique brokerIds from returned bid entries
        where position <= maxPosition)

askBrokerBreadth =
  count(unique brokerIds from returned ask entries
        where position <= maxPosition)
```

同一 broker ID 在多个 position 出现时只计一次。

### 11.12 Broker Breadth Retention

```text
bidBrokerRetention =
  recoveryBidBrokerBreadth / baselineBidBrokerBreadth

askBrokerRetention =
  recoveryAskBrokerBreadth / baselineAskBrokerBreadth
```

基线必须：

```text
>= minBaselineBreadth
```

基线为零或低于配置门槛时，说明已观测到的经纪队列参与广度不满足策略质量门槛，required broker breadth 指标返回 `rejected`；只有缺少 Broker 基线样本时才返回 `data-incomplete`。

## 12. 验证窗口

订单簿验证请求使用闭合类型：

```ts
type OrderBookVerificationRequest = {
  readonly action: 'BUYCALL' | 'BUYPUT';
  readonly monitorSymbol: AdmittedHkEquitySymbol;
  readonly tradingSymbol: string;
  readonly signalObservedEpochMs: EpochTimestampMs;
  readonly signalObservedMonotonicMs: MonotonicTimestampMs;
  readonly signalDetectedEpochMs: EpochTimestampMs;
  readonly signalDetectedMonotonicMs: MonotonicTimestampMs;
  readonly monitorReferencePrice: number;
  readonly seatIdentity: SeatIdentity;
  readonly seatVersion: number;
  readonly generation: MarketDataGeneration;
  readonly config: ValidatedOrderBookVerificationConfig;
};
```

构造规则：

1. `monitorSymbol`必须来自 staticInfo board 校验后的`AdmittedHkEquitySymbol`。
2. `action`只能是买入动作。
3. `generation`必须等于当前 active market-data generation。
4. `monitorReferencePrice`来自本次候选评估所使用的`IndicatorSnapshot.price`，不额外查询 realtime quote，不使用交易标的价格。
5. `tradingSymbol`只用于最终买入信号和席位一致性，不参与 monitor mid-price 比较。
6. `signalObservedMonotonicMs`必须与`signalObservedEpochMs`来自同一次 K 线 callback 进入 route 时刻，不得在 Pipeline 内重建。
7. `verificationReadyEpochMs`只在 verified 结果产生时写入，不属于注册请求。

窗口：

```text
T0 = signalObservedMonotonicMs
shockDuration = scaleDuration(windowDuration, shockWindowRatio)
T1 = addMonotonicDuration(T0, shockDuration)
T2 = addMonotonicDuration(T0, windowDuration)
```

阶段：

```text
baseline：received <= T0 的最近 observation；该 observation 必须为 validated
shock：(T0, T1]
recovery：(T1, T2]
```

Depth 与 Brokers 分别选择自己的基线和阶段样本。

timer 实际晚于 T2 执行时，只读取 `[T0, T2]`，不得把晚到执行后的新样本加入原窗口。

窗口跨越午休、连续交易结束、末日接管或 generation 变化时取消，不允许跨边界继续验证。

### 12.1 阶段聚合规则

所有阶段聚合使用唯一规则：

- 数值中位数：排序后取中间值；偶数样本取中间两个值的算术平均。
- Book imbalance：shock 和 recovery 分别取阶段中位数。
- Order-count imbalance：shock 和 recovery 分别取阶段中位数。
- Microprice premium：shock 和 recovery 分别取阶段中位数。
- Shock side depth：取 shock 阶段最小值。
- Recovery side depth：取 recovery 阶段中位数。
- Shock mid-price 极值：BUYCALL 取 shock 阶段最低值，BUYPUT 取 shock 阶段最高值。
- Final mid-price：取 recovery 阶段 arrivalOrdinal 最大的 Depth 样本。
- Spread quality：取完整窗口最大 spread BPS。
- Depth notional quality：取完整窗口最小 Top-10 total notional。
- Broker recovery breadth：取 recovery 阶段真实 Broker 样本的中位数。
- Broker baseline：取 `receivedMonotonicMs <= T0`且 arrivalOrdinal 最大的真实 Broker 样本。

空集合不产生默认值，返回 `data-incomplete`。

## 13. 数据质量门禁

### 13.1 系统级内部错误

- 非法 payload。
- generation 契约违反。
- 缓存状态机矛盾。
- 订阅 committed truth 与状态机不变量冲突。

进入 fatal error channel。

### 13.2 单信号数据完整性

以下任一条件成立，当前信号返回`data-incomplete`：

- T0 前没有 Depth observation，或最近 Depth observation 为 sparse，无法形成基线。
- 已配置 brokerBreadth 且缺少 Broker 基线。
- 任一 Depth 阶段样本数不足。
- 已配置 brokerBreadth 且 Broker 阶段样本数不足。
- Depth 最大相邻间隔超限。
- 已配置 brokerBreadth 且 Broker 最大相邻间隔超限。
- 最终 Depth 新鲜度超限。
- 已配置 brokerBreadth 且 Broker 新鲜度超限。
- 窗口包含 sparse Depth market state。
- 缓存容量溢出。
- 任一已配置 confirmation 无定义。

不允许：

- 忽略无效样本后继续通过。
- 用较少档位重新计算。
- 用上一交易日样本补齐。
- 关闭缺失的已配置 confirmation。

非法 payload 属于系统级内部错误，直接进入 fatal sink、取消相关 pending verification，不再同时生成`data-incomplete`。

### 13.3 盘口质量

以下属于 `rejected`：

- quoted spread 超过上限。
- required depth notional 低于门槛。
- 数据完整但业务反转或恢复条件不通过。

## 14. BUYCALL 验证

### 14.1 核心条件

全部必须通过：

1. shock 阶段 book imbalance 中位数：

```text
<= -bookReversal.shockThreshold
```

2. recovery 阶段 book imbalance 中位数：

```text
>= bookReversal.recoveryThreshold
```

3. Bid Top-10 显示深度收缩：

```text
bidContractionRatio >= minDepletionRatio
```

4. Bid Top-10 显示深度再扩张：

```text
bidReExpansionRatio >= minRecoveryRatio
```

5. Shock 阶段向下破位：

```text
shockLowMid = min(shock phase mid-price)
adverseMoveBps =
  max(0, (monitorReferencePrice - shockLowMid)
         / monitorReferencePrice * 10000)

adverseMoveBps <= maxAdverseMoveBps
```

6. Recovery 阶段从窗口低点回收：

```text
finalMid = recovery phase 最后一个 arrivalOrdinal 的 mid-price
recoveryBps =
  (finalMid - shockLowMid) / shockLowMid * 10000

recoveryBps >= minRecoveryBps
```

7. 最终 mid-price 相对 signal reference price：

```text
finalReferenceDeviationBps =
  abs(finalMid - monitorReferencePrice)
  / monitorReferencePrice * 10000

finalReferenceDeviationBps <= finalReferenceToleranceBps
```

8. 全窗口 spread BPS 质量门禁通过。

### 14.2 Required confirmations

配置包含对应指标时追加：

- `orderCountImbalance`：shock 为负、recovery 为正。
- `micropricePremium`：shock 为负、recovery 为正。
- `depthNotional`：阶段内显示名义金额达到门槛。
- `brokerBreadth`：bid baseline 达到最小 breadth，recovery retention 达到门槛。

所有已配置 confirmations 必须通过。

## 15. BUYPUT 验证

规则与 BUYCALL 镜像。

### 15.1 核心条件

1. shock 阶段 book imbalance 中位数：

```text
>= bookReversal.shockThreshold
```

2. recovery 阶段 book imbalance 中位数：

```text
<= -bookReversal.recoveryThreshold
```

3. Ask Top-10 显示深度收缩达到门槛。

4. Ask Top-10 显示深度再扩张达到门槛。

5. Shock 阶段向上破位：

```text
shockHighMid = max(shock phase mid-price)
adverseMoveBps =
  max(0, (shockHighMid - monitorReferencePrice)
         / monitorReferencePrice * 10000)

adverseMoveBps <= maxAdverseMoveBps
```

6. Recovery 阶段从窗口高点回落：

```text
finalMid = recovery phase 最后一个 arrivalOrdinal 的 mid-price
recoveryBps =
  (shockHighMid - finalMid) / shockHighMid * 10000

recoveryBps >= minRecoveryBps
```

7. 最终 mid-price 相对 signal reference price 使用与 BUYCALL 相同的绝对偏离公式，并满足`finalReferenceToleranceBps`。

8. 全窗口 spread BPS 质量门禁通过。

### 15.2 Required confirmations

- `orderCountImbalance`：shock 为正、recovery 为负。
- `micropricePremium`：shock 为正、recovery 为负。
- `depthNotional`：阶段内显示名义金额达到门槛。
- `brokerBreadth`：ask baseline 达到最小 breadth，recovery retention 达到门槛。

## 16. 卖出边界

`SELLCALL / SELLPUT`只允许：

```text
none
trend
```

以下链路绝不进入 orderBook verifier：

- 保护性清仓。
- 末日清仓。
- 静态距回收价清仓。
- 距离换标移仓卖出。
- 周期换标相关卖出。
- 智能平仓。

风险退出优先级不因订单簿数据缺失而下降。

## 17. 生命周期

### 17.1 创建顺序

在 startup snapshot 之前创建：

1. QuoteClient callback fan-out。
2. MarketDataSubscriptionRuntime。
3. OrderBookCache。
4. SignalVerificationRuntime，并向其注入应用 post-gate 统一 fatal sink。

MonitorContext 创建时只获得已经存在的共享行情运行时端口。

### 17.2 Startup / rebuild

```text
配置 Schema 校验
-> 加载交易日、账户、持仓与全量订单
-> 恢复席位、订单归属和在途订单事实
-> 对选择 orderBook 的 monitor 执行 staticInfo board 准入
-> 从 monitor、恢复席位、持仓、在途订单统一编译完整 requirements
-> marketDataSubscriptionRuntime reset 旧 generation 行情事实
-> marketDataSubscriptionRuntime 建立所需 Quote / Candlestick / Depth / Brokers requirement
-> subscriptions()确认 committed truth
-> 读取 Quote / Candlestick / Depth / Brokers seed
-> 创建或同步 MonitorContext
-> 完成订单、风险与浮亏缓存重建
-> 启动 BusinessEventProgram
-> 恢复交易门禁
```

`loadTradingDayRuntimeSnapshot`不得直接调用 MarketDataClient 的 subscribe、unsubscribe 或 reset。

生命周期职责固定为：

- `signalRuntimeDomain`：停止 BusinessEventProgram，并调用`signalVerificationRuntime.stopAndDrain()`；返回后禁止再投递 VERIFIED 任务。
- `marketDataDomain`：调用`marketDataSubscriptionRuntime.stopAndDrain()`；该调用先使 generation 失效，再 drain mutation/callback，最后按服务端事实清理缓存。
- `loadTradingDayRuntimeSnapshot`：在业务权威快照完成后生成目标 requirements，并调用`resetAndReconcile()`和`seedCurrentRealtimeState()`。
- `marketDataSubscriptionRuntime`：唯一执行 SDK Quote / Candlestick / Depth / Brokers mutation 和服务端事实收敛。

盘前、竞价、午休或收盘后 realtime seed 稀疏，不作为 startup 失败。

连续交易信号注册时再执行订单簿窗口数据完整性检查。

### 17.3 午夜与 shutdown

固定顺序：

```text
停止新信号注册
-> 停止业务事件 owner
-> signalVerificationRuntime 取消 pending 并 drain 已 claim 的 timer / evaluation / delivery
-> marketDataSubscriptionRuntime 使 generation 失效
-> drain 行情 mutation 与 callback
-> 退订 Quote / Candlestick / Depth / Brokers requirement
-> subscriptions()确认最终服务端事实
-> 仅在确认不再 committed 后清空对应本地缓存
-> 清理其余行情与业务缓存
```

旧 generation 回调必须在写缓存前被拒绝。

若退订或最终事实确认失败，继续执行不依赖该事实的本地清理，但`marketDataSubscriptionRuntime`保持`failed + lastKnownFacts`并向上抛错；不得宣告 committed truth 为空。

### 17.4 连续交易边界

离开连续交易时段时：

- 取消尚未完成的 orderBook verification。
- 午休不保留跨午休窗口。
- 全日收盘和半日市收盘均取消。
- 末日接管开始时取消普通 pending verification。

## 18. 异步错误所有权

所有 verifier 使用注入的 bounded one-shot scheduler 和统一 fatal sink。

`signalVerificationRuntime`必须提供：

```text
startAccepting()
stopAndDrain()
cancelForMonitor()
cancelForDirection()
getPendingCount()
```

`stopAndDrain()`契约：

1. 原子关闭新请求注册。
2. 取消尚未 claim 的 timer。
3. 等待已 claim 的 timer、正在执行的验证和正在投递的 verified handler 全部结束。
4. 每次投递前重新检查 runtime accepting token、生命周期门禁、generation、席位版本和标的一致性。
5. 方法返回后，不允许任何旧请求再写入 VERIFIED 队列或 fatal 之外的业务通道。

处理规则：

- 业务条件不通过返回 `rejected`。
- 数据不足返回 `data-incomplete`。
- 生命周期取消返回 `cancelled`。
- 非法 payload、指标计算不变量、缓存契约和 verified handler 异常进入 fatal sink，且不再返回普通 VerificationResult。

禁止从 timer callback 裸抛异常形成无人接管的 Promise 或进程级异常。

## 19. 旧语义清理

必须删除或更新：

```text
DelayedSignalVerifierPort
MonitorContext.delayedSignalVerifier
RegisterDelayedSignalHandlersParams
registerDelayedSignalHandlers
cancelAllDelayedSignals
removedDelayed
pendingDelayedSignals
immediateSignals
delayedSignals
SignalTypeCategory
SignalWithCategory
needsDelayedVerification
calculateVerificationTime
旧 BUY/SELL verification 配置键
verificationIndicatorsBySide
SingleVerificationConfig
旧形状 VerificationConfig
MonitorConfig.verificationConfig 的 buy / sell 结构
TradingSignalStrategyConfig.verificationConfig
signalTypeMap
Signal.indicators1
pushSignalToCorrectArray
```

`pendingDelayedSignals` 当前没有生产读写消费，直接删除，不改名保留。

指标画像改为：

```text
trendVerificationIndicatorsByAction
```

只为 mode 为 `trend` 的动作编译技术指标。

orderBook 动作不得增加技术指标计算和 indicator cache 保留窗口。`createPostGateRuntime`（或重构后承担同一职责的唯一 startup owner）只能按全部 `mode=trend` 动作的最大 delay 计算 `indicatorCache.retentionWindowMs`；orderBook 的 window、confirmation 和缓存参数不得扩大该 retention。

残留范围：

- `src/`
- `tests/`
- `.env.example`
- `README.md`
- `.codex/skills/core-program-business-logic/SKILL.md`
- 当前活动方案和业务规范

历史归档文档可以保留历史术语，但必须明确标注已废弃，不能作为当前实现入口。

## 20. 实施阶段

以下阶段是同一原子重构中的依赖顺序，不是可部署的兼容阶段。不得为了让中间阶段单独运行而保留旧配置解析、双订阅 owner、旧 verifier 委托链或其他临时兼容逻辑；最终集成完成后统一执行全量验证。

### 阶段 A：配置与 Strategy 契约

1. 定义动作级模式键。
2. 定义订单簿 JSON Schema。
3. 删除旧 BUY/SELL 配置解析。
4. Strategy 改为只输出候选信号。
5. Pipeline 成为唯一验证模式 owner。

### 阶段 B：统一验证运行时

1. `delayedSignalVerifier`重命名为`trendSignalVerifier`。
2. 新增`signalVerificationRuntime`门面。
3. 接入统一 scheduler 和 fatal sink。
4. 更新取消、pending、claim / evaluation / delivery drain 和回流语义。

### 阶段 C：行情订阅与生命周期 owner 原子切换

1. 扩展 QuoteContextLike，并拆出只注入协调器的`QuoteContextMutationPort`。
2. 将现有 quote owner 重构为 requirement-aware owner。
3. 统一 Quote / Candlestick / Depth / Brokers mutation chain。
4. 实现事务前 baseline、服务端事实确认和部分成功回滚。
5. 同一阶段迁移 startup、rebuild、CacheDomain 和 shutdown 的全部低层 mutation 调用。
6. 删除旧 loader / CacheDomain 的直接 subscribe、unsubscribe、reset 调用。
7. 删除独立 orderBook 订阅 owner 设计。

该阶段必须原子完成。阶段结束时全仓只能由`marketDataSubscriptionRuntime`持有低层 mutation capability，不允许保留临时双 owner 或兼容委托链。

### 阶段 D：订单簿缓存

1. 注册 Depth / Brokers callback fan-out。
2. 实现 generation、monotonic time 和 arrival ordinal。
3. 实现 validated / sparse observation；非法 payload 直接进入 fatal sink。
4. 实现两条流独立窗口。
5. 实现容量上限和 overflow marker。

### 阶段 E：指标与验证

1. 新增`orderBookSignalVerifier`。
2. 实现十档等权聚合指标。
3. 实现全部保留指标。
4. 实现核心硬门禁。
5. 实现 confirmations 判别联合。
6. 实现 BUYCALL / BUYPUT 镜像纯函数。
7. 实现判别结果。

### 阶段 F：验证边界与生命周期场景收口

1. 接入午休、收盘、半日市和末日接管取消。
2. 完成 verification claim / evaluation / delivery drain。
3. 完成旧 generation 晚到 callback 拒绝。
4. 保留开盘保护与末日接管的不对称语义：开盘保护只阻断新普通信号与新注册，不阻断已等待验证的回流；末日接管继续取消等待中的普通验证并阻断回流。
5. 验证 startup、午夜、open rebuild 和 shutdown 的完整顺序。

### 阶段 G：全量清理

1. 删除旧 delayed 分类链。
2. 删除无生产消费状态。
3. 更新 wiring、lifecycle、integration 测试替身和完整对象字面量，删除对 `delayedSignalVerifier`、`registerDelayedSignalHandlers`、`immediateSignals / delayedSignals`、`pendingDelayedSignals` 等旧形状的活动依赖。
4. 更新 `.env.example`、README 和活动文档，并提供至少一组股票 `ORDER_BOOK` 正向示例与一组非 `ORDER_BOOK` 正向示例。
5. 对 `src/`、`tests/`、`.env.example`、`README.md`、活动文档和业务规范执行残留搜索 gate。

## 21. 测试计划

### 21.1 配置

- 四动作模式独立解析。
- 卖出配置 orderBook 失败。
- 旧 BUY/SELL 键不再读取。
- `NONE`存在残留 trend 键失败。
- `TREND`缺少正数 delay 或非空 indicators 失败。
- `ORDER_BOOK`缺少 monitor 级 JSON 失败。
- 无动作使用 orderBook 但存在 JSON 失败。
- 缺失 JSON 字段 fail-fast。
- 非法阈值 fail-fast。
- confirmations kind 重复失败。
- branded validated config 只能由 Schema 产生。
- BUYCALL / BUYPUT 只能引用同一份 monitor 级 validated orderBook config。
- 股票 monitor 可选择 orderBook；指数 monitor 选择 orderBook 时 fail-fast，且不改用 tradingSymbol 盘口。
- `.env.example` 衍生的正向样例可以直接通过 parse：至少包含一个 `HKEquity + ORDER_BOOK` monitor 和一个合法的非 `ORDER_BOOK` monitor。

### 21.2 Strategy 与 Pipeline

- Strategy 只返回候选信号。
- Strategy 不读取 verification config。
- 四动作 × 合法模式完整分流。
- 每个候选信号只进入一个 owner。
- orderBook 不产生趋势指标初值。
- trend 初始指标由 Pipeline 当前 IndicatorSnapshot 提取。
- trendBase、T0、T0+5s、T0+10s 与重构前一致。
- ADX 特殊规则与重构前一致。
- orderBook 的 observed epoch / monotonic 与 detected epoch / monotonic 来源固定；验证窗口锚定 observed monotonic，single-flight 等待时间只能体现在延迟审计中，不得改变验证窗口。
- monitorReferencePrice 精确等于本次 IndicatorSnapshot.price。
- Signal.triggerTime 等于候选 detected 时间，不等于 trend 或 orderBook 的未来 ready 时间。
- 仅 `mode=trend` 的动作进入 `trendVerificationIndicatorsByAction` 与趋势初值提取；`ORDER_BOOK` 动作不编译验证技术指标。

### 21.3 SDK contract

- QuoteContextLike 覆盖 Quote / Candlestick / Depth / Brokers / subscriptions / realtime。
- mutation capability 只存在于订阅协调器依赖类型。
- MarketDataClient 返回 requirement 事实。
- Depth-only 成功、Brokers-only 成功及反向场景。
- Candlestick 订阅、seed、reset 和 rebuild 恢复。
- `quoteLevel/packageDetails`文本变化不影响准入。
- `301603 No quotes`生成 seed-unavailable。
- `301604 No access`生成能力准入失败。
- 零次请求内重试的暂态错误仍包装为 ExternalApiRequestError attempts=1。
- loader、CacheDomain 和业务模块依赖类型中不存在低层 mutation。
- 事务前已有 Depth、本次新增 Brokers 失败时，只回滚 Brokers，不误退订原有 Depth。

### 21.4 Depth

- 完整十档生成 validated snapshot。
- 少于十档记录 sparse market state，不记录权限错误。
- 重复 position、null / 非有限 / 非法价格直接进入 fatal，不返回普通 VerificationResult。
- orderNum / volume 仅接受有限、非负、安全整数。
- 聚合值与名义金额非有限时进入 fatal。
- 旧 generation 回调拒绝。

### 21.5 Broker Queue

- 空数组是合法市场状态。
- 单侧较短合法。
- position 不连续合法。
- position 存在但 brokerIds 为空合法。
- position 重复非法。
- broker ID 重复时去重。
- broker ID 非法直接进入 fatal。

### 21.6 独立数据流

- 一个 Broker 样本后出现多个 Depth 更新。
- Depth 先到、Brokers 后到。
- Brokers 先到、Depth 后到。
- 仅一条流断流。
- reconnect 后仅一条流完成 seed。
- 不存在跨流配对调用。
- 未配置 brokerBreadth 时不订阅 Brokers。
- 未配置 brokerBreadth 时 Brokers 不可用不影响 rebuild。

### 21.7 Cache

- 基线边界。
- `orderBook-only` monitor 不得扩大 `indicatorCache.retentionWindowMs`。
- 混合 `trend + orderBook` 动作时，`indicatorCache.retentionWindowMs`只取全部 `trend` 动作的最大 delay。
- 完整 observation 后出现 sparse observation，后续信号不得穿透 sparse 回退到旧完整基线。
- shock / recovery 边界。
- timer 晚到仍只读取原窗口。
- sparse state 覆盖窗口时 data-incomplete。
- 非法 payload 只触发一次 fatal，不产生 data-incomplete。
- 容量溢出标记 data-incomplete。
- generation reset。
- symbol 清理。

### 21.8 指标性质

- imbalance 始终位于 `[-1, 1]`。
- 买卖盘交换后符号反转。
- volume / order count 同比例缩放时 imbalance 不变。
- BUYCALL / BUYPUT 镜像。
- 分母为零时指标无定义。
- 奇偶样本数中位数。
- Decimal 转换后必须为有限值。
- Broker baseline 缺失时已配置 brokerBreadth confirmation 返回 data-incomplete。
- Broker baseline 已观测但低于最小 breadth 时 rejected。
- 偶数样本中位数取中间两值算术平均。
- depth shock 取最小值、recovery 取中位数。
- spread 取窗口最大值。
- depth notional 取窗口最小值。
- broker recovery breadth 取真实 Broker 样本中位数。
- BUYCALL / BUYPUT 的 adverse move、recovery 和 final reference BPS 公式边界。

### 21.9 业务验证

- 核心门禁全部通过。
- 每个核心门禁单独失败。
- 每个已配置 confirmation 单独失败。
- 未配置的 Depth 派生 confirmation 不影响决策；brokerBreadth 未配置时不伪造审计值。
- 已配置 confirmation 数据缺失时不得临时跳过。
- verified / rejected / data-incomplete / cancelled 分支完整。
- fatal error 不作为普通 VerificationResult 返回。
- monitorReferencePrice 必须来自 monitorSymbol，不得使用 tradingSymbol 价格。
- orderBook request 只能接受 BUYCALL / BUYPUT 和当前 generation。

### 21.10 生命周期

- 盘前启动。
- 开市竞价启动。
- 连续交易启动。
- 午休启动与午休取消。
- 午后恢复。
- 收市竞价。
- 全日收盘。
- 半日市收盘。
- 午夜 reset。
- open rebuild。
- 开盘保护期间，已等待验证通过的普通信号仍可按统一回流路径进入 VERIFIED 队列。
- 末日接管期间，等待中的普通验证被取消且不得回流 VERIFIED 队列。
- rebuild 失败保持交易关闭。
- 首次 requirements 包含 monitor、恢复席位、持仓和在途订单。
- 先生成业务权威事实，再执行一次性 resetAndReconcile。
- stop 与 subscribe in-flight。
- unsubscribe 后晚到回调。
- 连续两次 stop / rebuild 幂等。

### 21.11 多 monitor

- trend monitor 与 orderBook monitor 并存。
- 两个 orderBook monitor 使用不同 symbol。
- 多 monitor 共享 symbol 时 requirement retain 正确。
- 多 monitor 共享 symbol 且窗口配置不同，仍共用一套应用级缓存容量。
- 单信号数据不足不关闭其他 monitor。
- 系统级订阅事实失败阻断全局 rebuild。

### 21.12 Shutdown

- verifier timer 与 callback 竞态。
- timer 已 claim、验证计算中、verified delivery 中三个阶段分别执行 stopAndDrain。
- stopAndDrain 返回后旧请求不能再写 VERIFIED 队列。
- 单 subtype unsubscribe 失败仍继续其他清理。
- 重复 shutdown。
- 退订全部成功且服务端确认后，最终 pending、cache、retains、committed truth 全为空。
- 任一退订或事实确认失败时保持 failed + lastKnownFacts，不伪造空 committed truth。
- 无遗留 timer、bun、test 或 TypeScript 进程。

### 21.13 性能与容量

- 固定监控数和固定 push burst。
- 缓存条目始终有界。
- 应用级容量常量可覆盖允许的最大窗口和固定 push burst。
- overflow 正确拒绝受影响信号。
- stop 后资源归零。
- 预计算指标避免按 pending 数重复扫描原始十档。

## 22. 实证验证门槛

代码正确不等于策略有效。

生产启用 `orderBook` 前必须完成：

1. 目标标的连续交易时段 Depth / Brokers 事件录制。
2. 确定性 replay。
3. 各指标单独命中率和覆盖率。
4. 指标相关系数。
5. confirmations 消融。
6. 阈值训练集、验证集和样本外拆分。
7. Walk-forward。
8. 按早盘、午盘、波动率和流动性分层。
9. 信号拒绝率和最终成交质量评估。

验收结果必须区分：

- 数据可构造性。
- 工程正确性。
- 策略预测能力。

API / SDK 只能证明前两者的数据来源和实现边界，不能证明 alpha。

## 23. 验收标准

1. `bun format`通过。
2. `bun lint`通过。
3. `bun type-check`通过。
4. 全量测试通过。
5. Strategy 不再拥有验证模式判断。
6. Pipeline 是唯一模式分流 owner。
7. 所有 Quote / Candlestick / Depth / Brokers mutation 使用唯一串行协调器。
8. Depth / Brokers 不存在跨流伪配对。
9. 稀疏市场状态不被记录为权限故障。
10. 已配置 confirmation 缺失时不存在回退或跳过。
11. 非法 payload 只进入 fatal sink，不会被静默丢弃或同时包装为普通结果。
12. 卖出风险链路不受 orderBook verifier 阻塞。
13. lifecycle 和 shutdown 满足 verification delivery drain、generation 失效、callback drain 和服务端订阅事实确认顺序。
14. 旧 delayed 分类与旧配置键在活动代码和文档中零残留。
15. 无测试或验证遗留进程。

## 24. 残留搜索

实施完成后在活动代码、测试、配置示例和当前文档中确认不存在：

```text
activeBuyVolume
activeSellVolume
activeTotalVolume
dominanceRatio
CVD
TickCVD
MLOFI
Observed OFI
Observed Book Delta
aggressorSide
delayedSignalVerifier
DelayedSignalVerifier
registerDelayedSignalHandlers
cancelAllDelayedSignals
removedDelayed
pendingDelayedSignals
immediateSignals
delayedSignals
SignalTypeCategory
SignalWithCategory
needsDelayedVerification
calculateVerificationTime
signalTypeMap
pushSignalToCorrectArray
SingleVerificationConfig
verificationConfig.buy
verificationConfig.sell
TradingSignalStrategyConfig
indicators1
VERIFICATION_DELAY_SECONDS_BUY_
VERIFICATION_DELAY_SECONDS_SELL_
VERIFICATION_INDICATORS_BUY_
VERIFICATION_INDICATORS_SELL_
verificationIndicatorsBySide
ORDER_BOOK_LEVEL_WEIGHTS
maxSnapshotGapMs
orderBookSubscriptionRuntime
```

OFI 等术语可以在本方案“删除原因”和历史归档中保留，不得存在于生产实现、活动配置或当前指标类型。

## 25. 最终数据与策略结论

### 完整保留

```text
十档 price / volume / orderNum
Spread BPS
Mid-price
L1 Microprice
Microprice Premium BPS
Top-10 Displayed Volume Imbalance
Top-10 Order Count Imbalance
Top-10 Displayed Depth Notional
Top-10 单侧显示深度收缩与再扩张
Broker Queue 原始 position / brokerIds
Broker Breadth
Broker Breadth Retention
```

### 明确删除

```text
主动买卖量
CVD / Tick CVD
严格 OFI / MLOFI
Observed OFI / Book Delta
成交吸收
broker 级数量或意图
交易所事件级恢复速度
```

### 首版核心决策

```text
quoted spread 质量
十档显示数量失衡反转
单侧 Top-10 显示深度收缩与再扩张
mid-price 极值与回收
最终参考价容忍度
```

订单数失衡、Microprice、Depth Notional 和 Broker breadth 的完整算法与配置能力均保留，通过显式 `confirmations`参与策略；Broker breadth 未配置时不建立 Brokers 数据依赖，已配置指标不得因数据缺失自动降级。

该方案使用的是可由 Longbridge 公开 API / SDK 完整构造的市场微观结构状态指标。它不把成交涨跌方向包装成主动订单流，不把 Broker Queue position 当作价格档，不把独立推送流伪装成同步事件，也不把合法稀疏盘口误报为权限缺失。

## 26. 数据依据

- Longbridge OpenAPI Depth Pull：

  <https://open.longbridge.com/docs/quote/pull/depth>

- Longbridge OpenAPI Depth Push：

  <https://open.longbridge.com/docs/quote/push/depth>

- Longbridge OpenAPI Broker Queue Pull：

  <https://open.longbridge.com/docs/quote/pull/brokers>

- Longbridge OpenAPI Brokers Push：

  <https://open.longbridge.com/docs/quote/push/broker>

- Longbridge Node SDK QuoteContext：

  <https://longbridge.github.io/openapi/nodejs/classes/QuoteContext.html>

- 本地 SDK 类型：

  `node_modules/longbridge/index.d.ts`

- 当前项目关键链路：
  - `src/core/strategy/`
  - `src/main/businessEventProgram/`
  - `src/main/asyncProgram/delayedSignalVerifier/`
  - `src/main/quoteSubscriptionRuntime/`
  - `src/main/lifecycle/`
  - `src/services/quoteClient/`
  - `src/types/config.ts`
  - `src/types/services.ts`
  - `src/types/monitorContextPorts.ts`
