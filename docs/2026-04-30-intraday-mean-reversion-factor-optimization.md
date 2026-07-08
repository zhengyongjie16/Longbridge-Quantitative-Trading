# 日内均值回归高敏因子优化复核结论

日期：2026-04-30

## 1. 核心修正

本文替换上一版“分层确认”表述。上一版容易被理解为：

```text
出现极端价格
-> 再花时间判断趋势还是回归
-> 再等待确认
-> 再入场
```

这不适合日内均值回归。高敏均值回归的正确设计应是：

```text
每次行情事件持续预计算状态缓存
-> 拐点触发时一次读取当前状态快照
-> 允许则立即入场，禁止则立即丢弃
```

因此，结论不是“增加更多慢确认”，而是：

1. 状态因子必须提前算好，不能在触发后临时等待。
2. 触发因子必须保持敏感，负责捕捉拐点。
3. 入场决策必须是一次低延迟门禁判断。
4. 慢因子只做准入/禁入，不做等待式确认。
5. 现有 60 秒延迟验证若用于买入入场，会破坏高敏均值回归的机会捕捉。

新的策略形态应是：

```text
实时状态缓存 + 高敏触发 + 即时门禁 + 快速退出
```

不是：

```text
多因子串行确认 + 等待趋势明朗 + 滞后入场
```

## 2. 当前数据边界

当前暂时拿不到：

- HSI 期货或其他稳定期货同步数据。
- 期现联动、基差、lead-lag 数据。
- 盘口 bid/ask 深度。
- 逐笔成交。
- 主动买卖方向。
- 订单流失衡。

所以当前文档不再把以下因子列入可落地方案：

- 期货领先 / 期现联动 / 基差。
- 订单流失衡 / 盘口冲击 / 流动性恢复。

当前系统可用的是 1 分钟 K 线和实时 K 线推送形成的 OHLCV：

- `open`
- `high`
- `low`
- `close`
- `volume`
- `timestamp`

因此，当前可以做的是“1 分钟 K 线/active bar 级别的高敏均值回归”，不是 tick 级盘口高频策略。没有盘口和逐笔数据时，拐点只能从 K 线内部回收、短窗价格变化、VWAP 偏离、OR 假突破和成交量耗竭中捕捉。

## 3. 专业名词解释

### OHLCV

OHLCV 是一根 K 线的五个字段：

- `O / open`：这一分钟的起始价格。
- `H / high`：这一分钟最高价。
- `L / low`：这一分钟最低价。
- `C / close`：这一分钟最后价格。
- `V / volume`：这一分钟成交量。

本文所有可落地因子都只依赖 OHLCV 和交易时段时间，不依赖盘口或期货。

### Session

`Session` 是连续交易时段。港股至少要区分早盘和午后。

很多日内因子必须 session-aware：

- 早盘开盘区间和午后开盘区间不能混用。
- VWAP 是否从全天开盘算，还是从午后重新锚定，需要明确。
- 波动率分位数最好比较同一时段，而不是拿早盘和午后直接比较。

### VWAP

`VWAP` 是 Volume Weighted Average Price，成交量加权平均价。

直观含义：

```text
今天到目前为止，市场按成交量加权后的平均成交成本。
```

计算：

```text
TypicalPrice = (high + low + close) / 3
VWAP = sum(TypicalPrice * volume) / sum(volume)
```

对均值回归的意义：

- 它定义“均值锚”。
- 它给出回归目标。
- 它帮助识别价格是否正在 VWAP 单侧趋势推进。

注意：`price < VWAP` 不等于可以买。它只说明价格低于成交重心，还必须看波动、ER、OR 和触发回收。

### Anchored VWAP

`Anchored VWAP` 是从某个关键时刻重新开始计算的 VWAP。

普通 VWAP 从开盘累计。Anchored VWAP 可以从以下位置开始：

- 开盘区间结束。
- 假突破发生点。
- 当日高点或低点形成后。
- 午后开盘。
- 重大结构切换点。

直观含义：

```text
某个关键事件发生之后，新参与者的平均成交成本在哪里。
```

它比全天 VWAP 更贴近局部结构，但实现上比普通 VWAP 稍复杂。当前建议先做 session VWAP，再预留 Anchored VWAP。

