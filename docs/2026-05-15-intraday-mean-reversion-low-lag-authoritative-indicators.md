# 日内高敏均值回归的低滞后权威指标设计结论

日期：2026-05-15

## 1. 问题定义

当前程序属于日内均值回归，或者更准确地说，是“极值回归”策略：当监控标的短时间进入超买或超卖状态时，尝试买入对应方向的牛熊证，等待价格向短期均值或成交重心回归。

这类策略最怕的不是普通高波动，而是“有方向的高效率波动”。例如今天 `HSI.HK` 的 1 分钟走势中：

- `09:30-10:49`：出现早盘持续下跌。
- `13:00-14:00`：午后再次出现更明显的持续下跌。

如果只用 RSI、MFI、KDJ、J 值等摆动指标的极值做多，会把“正在趋势下跌”误判成“已经超跌可回归”。这会导致逆势接入，买入后继续承受趋势延伸带来的亏损。

但解决方案也不能走另一个极端：不能用过慢的趋势确认指标作为买入前置门禁。高敏均值回归的机会通常发生在最初几根 1 分钟 K 线内；如果门禁需要等待 60 秒、等待多根 K 线收敛、或者等待平滑指标转向，入场价格可能已经回到均值附近，收益空间被滑点和时间损耗吃掉。

因此，本策略需要的是：

```text
权威指标
+ 低滞后计算
+ 事件驱动实时缓存
+ 触发瞬间一次性门禁
+ 快速失败退出
```

不是：

```text
极值触发后再等待趋势确认
```

也不是：

```text
自定义复杂打分替代可解释的金融指标
```

## 2. 权威性与低滞后筛选原则

本结论只把下列指标族列为核心候选：

1. 有经典技术分析来源、市场微观结构来源或金融计量文献支持。
2. 可以用当前程序已有的 1 分钟 OHLCV 实时计算。
3. 不依赖盘口、逐笔、期货联动或主动买卖方向。
4. 计算窗口短，能够在当前 K 线事件到达时立即更新。
5. 只做触发瞬间的同步判断，不做事后等待式确认。

被排除或降级的指标：

- `ADX`：权威，但平滑滞后明显，只适合辅助展示、退出或研究分析，不适合作为高敏买入前置核心门禁。
- `MACD / EMA 慢线交叉`：权威和常见，但对 1 分钟极值回归入场过慢。
- 长窗口均线、长窗口波动率分位：可用于研究分层，不适合作为实时入场硬门禁。
- 单独 `ATR` 或单独 `RV`：能描述波动大小，但不能区分“震荡波动”和“方向性趋势冲击”，不能单独决定禁入。

## 3. 推荐核心指标体系

### 3.1 Kaufman Efficiency Ratio：方向效率门禁

`Efficiency Ratio` 来自 Perry Kaufman 的自适应均线思想。它的核心问题是：

```text
最近 N 分钟的价格变化，有多少是净方向推进，有多少只是来回噪声？
```

计算：

```text
ER_n = abs(close_t - close_t-n) / sum(abs(close_i - close_i-1), i=t-n+1..t)
```

解释：

- `ER` 接近 1：价格路径接近单向推进，趋势风险高。
- `ER` 接近 0：价格来回震荡，净位移小，更接近均值回归适用环境。

为什么适合当前策略：

- 它直接衡量路径效率，不需要等待均线拐头。
- 它不关心涨跌方向，方向由短窗收益或斜率补充。
- 它能区分“低位震荡”与“低位继续单边下跌”。

建议用法：

```text
做多禁入：
ER_10 或 ER_15 偏高
AND 短窗收益为负
AND Slope_3 / Slope_5 仍为负
```

`ER` 不应该单独禁入。高 ER 只说明路径有效，必须与方向收益结合，否则上涨趋势中做空、下跌趋势中做多的语义会混乱。

窗口建议：

- `ER_10`：更敏感，适合 active 1m K 线推送稳定时。
- `ER_15`：更稳，适合减少噪声误杀。
- 不建议从 `ER_30` 起步；对高敏入场过慢。

### 3.2 Realized Volatility 与标准化短窗收益：冲击强度门禁

`Realized Volatility` 是金融计量中使用高频收益估计波动率的标准方法。Andersen、Bollerslev、Diebold、Labys 的 Realized Volatility 研究为“用高频日内收益构造波动率”提供了权威基础。

基础计算：

```text
r_i = ln(close_i / close_i-1)
RV_n = sqrt(sum(r_i^2, i=t-n+1..t))
```

单独 `RV` 的问题：

```text
RV 高只说明最近波动大，不说明价格是否单向下跌。
```

因此更适合高敏门禁的是标准化短窗收益：