### Deviation / VWAP_Z / z-score

`Deviation` 是价格相对 VWAP 的偏离：

```text
Deviation = close - VWAP
```

`VWAP_Z` 是标准化后的 VWAP 偏离：

```text
VWAP_Z = Deviation / rollingStd(Deviation)
```

直观理解：

- `VWAP_Z = -0.3`：只是略低于 VWAP。
- `VWAP_Z = -1.5`：明显低于成交重心，开始有回归观察价值。
- `VWAP_Z = -2.5`：极端偏离，但可能是趋势暴跌，必须先过状态门禁。

为什么需要 z-score：HSI 和 9988 价格尺度不同，早盘和午后波动不同，只看点数不能比较偏离是否真的极端。

### RV

`RV` 是 Realized Volatility，已实现波动率。

计算：

```text
r_t = ln(close_t / close_t-1)
RV_n = sqrt(sum(r_t^2, n))
```

直观含义：

```text
最近 n 分钟价格实际震动有多大。
```

对均值回归的意义：

- RV 扩张时，偏离可能是趋势或信息驱动。
- RV 平稳或收缩时，偏离更可能是短期噪声或流动性冲击。

### ATR

`ATR` 是 Average True Range，平均真实波幅。

先算 TR：

```text
TR = max(high - low, abs(high - prevClose), abs(low - prevClose))
```

再算 ATR：

```text
ATR_n = average(TR, n)
```

ATR 更像“每根 K 线平均能走多远”。它适合给 OR 突破、止损距离和偏离阈值做归一化。

### VolExpansion

`VolExpansion` 是短期波动相对长期波动的扩张比：

```text
VolExpansion = ATR_short / ATR_long
```

含义：

- `< 1`：短期波动低于长期，偏收缩。
- `1.0-1.2`：中性或轻微扩张。
- `> 1.2`：短期波动明显扩张，趋势和冲击风险上升。

在高敏策略中，它不是让系统等待，而是在触发发生时立刻判断是否禁止交易。

### ER / Efficiency Ratio

`ER` 是 Efficiency Ratio，效率比。

计算：

```text
ER_n = abs(close_t - close_t-n) / sum(abs(close_i - close_i-1), i=t-n+1..t)
```

含义：

- 接近 1：价格基本单向推进，趋势强。
- 接近 0：价格来回震荡，净位移小。

对均值回归的意义：

- 低 ER 更适合做回归。
- 高 ER 时，即使 VWAP_Z 极端，也可能是趋势行情，应该禁做或降权。

### Slope

`Slope` 是短窗价格斜率。

简化计算：

```text
Slope_n = (close_t - close_t-n) / n
```

也可以用最近 N 根 close 做线性回归取斜率。

对高敏回归的意义：

- 价格远低于 VWAP 且向下斜率继续扩大：不要接多。
- 价格远低于 VWAP 但斜率开始变平或反向：拐点质量更高。

### ReturnZ

`ReturnZ` 是标准化短窗收益：

```text
ReturnZ_n = log(close_t / close_t-n) / RV_n
```

它回答的是：

```text
最近 n 分钟价格冲得是否过急。
```

与 `VWAP_Z` 区别：

- `VWAP_Z` 看离成交重心多远。
- `ReturnZ` 看最近冲击速度是否异常。

### OR / Opening Range

`OR` 是 Opening Range，开盘区间。

计算：

```text
OR_high = 开盘后 N 分钟最高价
OR_low = 开盘后 N 分钟最低价
OR_mid = (OR_high + OR_low) / 2
OR_width = OR_high - OR_low
```

含义：

```text
开盘后最初一段时间形成的第一段平衡区间。
```

对均值回归的意义：

- 真突破 OR 后，市场可能进入趋势，不宜逆势。
- 假突破 OR 后回到区间内，常常是回归触发。
- OR_mid 可以作为回归目标。

本文中的 `OR_high / OR_low / OR_mid` 都指 Opening Range，不表示“或者”。

### FalseBreak

`FalseBreak` 是假突破。

定义：

```text
价格突破关键边界
但没有持续留在边界外
很快回到原区间
```

常见形态：

- 上破 `OR_high` 后回到 OR 内。
- 下破 `OR_low` 后回到 OR 内。
- 刺破 VWAP 偏离带后快速回收。

对均值回归的意义：

```text
追突破的一方没有持续力量，价格更可能回到 VWAP 或 OR_mid。
```

### RangePosition

`RangePosition` 是价格在区间里的相对位置：

```text
RangePosition = (close - OR_low) / (OR_high - OR_low)
```

含义：

- 接近 0：靠近区间下沿。
- 接近 0.5：靠近区间中轴。
- 接近 1：靠近区间上沿。

它帮助判断回归空间是否还存在。

### VolumeRatio / Volume Exhaustion

`VolumeRatio` 是当前成交量相对近期成交量的比例：

```text
VolumeRatio = volume / rollingMedian(volume, n)
```

`Volume Exhaustion` 是成交量耗竭。

含义：

```text
价格曾被较大成交量推开，但后续没有继续推进。
```

注意：这不是订单流。它不知道主动买卖方向，只是 bar-level 成交量现象。

### RSI / MFI / KDJ / PSY

这些是当前系统已有的摆动或情绪类指标：

- `RSI`：衡量近期上涨和下跌力度的相对关系。
- `MFI`：结合价格和成交量判断超买超卖。
- `KDJ`：根据近期高低点区间判断价格位置；`J` 最敏感。
- `PSY`：统计最近 N 根上涨 bar 的比例。

它们适合做高敏触发，不适合作主因子。原因是它们能说明“短期过热/过冷”，但不能定义均值、不能判断趋势日、不能给出回归目标。

### EMA / MACD / ADX

- `EMA`：指数移动平均线。
- `MACD`：快慢 EMA 差值构成的动量指标。
- `ADX`：趋势强度指标，只衡量强弱，不直接给方向。

在高敏均值回归中，它们只适合做趋势禁入、动量衰减辅助和退出辅助，不能作为慢确认等待条件。

## 4. 当前系统问题复核

当前策略说明和实际配置表明，系统主要依赖 RSI、MFI、KDJ、PSY 的短周期极值生成候选信号。例如：

```text
SIGNAL_BUYCALL_1=(RSI:6<25,MFI<15,D<25,J<0.5)/3|(J<-25)
SIGNAL_BUYCALL_2=(RSI:6<25,MFI<20,D<25,J<0.5)/3
```

延迟验证侧还配置了：

```text
VERIFICATION_DELAY_SECONDS_BUY_1=60
VERIFICATION_INDICATORS_BUY_1=D,ADX
```

这带来两个相反方向的问题：

1. 如果直接用 RSI/MFI/KDJ 极值入场，敏感但容易在趋势日接刀。
2. 如果使用 60 秒延迟验证后再入场，容易错过均值回归拐点，滑点和机会损耗会显著增加。

因此，正确修正不是简单“加过滤器”或“加确认时间”，而是把过滤器变成实时状态缓存，把 RSI/MFI/KDJ 保留为快速触发。

## 5. 高敏均值回归的正确架构

### 5.1 不应采用的慢确认链路

不应这样实现：

```text
RSI/MFI/KDJ 极值
-> 开始计算 VWAP_Z / ER / VolExpansion
-> 等 OR 或趋势确认
-> 等延迟验证
-> 下单
```

问题：

- 触发后再计算和等待，会错过最有利价格。
- 多数均值回归机会持续时间短。
- 延迟验证会把“拐点捕捉”变成“回归发生后追入”。
- 高频震荡中，确认完成时价格可能已经回到 VWAP，收益空间消失。

### 5.2 应采用的高敏链路

应这样实现：

```text
行情事件到达
-> O(1) 更新状态缓存
-> O(1) 更新高敏触发状态
-> 若触发，读取同一份状态快照
-> 一次门禁判断
-> 立即入队买/卖
```

状态缓存持续维护：

- `VWAP`
- `VWAP_Z`
- `ATR_short / ATR_long`
- `VolExpansion`
- `RV_15`
- `ER_15`
- `Slope_5`
- `OR_high / OR_low / OR_mid`
- `RangePosition`
- `VolumeRatio`

触发状态持续维护：