```text
ReturnZ_n = ln(close_t / close_t-n) / RV_n
```

解释：

- `ReturnZ_n` 显著为负：最近下跌幅度相对于自身波动已经偏急。
- `ReturnZ_n` 显著为正：最近上涨幅度相对于自身波动已经偏急。
- 与 `ER` 联用时，可以识别“方向明确且速度较快”的趋势冲击。

建议用法：

```text
做多禁入：
ReturnZ_10 或 ReturnZ_15 显著为负
AND ER 同时偏高
AND Slope_3 / Slope_5 未止跌

做空禁入：
ReturnZ_10 或 ReturnZ_15 显著为正
AND ER 同时偏高
AND Slope_3 / Slope_5 未转弱
```

这里的 `ReturnZ` 是低滞后门禁，不是预测模型。它只回答：

```text
现在是否正在发生不适合逆势接入的方向性冲击？
```

### 3.3 Opening Range：开盘结构门禁

`Opening Range` 是日内交易中常用的结构概念。Opening Range Breakout 相关研究把开盘后高低点区间用于识别日内大幅移动，说明开盘区间在日内结构中有可研究价值。

当前策略不应照搬 ORB 去追突破，而应反向使用它：

```text
真突破 / 真跌破：禁止逆势均值回归
假突破 / 假跌破回区间：允许回归触发质量提高
```

早盘定义：

```text
OR_high = 09:30-09:44 最高价
OR_low  = 09:30-09:44 最低价
OR_mid  = (OR_high + OR_low) / 2
```

午后定义：

```text
PM_OR_high = 13:00-13:04 或 13:00-13:09 最高价
PM_OR_low  = 13:00-13:04 或 13:00-13:09 最低价
```

具体取 5 分钟还是 10/15 分钟必须回测。考虑当前配置中午盘开盘保护为 5 分钟，午后可以先测试 5 分钟 OR；早盘配置中开盘保护为 15 分钟，早盘可以先测试 15 分钟 OR。

做多禁入：

```text
价格跌破 OR_low
AND 仍在 OR_low 下方
AND 没有快速回到 OR 内
=> 禁止 BUYCALL 极值回归
```

做多触发增强：

```text
价格跌破 OR_low
AND 快速回到 OR_low 上方
AND ER 未趋势化
AND ReturnZ 未显示持续冲击
=> 假跌破回归触发质量提高
```

这个规则的优势是低滞后：OR 区间在开盘保护结束时已经确定，后续只需要比较当前价格与 OR 边界，不需要等待慢指标。

### 3.4 VWAP / VWAP_Z：均值锚与回归空间

`VWAP` 是成交量加权平均价，也是机构执行中常用的交易基准。对均值回归策略，它的价值不是预测方向，而是定义“回归到哪里”。

计算：

```text
TypicalPrice = (high + low + close) / 3
VWAP = sum(TypicalPrice * volume) / sum(volume)
Deviation = close - VWAP
VWAP_Z = Deviation / rollingStd(Deviation)
```

正确用法：

```text
做多要求价格相对 VWAP 有足够负偏离；
做空要求价格相对 VWAP 有足够正偏离。
```

错误用法：

```text
VWAP_Z 很低 => 直接做多
```

原因：

在趋势下跌日，价格可能长时间低于 VWAP，`VWAP_Z` 会持续极端。如果没有 `ER / ReturnZ / OR` 门禁，`VWAP_Z` 会把趋势暴跌误解释为“便宜”。

因此 `VWAP_Z` 只能回答：

```text
是否还有足够回归空间？
```

不能回答：

```text
现在是否适合买入？
```

### 3.5 RSI 极值回收：低滞后触发器

`RSI` 是 Welles Wilder 在 1978 年体系中提出的经典动量振荡指标，权威性足够。它适合当前策略的原因是：

- 窗口可以很短，例如 `RSI_6`。
- 对极端状态敏感。
- 可以从“极值本身”改为“极值后的回收”，降低接刀风险。

不建议：

```text
RSI_6 < 25 => 直接买入
```

建议：

```text
RSI_6 曾低于 25
AND 当前 RSI_6 开始回升
AND 当前价格仍有 VWAP / OR_mid 回归空间
AND ER / ReturnZ / OR 未禁入
=> 允许做多触发
```

做空同理：

```text
RSI_6 曾高于 75
AND 当前 RSI_6 开始回落
AND 当前价格仍有向 VWAP / OR_mid 回归空间
AND ER / ReturnZ / OR 未禁入
=> 允许做空触发
```

`KDJ/J` 可以保留为工程触发器，但它的研究权威性弱于 Wilder RSI。若要做“权威指标优先”的版本，应把 RSI 回收作为主触发，J 回收作为补充触发或消融实验项。

## 4. 不建议使用 ADX 作为核心前置门禁

`ADX` 也是 Wilder 体系中的经典指标，用来衡量趋势强度。它的问题不是不权威，而是不适合当前任务的核心位置。

原因：

1. `ADX` 是平滑后的趋势强度指标，对 1 分钟极值回归入场天然滞后。
2. `ADX` 无方向，只知道趋势强，不知道做多还是做空应该禁入。
3. `ADX` 适合确认趋势已形成，但高敏均值回归需要在趋势形成前识别“当前不适合逆势接入”。
4. 如果等 ADX 明显升高，通常已经错过最危险的早期冲击段；如果等 ADX 回落再买，可能又错过回归最优价格。

因此，ADX 的合理位置是：

- 回测分层变量。
- 退出辅助。
- 趋势日统计标签。
- 非高敏策略的慢确认指标。

不应作为：

- 高敏买入前置硬门禁。
- 替代 `ER + ReturnZ + OR` 的核心趋势过滤器。

## 5. 权威指标如何组合成程序规则

不能把多个权威指标简单堆叠成复杂打分。正确方式是按职责拆分：

```text
状态门禁：ER / ReturnZ / OR
均值锚：VWAP_Z
触发器：RSI 回收 / J 回收 / active bar 影线回收 / OR 假突破
退出：VWAP / OR_mid / 时间止损 / 状态趋势化
```

### 5.1 做多高敏回归

前置状态实时缓存：

```text
ER_10 / ER_15
RV_10 / RV_15
ReturnZ_10 / ReturnZ_15
Slope_3 / Slope_5
OR_low / OR_mid / OR_high
VWAP / VWAP_Z
RSI_6 reclaim state
```

禁入门：

```text
价格仍在 OR_low 下方，且未回到 OR 内
=> 禁入

ReturnZ_10/15 显著为负
AND ER_10/15 偏高
AND Slope_3/5 仍为负
=> 禁入
```

准入门：

```text
VWAP_Z <= negativeThreshold
AND 当前到 VWAP 或 OR_mid 仍有回归空间
AND 禁入门未触发
```

触发：

```text
RSI_6 从低位回升
OR 假跌破后回到区间内
active bar 出现下影线回收
J 从极端负值回收
```

执行：

```text
触发时读取同一份状态快照；
若通过，立即进入买入队列；
不等待 60 秒延迟验证。
```

### 5.2 做空高敏回归

禁入门：

```text
价格仍在 OR_high 上方，且未回到 OR 内
=> 禁入

ReturnZ_10/15 显著为正
AND ER_10/15 偏高
AND Slope_3/5 仍为正
=> 禁入
```

准入门：

```text
VWAP_Z >= positiveThreshold
AND 当前到 VWAP 或 OR_mid 仍有回归空间
AND 禁入门未触发
```

触发：

```text
RSI_6 从高位回落
OR 假突破后回到区间内
active bar 出现上影线回收
J 从极端正值回落
```

## 6. 今日 1 分钟走势对规则的解释

今天 `HSI.HK` 的 1 分钟数据验证了上述问题：

- `09:30-10:49` 下跌约 `-1.035%`。
- `13:00-14:00` 下跌约 `-1.188%`。
- 午后段 `ER15` 最高约 `0.81`，说明路径效率很高，不是普通来回震荡。
- 午后段 `VolExpansion` 最高约 `2.124`，说明短期波动扩张明显。
- 旧的 RSI/MFI/KDJ 极值条件会在下跌段多次触发做多候选。

这说明：

```text
摆动指标极值 != 可回归
VWAP_Z 极端 != 可买入
波动率高 != 必须禁入
有方向的高效率波动 + 未止跌斜率 + OR 破位未回收 = 禁入
```

午后 `13:00-14:00` 的更优解释是：

```text
价格相对 VWAP 极端偏低
但 ER 高、短窗收益为负、斜率仍向下、波动扩张
=> 这是方向性下跌冲击，不是普通回归机会
```

因此这段行情中，如果旧策略因为 RSI/J 极值生成做多信号，新的状态门禁应当拒绝它。

## 7. 与当前程序架构的关系

当前程序已经具备较好的事件驱动基础：普通信号链路由 1 分钟 K 线更新事件推进，指标推进、延迟验证样本写入和信号分流都发生在 K 线业务事件路径中。

新的设计不应引入下列行为：

- 信号触发后再调用远程 API 计算门禁。
- 信号触发后等待多根 K 线确认。
- 用 60 秒延迟验证作为买入入场过滤。
- 在买入执行链路临时补算一套状态。
- 为了兼容旧配置保留双轨策略语义。

正确设计是新增一条事件内状态缓存：