- `J` 极端后回收。
- `RSI` 从极值区回头。
- active bar 下影线/上影线回收。
- OR 假突破回区间。
- 短窗收益冲击后回收。
- 成交量放大后无继续推进。

决策只发生一次：

```text
triggered && gateSnapshot.allowsMeanReversion
```

## 6. 因子职责重新分层

## 6.1 状态缓存因子：提前维护，不等待

这些因子不负责触发交易，只负责在触发瞬间回答“能不能做”。

### VWAP_Z

职责：

```text
判断价格是否相对成交重心出现足够偏离。
```

高敏用法：

- 每次 K 线更新或 active bar 更新时递推。
- 触发发生时直接读取。
- 不等待 VWAP_Z 继续扩大或回落。

示例门禁：

```text
做多要求 VWAP_Z <= -1.2 或 -1.5
做空要求 VWAP_Z >= 1.2 或 1.5
```

阈值需要回测，不应固定拍脑袋。

### VolExpansion / RV

职责：

```text
判断当前偏离是否可能来自趋势冲击。
```

高敏用法：

- 只做禁入或降权。
- 不做等待式确认。

示例：

```text
VolExpansion > 1.2 且 ER 高：禁止回归入场
VolExpansion 轻微扩张但 ER 低：允许小仓位或正常仓位，待回测确认
```

### ER / Slope

职责：

```text
判断价格是单向有效推进，还是震荡噪声。
```

高敏用法：

- 高 ER 禁止逆势。
- Slope 不要求等待反转完成，只要求“没有继续加速恶化”。

示例：

```text
做多回归：
VWAP_Z 很低
但 ER_15 > 0.45 且 Slope_5 继续向下扩大
=> 禁做
```

### OR / FalseBreak / RangePosition

职责：

```text
识别当前结构是趋势突破，还是假突破回归。
```

高敏用法：

- OR 状态在开盘后持续维护。
- 假突破回到 OR 内时就是快触发，不再等额外长确认。

示例：

```text
下破 OR_low 后快速回到 OR 内
AND VWAP_Z 偏低
AND ER 未趋势化
=> 做多回归触发质量提高
```

## 6.2 高敏触发因子：捕捉拐点

这些因子负责“何时动手”。它们必须敏感，不能被慢确认拖住。

### J 极端回收

J 是 KDJ 中最敏感的分量，适合捕捉短促极值。

旧用法：

```text
J < -25 直接触发买入
```

新用法：

```text
VWAP_Z 已极端
AND gate 允许回归
AND J 从极端负值回收
=> 做多触发
```

重点不是 `J` 极端本身，而是极端后的回收。

### RSI 极值回头

旧用法：

```text
RSI:6 < 25 直接触发买入
```

新用法：

```text
RSI:6 曾低于 25
AND 当前 RSI:6 开始回升
AND 价格仍有 VWAP 回归空间
=> 做多触发
```

这样能保留敏感性，同时避免“越跌越买”的纯极值问题。

### active bar 影线回收

如果 Longbridge realtime candlestick 会推送活动 1 分钟 K 线，则可以利用 active bar 内部形态：

做多回归：

```text
low 明显刺穿下沿
AND close 从 low 拉回
AND 下影线占比高
```

做空回归：

```text
high 明显刺穿上沿
AND close 从 high 回落
AND 上影线占比高
```

这比等完整收线更敏感，但也更容易噪声化，需要状态门禁配合。

### OR 假突破回区间

做多：

```text
价格下破 OR_low
随后回到 OR_low 上方
```

做空：

```text
价格上破 OR_high
随后回到 OR_high 下方
```

这类触发应当快，因为假突破回收本身就是结构信号。

### 成交量耗竭

成交量耗竭只作为触发质量增强，不单独触发。

做多回归例子：

```text
价格急跌
VolumeRatio 高
但后续无法继续创新低
active bar 拉回
```

当前只有 bar volume，不能伪造成订单流。

## 6.3 执行和退出因子：不要等太久

高敏均值回归的退出也要快。

建议优先级：

1. 回到 VWAP 附近，先止盈或减仓。
2. 回到 OR_mid，按结构止盈。
3. 入场后 3 到 8 分钟没有回归动作，退出。
4. 入场后 ER/VolExpansion 快速趋势化，退出。
5. 重新突破触发极值并持续，退出。

`5 到 10 分钟无回归动作退出` 对部分标的可能偏慢，需要回测。高敏版本可以先测试：

- 3 分钟。
- 5 分钟。
- 8 分钟。

## 7. 当前最应修正的点：延迟验证

当前配置中买入延迟验证为 60 秒：

```text
VERIFICATION_DELAY_SECONDS_BUY_1=60
```

如果目标是高敏日内均值回归，这个配置和入场目标冲突。

原因：

```text
均值回归拐点的收益空间通常出现在最初几根 bar。
等待 60 秒可能已经回到 VWAP，或者价格已经反向扩散。
```

因此后续若实施高敏版本，应考虑：

1. 买入入场不走 60 秒延迟验证。
2. 延迟验证可以保留给较慢的趋势/确认策略。
3. 对高敏回归，延迟逻辑更适合变成 post-entry 风险观察，而不是 pre-entry admission。
4. 若仍要保留延迟，延迟应缩短到几秒级或 1 根 active bar 内，但这取决于实际推送频率和成交滑点。

这不是说“完全不要验证”，而是验证方式必须改成：

```text
入场前：读实时状态快照，一次门禁
入场后：快速风控和失败退出
```

而不是：

```text
入场前等待 60 秒
```

## 8. 新策略决策模型

### 8.1 做多高敏回归

预计算状态：

```text
VWAP_Z
VolExpansion
ER_15
Slope_5
OR_state
RangePosition
VolumeRatio
```

触发条件之一：

```text
J 从极端负值回收
或 RSI:6 从低位回升
或 active bar 下影线回收
或下破 OR_low 后回到 OR 内
```

一次门禁：

```text
VWAP_Z <= negativeThreshold
AND ER_15 未趋势化
AND VolExpansion 未强扩张
AND Slope_5 未继续向下加速
AND 当前仍有到 VWAP 或 OR_mid 的回归空间
```

执行：

```text
立即生成买入候选
不等待 60 秒延迟验证
```

退出：

```text
到 VWAP 附近止盈或减仓
或 3-8 分钟无回归退出
或状态快速趋势化退出
```

### 8.2 做空高敏回归

触发条件之一：

```text
J 从极端正值回落
或 RSI:6 从高位回落
或 active bar 上影线回落
或上破 OR_high 后回到 OR 内
```

一次门禁：

```text
VWAP_Z >= positiveThreshold
AND ER_15 未趋势化
AND VolExpansion 未强扩张
AND Slope_5 未继续向上加速
AND 当前仍有到 VWAP 或 OR_mid 的回归空间
```

执行和退出同理。

## 9. 因子优先级更新

| 优先级 | 因子 | 数据需求 | 职责 | 是否等待 |
| --- | --- | --- | --- | --- |
| P0 | VWAP / VWAP_Z | 1m OHLCV | 均值锚、偏离空间 | 不等待，实时缓存 |
| P0 | ER / Slope | 1m close | 趋势禁入、加速过滤 | 不等待，实时缓存 |
| P0 | VolExpansion / RV | 1m OHLC | 波动扩张禁入 | 不等待，实时缓存 |
| P1 | OR / FalseBreak | 1m OHLC + session | 结构触发和趋势禁入 | OR 先缓存，FalseBreak 快触发 |
| P1 | J / RSI 回收 | 现有指标 | 高敏拐点触发 | 触发即判断 |
| P1 | active bar 影线回收 | realtime candlestick | 高敏形态触发 | 触发即判断 |
| P2 | MFI / VolumeRatio | 1m OHLCV | 成交量耗竭辅助 | 不单独等待 |
| P2 | EMA / MACD / ADX | 现有指标 | 动量/趋势辅助禁入 | 不做慢确认 |

明确不纳入当前阶段：

| 因子                           | 原因                                       |
| ------------------------------ | ------------------------------------------ |
| 期货领先 / 期现联动 / 基差     | 没有 HSI 期货或稳定代理期货数据            |
| 订单流 / 盘口冲击 / 流动性恢复 | 没有盘口、逐笔、主动买卖方向和深度变化数据 |