```text
K 线事件到达
-> 增量更新指标 runtime
-> 增量更新 mean-reversion regime snapshot
-> 生成高敏触发
-> 读取同一份 regime snapshot
-> 一次性门禁
-> 通过则进入买入/卖出队列
```

门禁必须是同步读取，不应跨异步边界重新取行情。这样才能保证：

- 触发和门禁基于同一根 K 线事实。
- 没有 API 延迟。
- 没有状态前后不一致。
- 不破坏当前事件驱动链路。

## 8. 快速退出比慢确认更重要

高敏均值回归不应把全部风险都压在入场前确认。更稳健的设计是：

```text
入场前：低滞后状态门禁，避免明显趋势接刀。
入场后：快速失败退出，控制误判成本。
```

建议退出条件：

1. 回到 VWAP 附近，止盈或减仓。
2. 回到 OR_mid，止盈或减仓。
3. 入场后 3/5/8 分钟没有向均值回归，退出。
4. 入场后 `ER + ReturnZ + Slope` 继续趋势化，退出。
5. 跌破入场后局部低点且无下影线回收，退出。

这比“入场前等待 60 秒验证”更符合极值回归。等待会损失最好价格；快速退出则允许策略保留敏感性，同时限制趋势误判损失。

## 9. 回测与参数验证要求

参数不能拍脑袋固定。必须做消融实验：

1. 当前 RSI/MFI/KDJ 极值策略。
2. 当前策略但取消买入 60 秒延迟验证。
3. `VWAP_Z + RSI 回收`。
4. `VWAP_Z + RSI 回收 + ER 禁入`。
5. `VWAP_Z + RSI 回收 + ER + ReturnZ 禁入`。
6. `VWAP_Z + RSI 回收 + ER + ReturnZ + OR 结构门禁`。
7. 加入 active bar 影线回收。
8. 加入 J 回收作为补充触发。

必须统计：

- 触发后 1/3/5 分钟 MFE。
- 触发后 1/3/5 分钟 MAE。
- 入场滑点。
- 是否回到 VWAP。
- 是否回到 OR_mid。
- 被 ER/ReturnZ/OR 禁入后的后续走势。
- 高 ER 与低 ER 分层表现。
- 高 RV 与低 RV 分层表现。
- 早盘、午前、午后、尾盘分时段表现。

如果过滤器提高胜率但显著恶化入场价格，仍然不合格。高敏策略必须同时看：

```text
风险减少
+ 时机损耗
+ 滑点变化
+ 机会损失
```

## 10. 最终结论

针对当前程序，最完整且低滞后的权威指标组合是：

```text
Kaufman Efficiency Ratio：判断路径是否单向有效推进。
Realized Volatility / ReturnZ：判断短窗收益是否构成方向性冲击。
Opening Range：判断开盘结构是真破位还是假突破。
VWAP_Z：定义均值锚偏离和回归空间。
RSI reclaim：作为权威、低滞后的极值回收触发器。
```

其中：

- `ER / ReturnZ / OR` 是入场禁入门。
- `VWAP_Z` 是回归空间判断。
- `RSI reclaim` 是主触发。
- `J reclaim / wick reclaim / false break` 是补充触发。
- `ADX / MACD / EMA 慢确认` 不作为高敏买入前置核心门禁。

最终策略形态：

```text
实时状态缓存
+ 权威低滞后趋势禁入
+ 均值锚偏离
+ 极值回收触发
+ 立即入队
+ 快速失败退出
```

这才符合日内高敏均值回归的本质：不在趋势冲击里接刀，也不因为慢确认错过真正的极值回归时机。

## 11. 参考资料

- Torben G. Andersen, Tim Bollerslev, Francis X. Diebold, Paul Labys, “Modeling and Forecasting Realized Volatility”, NBER Working Paper 8160, 2001. https://www.nber.org/papers/w8160
- Lei Gao, Yufeng Han, Sophia Zhengzi Li, Guofu Zhou, “Market Intraday Momentum”, SSRN. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2440866
- Ulf Holmberg, Carl Lönnbark, Christian Lundström, “Assessing the profitability of intraday opening range breakout strategies”, Finance Research Letters, 2013. https://www.diva-portal.org/smash/record.jsf?pid=diva2%3A553015
- Andrew W. Lo, A. Craig MacKinlay, “The Size and Power of the Variance Ratio Test in Finite Samples”, NBER Technical Working Paper 0066, 1988. https://www.nber.org/papers/t0066
- J. Welles Wilder, “New Concepts in Technical Trading Systems”, 1978. https://openlibrary.org/works/OL5039607W/New_concepts_in_technical_trading_systems
- Konishi, “Optimal slice of a VWAP trade”, 2002. https://www.sciencedirect.com/science/article/pii/S1386418101000234