## 10. 对当前代码架构的落地要求

当前 `businessEventProgram` 已经是 K 线业务事件 owner，可以承载这个方向。但实现时必须遵守以下要求：

1. 指标状态必须在行情事件路径中增量维护，不能信号触发后临时全量扫描。
2. 状态缓存读取必须是同步快照读取，不引入远程 API 调用。
3. `runSignalPipeline` 前应已经有完整的 mean-reversion context snapshot。
4. 买入高敏回归不应走 60 秒 pre-entry delayed verification。
5. 触发和门禁应在同一事件快照上完成，避免读取不一致状态。
6. display 不参与交易判断。
7. 回测必须单独比较“立即入场”和“延迟验证入场”的滑点与收益差异。

建议新增的上下文快照概念：

```text
MeanReversionContextSnapshot:
  anchor:
    vwap
    vwapZ
  regime:
    er
    slope
    rv
    volExpansion
  structure:
    orHigh
    orLow
    orMid
    rangePosition
    falseBreakState
  trigger:
    oscillatorReclaim
    wickReclaim
    volumeExhaustion
```

它应是信号生成时的一份只读快照，而不是多个模块临时分别计算。

## 11. 回测和验证重点

高敏均值回归不能只看胜率，必须看时间和滑点。

最小消融实验：

1. 当前 RSI/MFI/KDJ 旧策略。
2. 旧策略 + 取消 60 秒买入延迟。
3. VWAP_Z + J/RSI 回收。
4. VWAP_Z + J/RSI 回收 + ER 禁入。
5. VWAP_Z + J/RSI 回收 + ER + VolExpansion 禁入。
6. VWAP_Z + J/RSI 回收 + ER + VolExpansion + OR FalseBreak。
7. 加入 active bar 影线回收。
8. 加入成交量耗竭辅助。

必须统计：

- 触发后 1 分钟 MFE/MAE。
- 触发后 3 分钟 MFE/MAE。
- 触发后 5 分钟 MFE/MAE。
- 信号触发价到实际成交价滑点。
- 延迟验证前后价格差。
- 回到 VWAP 的概率。
- 未回归并继续趋势化的比例。
- 分时段表现：早盘、午前、午后、尾盘。
- 分状态表现：低 ER / 高 ER、低 VolExpansion / 高 VolExpansion。

如果加入过滤器后胜率提升但入场价格显著变差，策略仍然可能无效。高敏策略的验证必须把“时间损耗”单独量化。

## 12. 研究证据边界

公开研究支持以下方向：

1. 日内动量在高波动和高成交环境下更强。这说明高敏回归必须有趋势禁入，否则容易在趋势冲击中逆势。
2. 中国市场和指数市场中既存在日内动量，也存在日内反转。能否盈利高度依赖状态区分、成本和执行。
3. OR/TORB 对指数日内结构有统计意义。对均值回归来说，OR 的价值主要是识别假突破和趋势禁入。
4. 高频微观结构研究强调 adverse selection 和流动性快速变化。没有盘口时，不能把 bar-level 成交量误当订单流。

这些研究不能直接证明某个参数在 HSI/9988 上盈利。它们只支持当前架构方向：

```text
不要慢确认
不要裸摆动指标
要实时状态门禁
要高敏触发
要成本和滑点验证
```

## 13. 最终结论

在当前数据条件下，正确的日内均值回归优化方向是：

```text
实时维护 VWAP_Z / ER / VolExpansion / OR 状态
+ 保留 RSI/KDJ/J/影线/假突破作为高敏触发
+ 触发时一次读取状态快照并立即决策
+ 不用 60 秒延迟验证阻塞买入入场
+ 用快速退出控制失败回归
```

RSI/MFI/KDJ/PSY 被“降级”不是降低重要性，而是重新放回正确职责：

- 它们不负责判断市场是否适合回归。
- 它们负责在已允许回归的状态下捕捉拐点。

VWAP_Z、ER、VolExpansion、OR 也不是慢确认器：

- 它们必须提前实时缓存。
- 它们只在触发瞬间做准入判断。

这才符合高敏日内均值回归的实际交易约束。
