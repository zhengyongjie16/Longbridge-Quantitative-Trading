# 恒生指数分钟级交易因子完整方案（近十年权威研究 + 机制验证版）

## 1. 目标与核心结论

本文目标不是在当前程序已有指标上做微调，而是基于 **2016–2026** 年、尤其 **2018–2024** 年面向 **大盘指数 / 指数 ETF / 股指期货 / 分钟级日内交易** 的权威研究，重新规划一套完整因子体系，并给出：

1. 哪些因子最值得优先纳入重构；
2. 每个因子的**定义、计算方式、实际用法**；
3. 如何组合成一套**系统性的多指标策略**；
4. 现有研究与公开代理市场验证能支持什么，不能支持什么。

### 核心结论

1. **对大盘指数分钟级交易，最应优先建设的不是更多超买超卖指标，而是四类上层因子：**
   - **波动率状态因子**（Volatility Regime）
   - **开盘区间结构因子**（Opening Range / TORB）
   - **日内动量阶段因子**（Intraday Momentum Phase）
   - **期货领先 / 期现联动因子**（Futures Lead-Lag / Basis）
2. **VWAP（成交量加权平均价）很重要，但更适合作为状态锚、确认器和执行基准，不是第一主 alpha。**
3. **RSI、MFI、KDJ、PSY 应降级为触发层局部工具，不能再承担“主方向判断”职责。**
4. **最优架构应是：状态层 → 结构层 → 触发层 → 确认层 → 退出层 → 风险层。**
5. **从公开研究与代理市场机制验证看，证据强度排序为：**
   1. 期货领先 / 期现联动
   2. 日内动量 / 尾盘延续
   3. 波动率状态
   4. 开盘区间突破 / 回踩
   5. 订单流失衡 / 价格冲击 / 流动性状态
   6. VWAP 锚定
6. **若继续以现有摆动指标为核心，只会得到“更精细的超买超卖系统”；若以近十年指数研究为核心，则会得到“面向大盘指数的完整分层交易体系”。**

---

## 2. 研究边界与证据标准

### 2.1 研究筛选标准

1. **时间窗口：2016–2026，优先 2018–2024。**
2. **优先市场：**
   - 大盘指数
   - 指数 ETF
   - 股指期货
3. **优先频率：**
   - 分钟级
   - 日内
   - 高频
4. **优先来源：**
   - *Journal of Financial Economics*（JFE）
   - *Finance Research Letters*（FRL）
   - *IEEE Access*
   - *Expert Systems with Applications*
   - *Journal of Financial Econometrics*（JFEC）
   - *Borsa Istanbul Review*
   - 高质量工作论文 / OFR / SSRN / arXiv（仅补强，不作唯一主依据）

### 2.2 数据与验证现实

理想状态下，应直接用 **HSI 现货 / HSI 期货 / 2800.HK ETF** 的分钟级同步数据做回测。

但当前公开数据现实是：

1. **长期、稳定、免费、官方的 HSI 分钟级公共 API 很难拿到。**
2. **期现双边高质量同步数据更难。**
3. 因此，本轮验证采用两类证据：
   - **一级证据：**近十年权威论文的实证结论；
   - **二级证据：**SPY / ES / 中国股指期货 / 指数 ETF 等代理市场的公开样本与研究结果，用于“机制验证”。

这意味着：

- 文档里的结论是**强机制支持 + 条件性可迁移**；
- 不是“已经用 HSI 全历史分钟数据完全回测定论”。

---

## 3. 最优因子体系总览

面向大盘指数分钟级交易，推荐使用六层架构：

1. **状态层**：判断今天适合趋势还是回归
2. **结构层**：识别当前价格结构
3. **触发层**：寻找精确入场时点
4. **确认层**：过滤低质量触发
5. **退出层**：决定如何止盈止损
6. **风险层**：控制频率、仓位、熔断

### 3.1 各层职责简表

| 层级 | 解决的问题 | 代表因子 |
|---|---|---|
| 状态层 | 今天是什么市场 | 波动率状态、期现联动、VWAP 状态锚 |
| 结构层 | 当前是什么结构 | 开盘区间突破、日内动量阶段、区间失败回归 |
| 触发层 | 何时入场 | 微突破、回踩二次启动、局部动量脉冲、RSI/MFI/K/D |
| 确认层 | 是否放行 | VWAP 同侧、量能确认、多周期一致性、MACD/EMA |
| 退出层 | 如何离场 | 结构破坏止损、ATR 止损、VWAP/中轴止盈、时间退出 |
| 风险层 | 如何活下去 | 仓位、频次、连续亏损熔断、时段屏蔽 |

---

## 4. 核心因子详解：定义、计算方式、实际用法

以下只重点展开**最值得新增或提升权重**的因子组，不再重复铺陈为什么一般摆动指标会失真。

## 4.1 波动率状态因子（Volatility Regime）

### 4.1.1 作用定位

这是**状态层核心因子**。它不直接告诉你买还是卖，而是告诉你：

- 今天是不是适合做趋势；
- 当前波动是否足以支撑突破延续；
- 当前摆动触发是否只是噪音。

### 4.1.2 推荐计算方式

#### 方法 A：ATR 扩张比

- 定义：
  - `ATR_short = ATR(5)`
  - `ATR_long = ATR(30)`
  - `VolExpansion = ATR_short / ATR_long`
- 解释：
  - `> 1` 表示近期波动在扩张
  - `< 1` 表示近期波动在收缩

#### 方法 B：已实现波动率（Realized Volatility）

- 定义：
  - 用 1 分钟收益率 `r_t = ln(P_t / P_{t-1})`
  - `RV_n = sqrt(sum(r_t^2, t=1..n))`
- 可用窗口：
  - 15 分钟、30 分钟、60 分钟
- 解释：
  - 衡量真实的短期价格振动强度

#### 方法 C：波动率分位数

- 定义：
  - 把当前 30 分钟 RV 与过去 20 个交易日同一时段 RV 比较
  - 得到分位数 `VolQuantile`
- 解释：
  - 判断今天当前时段波动处于历史什么位置

### 4.1.3 实际用法

#### 用法 1：策略开关

- 若 `VolExpansion > 1.2` 且 `VolQuantile > 0.7`
  - 允许趋势策略启用
- 若 `VolExpansion < 0.9` 且 `VolQuantile < 0.4`
  - 倾向震荡/回归策略

#### 用法 2：仓位缩放

- 中性状态：标准仓位 × 1.0
- 高波动扩张：若趋势结构成立，标准仓位 × 1.2；若无结构，仅 × 0.5
- 极端高波动失真：禁做或半仓

#### 用法 3：阈值动态调整

- 高波动时，RSI/KDJ 等摆动阈值应放宽
- 低波动时，突破确认阈值应降低

### 4.1.4 使用建议

- 绝不要单独交易波动率状态；
- 它应始终作为**状态门禁 + 仓位调整器**使用。

### 4.1.5 研究支持摘要

1. *Borsa Istanbul Review* 2024：股指期货波动率与价格持续时间、成交量、持仓量等微观结构变量强相关。
2. *JFEC* 2024：日内波动具有可预测性与共性结构。
3. JFE 2018 / 2021：日内动量在高波动日更强。

### 4.1.6 结论

**波动率状态是大盘指数分钟级策略的总门禁，不是可有可无的辅助项。**

---

## 4.2 开盘区间结构因子（Opening Range / TORB）

### 4.2.1 作用定位

这是**结构层核心因子**。它用于判断：

- 今天是否已经从开盘平衡区切换到趋势结构；
- 当前是否出现有效突破；
- 是否属于“突破后回踩再延续”的高质量机会。

### 4.2.2 推荐计算方式

#### 方法 A：固定开盘区间

- 定义：
  - `OR_high = 开盘后前 N 分钟最高价`
  - `OR_low = 开盘后前 N 分钟最低价`
- 典型参数：
  - `N = 15 / 30`

#### 方法 B：突破强度

- 定义：
  - `BreakoutScore_up = (Price - OR_high) / ATR_short`
  - `BreakoutScore_down = (OR_low - Price) / ATR_short`
- 解释：
  - 归一化后判断突破不是简单的“多几跳”，而是相对当前波动的真实突破

#### 方法 C：区间外停留度

- 定义：
  - 统计价格突破 OR 后，在区间外停留的分钟数占比
  - `OutsidePersistence = 区间外bar数 / 总观察bar数`
- 解释：
  - 真突破通常不是刺穿一下就结束

### 4.2.3 实际用法

#### 用法 1：趋势日识别

满足以下多数条件，认定“趋势结构可能成立”：

1. `BreakoutScore > 0.5 ~ 1.0`
2. `OutsidePersistence > 0.6`
3. 突破后回踩不回区间内部
4. VWAP 同向
5. 波动率状态支持

#### 用法 2：趋势策略的主结构

- 多头：上破 `OR_high` → 回踩 `OR_high` 不破 → 二次启动入场
- 空头：下破 `OR_low` → 反抽 `OR_low` 不回区间 → 二次下行入场

#### 用法 3：震荡策略的反向禁做条件

- 一旦 OR 突破被判定有效，所有基于超买超卖的逆势反向单应暂停

### 4.2.4 典型参数建议

- OR 窗口：15 或 30 分钟
- 回踩容忍：`0.1 ~ 0.3 ATR`
- 区间外停留时间：`5 ~ 10 分钟`
- 适合与：
  - 波动率状态
  - VWAP 同侧
  - 成交量确认
  - 多周期一致性
  组合使用

### 4.2.5 研究支持摘要

- *IEEE Access* 2019：在 DJIA、S&P 500、NASDAQ、HSI、TAIEX 期指上，1 分钟 TORB 具有统计显著性；不同市场存在最佳探测窗口差异。

### 4.2.6 结论

**开盘区间结构因子是大盘指数最值得优先加入的结构型因子之一，尤其适合 HSI 这类开盘和午后结构特征明显的市场。**

---

## 4.3 日内动量阶段因子（Intraday Momentum Phase）

### 4.3.1 作用定位

这是**结构层与状态层之间的桥梁因子**。它判断：

- 早段走势是否会延续到后段；
- 当前是否处于第一推进段、第二推进段、尾盘延续段；
- 应该顺势做推进，还是等待回归。

### 4.3.2 推荐计算方式

#### 方法 A：早段收益率

- 定义：
  - `R_early = ln(P_t / P_open)`
  - 常用窗口：开盘后 30 分钟 / 60 分钟
- 用法：
  - 判断早段方向是否已经形成

#### 方法 B：动量斜率

- 定义：
  - 对最近 `n` 根 1min bar 的价格做线性回归
  - 取回归斜率 `Slope_n`
- 典型参数：
  - `n = 5 / 8 / 15`

#### 方法 C：效率比（Efficiency Ratio）

- 定义：
  - `ER = |P_t - P_{t-n}| / Σ|ΔP|`
- 解释：
  - 越接近 1，说明净推进越强；
  - 越接近 0，说明来回噪音越大。

### 4.3.3 实际用法

#### 用法 1：尾盘延续判断

- 若早段收益显著为正，且 `ER` 高，且波动率状态支持，则尾盘继续做多的优先级提高。
- 若早段收益显著为负，且 `ER` 高，则尾盘做空优先级提高。

#### 用法 2：区分趋势段与噪音段

- `ER` 高 + 斜率同向：趋势推进
- `ER` 低 + 价格反复穿 VWAP：震荡回归

#### 用法 3：与开盘区间联动

- 上破 OR 后若早段收益继续扩大，则定义为“开盘趋势日第一推进段”
- 若 OR 突破后收益衰减、ER 下降，则不追第二段

### 4.3.4 典型参数建议

- 早段窗口：30 分钟
- 第二观察窗口：60 分钟
- `ER` 窗口：15 / 30 bar
- 斜率窗口：5 / 8 / 15 bar

### 4.3.5 研究支持摘要

1. JFE 2018：前半小时收益可预测最后半小时收益。
2. JFE 2021：多资产期货市场存在日内动量，且随后几日有回吐。
3. FRL 2020：中国股指期货存在日内时间序列动量，60 分钟级别最强，高成交/高波动更强。

### 4.3.6 结论

**日内动量阶段因子，是最有权威研究支持的大盘指数主 alpha 候选之一。**

---

## 4.4 期货领先 / 期现联动因子（Futures Lead-Lag / Basis）

### 4.4.1 作用定位

这是**大盘指数最具专属性的核心因子组**。它不是普通技术指标，而是直接描述：

- 期货是否先于现货/ETF 进行价格发现；
- 当前基差是否异常偏离；
- 风险偏好与对冲需求是否正在通过期货先行表达。

### 4.4.2 推荐计算方式

#### 方法 A：短窗领先收益差

- 定义：
  - `LeadGap_k = r_futures(t-k, t) - β * r_spot(t-k, t)`
- 解释：
  - 若期货先显著变化，而现货尚未同步，说明存在领先信号
- 参数：
  - `k = 1 / 3 / 5 分钟`
  - `β` 可取 1，或通过历史回归估计

#### 方法 B：滚动相关领先性

- 定义：
  - 计算 futures return 与 spot future-shifted return 的滚动相关
- 解释：
  - 找出“谁领先谁”的时变关系

#### 方法 C：基差 z-score

- 定义：
  - `Basis = FuturesPrice - SpotProxyPrice`
  - `BasisZ = (Basis - rolling_mean) / rolling_std`
- 解释：
  - 判断当前期现偏离是否异常扩张或收敛

### 4.4.3 实际用法

#### 用法 1：趋势确认

- 若股指期货在最近 1~3 分钟已先突破关键位，而现货指数/ETF 尚未完全跟随，则现货端顺势信号优先级提高

#### 用法 2：假突破过滤

- 若现货指数看似突破，但期货未配合，则视为低质量突破

#### 用法 3：基差偏离回归

- 若基差显著偏离历史常态，且波动状态不支持趋势扩张，则可作为回归类结构的补强因子

### 4.4.4 典型参数建议

- 领先窗口：1 / 3 / 5 分钟
- 基差 z-score 窗口：30 / 60 分钟
- 必须与：
  - 波动率状态
  - 开盘区间结构
  - 现货 VWAP / 现货趋势
  联动使用

### 4.4.5 研究支持摘要

1. 2016–2025 多篇 lead-lag 研究表明，HSI、S&P 500、CSI 300 等市场里，期货常领先现货数秒到数分钟。
2. FRL 2022、2023 相关研究表明，CSI 300 期货通常领先现货 0–5 分钟。
3. ESWA 2024 研究表明，加入期货信息后，中国指数 ETF 高频技术规则样本外能力改善。
4. OFR 2019 研究表明，E-mini 与 SPY 存在高频订单流、流动性与价格发现联动。

### 4.4.6 结论

**若你愿意完整重构系统，这一组因子应排在最高优先级。它比继续增加任何摆动指标都更符合大盘指数本质。**

---

## 4.5 VWAP 因子（作为状态锚和执行因子）

### 4.5.1 作用定位

VWAP 不建议作为最上层主 alpha，而应定位为：

1. **状态锚**：判断价格在成交重心上方还是下方
2. **确认器**：趋势单要求与 VWAP 同侧
3. **止盈/止损锚**：回归单看向 VWAP，趋势单跌破 VWAP 可减仓
4. **执行基准**：评估成交质量

### 4.5.2 计算方式

- 日内累计：
  - `VWAP_t = Σ(price_i * volume_i) / Σ(volume_i)`
- 也可使用：
  - Anchored VWAP（锚定 VWAP）
  - 锚定起点可设为：
    1. 开盘时刻
    2. 开盘区间突破时刻
    3. 日内高点 / 低点形成时刻

### 4.5.3 实际用法

#### 用法 1：趋势确认

- 做多：`Price > VWAP` 且 VWAP 斜率向上
- 做空：`Price < VWAP` 且 VWAP 斜率向下

#### 用法 2：回归目标位

- 若做区间回归单，首要目标可设为 VWAP 或 Anchored VWAP

#### 用法 3：锚定重大结构

- 突破 OR 后，用突破时刻 Anchored VWAP 判断趋势是否还有效

### 4.5.4 研究支持摘要

近十年 VWAP 的强研究主要集中在：

- 最优执行
- 成交量建模
- 市场冲击

因此它更适合做：

- 状态锚
- 过滤器
- 执行基准

### 4.5.5 结论

**VWAP 很重要，但它应放在“辅助状态锚与执行层”，而不是放在最前排主 alpha。**

---

## 4.6 订单流失衡 / 价格冲击 / 流动性状态因子

### 4.6.1 作用定位

这是**高阶增强因子**，特别适合：

- 超短线精细择时
- 期现联动补强
- 执行质量优化

### 4.6.2 推荐计算方式

#### 方法 A：Order Flow Imbalance（订单流失衡）

若有盘口数据：

- 统计买一卖一及其挂单量变化
- 或统计主动买卖成交额差值
- 常见定义：
  - `OFI = ΔBidSize - ΔAskSize` 的累积近似

#### 方法 B：Price Impact（价格冲击效率）

- 定义：
  - `Impact = ΔPrice / VolumeSigned`
- 解释：
  - 同样的主动成交量，价格被推动得越多，说明市场越脆弱

#### 方法 C：流动性恢复速度（Resiliency）

- 定义：
  - 一次明显冲击后，盘口深度恢复所需时间
- 解释：
  - 恢复慢说明趋势推进更可能继续

### 4.6.3 实际用法

#### 用法 1：过滤假突破

- 若价格突破但 OFI 不配合，且冲击后深度恢复快，则视为低质量突破

#### 用法 2：确认期货领先有效性

- 若期货领先上涨，同时现货端 OFI 也开始转正，则现货跟随单质量更高

#### 用法 3：调整执行方式

- 高冲击、低恢复环境下，应减少追价；
- 高恢复环境下，可更积极跟进。

### 4.6.4 结论

**若后续能拿到盘口/逐笔数据，它是高价值增强层；若只有 1 分钟 K 线，则暂不应排在前四优先级之前。**

---

## 5. 因子优先级总排序（不受当前程序约束）

### 第一优先级：必须优先建设

1. **期货领先 / 期现联动 / 基差**
2. **日内动量阶段**
3. **波动率状态**
4. **开盘区间结构**

### 第二优先级：高价值辅助层

5. `VWAP / Anchored VWAP`
6. `日内区间位置`
7. `成交量 / 成交额状态`
8. `订单流失衡 / 价格冲击 / 流动性恢复`

### 第三优先级：触发层局部工具

9. `EMA / MACD / DIF / DEA`
10. `RSI`
11. `MFI`
12. `K / D`
13. `PSY`
14. `J`

> 说明：
> - EMA / MACD 之所以排在触发层前列，是因为它们也可兼任确认层主力。
> - RSI / MFI / KDJ / PSY 不再进入“核心主因子”层级。

---

## 6. 系统性多指标策略设计：不是列指标，而是形成闭环

下面给出一套可重构为正式系统的多指标策略框架。

## 6.1 总控流程

统一控制顺序必须固定：

1. **状态层评分**
2. **结构层识别**
3. **触发层等待**
4. **确认层过滤**
5. **执行层下单**
6. **退出层管理**
7. **风险层熔断**

### 伪流程

```text
State Score -> Select Regime -> Select Structure -> Wait Trigger -> Pass Confirmation -> Execute -> Manage Exit -> Risk Monitor
```

---

## 6.2 状态层评分模型

建议输出四类状态：

1. `trend_up`：趋势上行
2. `trend_down`：趋势下行
3. `range`：震荡/回归
4. `transition`：过渡/失真，少做或不做

### 趋势评分 TrendScore

可由以下因子加权组成：

- `VolExpansionScore`
- `ORBreakoutScore`
- `ERScore`
- `VWAPSameSideScore`
- `FuturesLeadScore`

示例：

```text
TrendScore = 0.25*VolExpansion + 0.25*ORBreakout + 0.20*ER + 0.15*VWAPSameSide + 0.15*FuturesLead
```

### 回归评分 RangeScore

可由以下因子加权组成：

- `VWAPCrossFrequency`
- `LowER`
- `FalseBreakCount`
- `VolCompression`
- `WeakBreadth`

示例：

```text
RangeScore = 0.25*VWAPCross + 0.20*LowER + 0.20*FalseBreak + 0.20*VolCompression + 0.15*WeakBreadth
```

### 状态切换规则

- `TrendScore > 70` 且 `RangeScore < 40`：趋势策略启用
- `RangeScore > 70` 且 `TrendScore < 40`：回归策略启用
- 否则：`transition`

---

## 6.3 策略原型 A：趋势日策略

### 适用目标

赚大盘指数单边推进段的钱，不猜顶底，只做“高质量趋势段”。

### A1 状态条件

以下多数条件成立：

1. `VolExpansion > 1.2`
2. `BreakoutScore > 0.8`
3. `ER > 0.45`
4. `Price` 长时间位于 `VWAP` 同侧
5. `FuturesLeadScore` 同向为正

### A2 结构条件

优先做两类结构：

#### 结构 1：开盘区间突破后回踩延续

- 上破/下破 OR
- 回踩 OR 边界不回区间
- 二次启动时等待入场

#### 结构 2：趋势中继回撤

- 已有明显推动段
- 回撤到 EMA / Anchored VWAP 附近
- 回撤幅度不超过前推动段 `38.2%~61.8%`
- 二次启动时入场

### A3 触发条件

从以下触发里选 1~2 个组合：

1. 突破最近 3~5 根 bar 局部高点/低点
2. 回踩后出现同向强实体 bar
3. `Slope_5` 再次加速
4. `MACD / DIF` 同向扩张

### A4 确认条件

至少满足以下 2 项：

1. `Price > VWAP` 且 `VWAP slope > 0`（做多时）
2. 推进 bar 的量 > 回撤 bar 的量
3. 5 分钟结构未反向
4. 期货领先未失效
5. 关键权重 / 广度同步

### A5 退出条件

1. 结构破坏止损：跌破最近确认回撤低点 / 反向突破最近确认反抽高点
2. 波动止损：`1.2 ~ 1.8 ATR_short`
3. 1R 减仓 30%~50%
4. 剩余仓位沿 EMA / Anchored VWAP / swing high-low 跟踪
5. 若重新回到 VWAP 且无法再离开，平仓
6. 收盘前平仓，不隔夜

### A6 不做条件

1. OR 突破后迅速回区间
2. 期货不跟
3. VWAP 走平
4. 广度不支持
5. 高波动但失真状态（影线大、方向反复）

---

## 6.4 策略原型 B：震荡 / 回归日策略

### 适用目标

赚价格偏离公允值后的回归，不做单边追涨杀跌。

### B1 状态条件

以下多数条件成立：

1. `VolExpansion < 1.0`
2. `ER < 0.25`
3. 价格频繁穿越 `VWAP`
4. OR 假突破次数增加
5. `FuturesLeadScore` 不稳定或无显著同向领先

### B2 结构条件

#### 结构 1：区间边界失败回归

- 价格触及区间边界或刺穿边界
- 无法持续
- 收回边界内
- 目标看向区间中轴 / VWAP

#### 结构 2：VWAP 偏离回归

- 价格偏离 VWAP 达到统计极值
- 动量衰减
- 期货未给出同向推进确认
- 等待回归 VWAP

### B3 触发条件

1. 假突破后收回关键位
2. 反向吞没 / 局部微结构反转
3. `RSI / MFI / K/D` 出现极值后重新拐头

### B4 确认条件

至少满足以下 2 项：

1. 偏离达到统计极值（例如 `1.5~2.0 sigma`）
2. VWAP 走平
3. 成交量没有继续放大
4. 5 分钟仍在大区间内
5. 期货没有持续领先扩张

### B5 退出条件

1. VWAP 或区间中轴止盈
2. 到边界前分批减仓
3. 若市场突然切换为趋势扩张，立即止损
4. 入场后 `5~10` 分钟无回归动作则平仓

### B6 不做条件

1. OR 真突破成立
2. VWAP 单边走斜率
3. 波动率扩张
4. 期货领先同向很强

---

## 6.5 两套策略如何切换

切换不能主观，必须显式规则化。

### 切到趋势策略的条件

1. `TrendScore` 连续 `N` 个窗口大于阈值
2. OR 突破成立
3. VWAP 同侧持续
4. 波动率扩张
5. 期货领先支持

### 切到回归策略的条件

1. `RangeScore` 连续 `N` 个窗口大于阈值
2. OR 假突破次数增加
3. VWAP 被频繁穿越
4. 波动率收缩
5. 期货不再领先

### 过渡状态处理

- 不开新仓，或只允许半仓试错
- 这比任何单一指标的“灵敏度优化”都更重要

---

## 7. 各因子如何搭配，而不是孤立使用

## 7.1 推荐搭配 1：趋势日主框架

```text
波动率状态 + 开盘区间突破 + 日内动量阶段 + 期货领先
-> 用 VWAP 同侧与 EMA/MACD 做确认
-> 回踩后二次启动入场
-> 结构破坏或回归 VWAP 退出
```

### 适用场景

- 单边上涨 / 单边下跌
- 午后修复后再创新高/新低
- 重要消息驱动后形成持续趋势

---

## 7.2 推荐搭配 2：震荡回归主框架

```text
低波动 / 低效率比 + OR 假突破 + VWAP 偏离极值 + 期货不领先
-> 用 RSI/MFI/KD 作为局部触发
-> VWAP / 区间中轴作为目标位
-> 一旦波动扩张或期货领先恢复，立刻退出
```

### 适用场景

- 午后缩量
- 日内区间震荡
- 强趋势失败后的平衡修复

---

## 7.3 推荐搭配 3：期现联动增强框架

```text
期货领先 + 波动率状态支持 + 现货 OR 突破或 VWAP 同侧
-> 现货/ETF 跟随入场
-> 若基差回归或期货领先消失则退出
```

### 适用场景

- 指数与股指期货同步活跃的市场
- HSI / HSI futures
- ES / SPY
- 中国股指期货 / 指数 ETF

---

## 8. 模拟与验证结论（公开研究 + 代理市场机制验证）

## 8.1 本轮实际验证方式

由于当前会话环境无法稳定下载理想的 HSI 期现双边分钟级数据，本轮验证采用：

1. **一级验证：**近十年权威论文实证结论
2. **二级验证：**SPY / ES / 中国股指期货 / 指数 ETF 的公开研究与样本结果，做机制验证

## 8.2 机制验证结论

### 日内动量

- 公开研究支持最强
- SPY / ETF / 多资产期货上都存在
- 对大盘指数具有很强迁移意义
- **结论：优先级最高，值得先做系统级验证**

### 开盘区间突破

- 在指数期货上有统计显著性证据，且覆盖 HSI futures
- 但对参数、开盘制度、成本敏感
- **结论：适合做“开盘结构策略”，不宜单独做全天主框架**

### 波动率状态

- 强烈支持其作为门禁因子，而非方向因子
- **结论：必须加入总控状态层**

### 期货领先 / 期现联动

- 研究证据硬，且最贴近大盘指数特性
- 但必须依赖高质量同步数据
- **结论：一旦具备数据，应列为最高优先级研究与落地对象**

### VWAP

- 方向性 alpha 证据弱于前几类
- 但状态锚、确认器、止盈止损和执行意义很强
- **结论：应加入，但不应当成第一主因子**

---

## 9. 重构路线图：为了支持完整方案，需要新增什么

## 9.1 数据层

必须新增：

1. 多周期 K 线（1m / 5m / 15m）
2. 分钟成交量 / 成交额
3. OR 状态缓存
4. VWAP / Anchored VWAP 所需数据
5. 波动率状态数据（ATR / RV）
6. HSI 期货或代理期货数据
7. 若条件允许，盘口 / 逐笔数据

## 9.2 指标层

必须新增：

1. ATR / NATR / RV
2. OR 高低与突破持久度
3. Efficiency Ratio / 斜率 / 日内动量阶段
4. Basis / Lead-Lag
5. VWAP / Anchored VWAP
6. 区间位置 / 边界失败检测
7. 订单流 / 价格冲击（可后置）

## 9.3 信号层

必须改成：

1. 状态分类器
2. 结构识别器
3. 触发器
4. 确认过滤器
5. 执行计划器
6. 风险仲裁器

## 9.4 回测与验证层

必须新增：

1. 分状态分桶回测
2. 分结构收益分析
3. 因子消融实验
4. Walk-forward 验证
5. 期现联动同步回测
6. 日内 session-aware 回测引擎

---

## 10. 最终结论

针对大盘指数分钟级交易，正确的问题不是：

> “RSI / KDJ / MFI / PSY 怎么继续调？”

而是：

> **“如何先识别市场状态，再识别结构，再等待触发，再确认，再退出？”**

因此，真正值得重构的方向是：

1. **以波动率状态、开盘区间、日内动量、期现联动为核心上层因子；**
2. **以 VWAP 为状态锚和执行辅助；**
3. **把 RSI / MFI / KDJ / PSY 重新降级为触发层局部工具；**
4. **把 EMA / MACD / ADX 放入确认层；**
5. **构建趋势日策略与震荡日策略两套原型，并用状态层显式切换。**

这比任何“继续堆摆动指标”的方案都更完整、更符合近十年权威研究，也更符合你对完整重构的目标。

---

## 参考资料（主证据）

1. Gao, Han, Li, Zhou. *Market intraday momentum*. *Journal of Financial Economics*, 2018.
   - https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351
   - DOI: https://doi.org/10.1016/j.jfineco.2018.05.009

2. Baltussen, Da, Lammers, Martens. *Hedging demand and market intraday momentum*. *Journal of Financial Economics*, 2021.
   - https://www.sciencedirect.com/science/article/abs/pii/S0304405X21001598
   - PDF: https://www3.nd.edu/~zda/intramom.pdf
   - DOI: https://doi.org/10.1016/j.jfineco.2021.04.029

3. *Does intraday time-series momentum exist in Chinese stock index futures market?* *Finance Research Letters*, 2020.
   - https://www.sciencedirect.com/science/article/abs/pii/S1544612319304337
   - DOI: https://doi.org/10.1016/j.frl.2019.09.007

4. *Assessing the Profitability of Timely Opening Range Breakout on Index Futures Markets*. *IEEE Access*, 2019.
   - https://ieeexplore.ieee.org/document/8641124
   - 公开镜像：https://www.researchgate.net/publication/331076454_Assessing_the_Profitability_of_Timely_Opening_Range_Breakout_on_Index_Futures_Markets/fulltext/5c64c1caa6fdccb608c11349/Assessing-the-Profitability-of-Timely-Opening-Range-Breakout-on-Index-Futures-Markets.pdf

5. *Price duration, returns, and volatility estimation: Evidence from China's stock index futures market*. *Borsa Istanbul Review*, 2024.
   - https://www.sciencedirect.com/science/article/pii/S2214845024000991
   - DOI: https://doi.org/10.1016/j.bir.2024.06.008

6. *Do futures improve genetically trained high-frequency technical trading rules for the Chinese index ETF market?* *Expert Systems with Applications*, 2024.
   - https://www.sciencedirect.com/science/article/pii/S0957417423032232
   - DOI: https://doi.org/10.1016/j.eswa.2023.122721
   - 学校页面：https://research.nottingham.edu.cn/en/publications/do-futures-improve-genetically-trained-high-frequency-technical-t/

7. *Volatility Forecasting with Machine Learning and Intraday Commonality*. *Journal of Financial Econometrics*, 2024.
   - https://academic.oup.com/jfec/article/22/2/492/7081291

8. Gong, Ji, Su, Li, Ren. *The lead–lag relationship between stock index and stock index futures: A thermal optimal path method*. *Physica A*, 2016.
   - https://ideas.repec.org/a/eee/phsmap/v444y2016icp63-72.html

9. Alemany, Aragó, Salvador. *Lead-lag relationship between spot and futures stock indexes: Intraday data and regime-switching models*. *International Review of Economics & Finance*, 2020.
   - https://www.sciencedirect.com/science/article/abs/pii/S1059056020300551

10. Xiao, Ma, Mi. *The time-varying lead-lag relationship between index futures and the cash index and its factors*. 2023.
   - DOI: https://doi.org/10.1080/1331677X.2022.2090404
   - Open PDF: https://hrcak.srce.hr/file/438548

## 补强证据

1. OFR Working Paper 2019. *Cross-Asset Market Order Flow, Liquidity, and Price Discovery*.
   - https://www.financialresearch.gov/working-papers/2019/10/23/cross-asset-market-order-flow-liquidity-and-price-discovery/
   - PDF: https://www.financialresearch.gov/working-papers/files/OFRwp-19_04_cross-asset-market-order-flow-liquidity-and-price-discovery.pdf

2. Webb, Ryu, Ryu, Han. *The price impact of futures trades and their intraday seasonality*. *Emerging Markets Review*, 2016.
   - https://www.sciencedirect.com/science/article/pii/S1566014116000030
   - DOI: https://doi.org/10.1016/j.ememar.2016.01.002

3. *The distribution of index futures realised volatility under seasonality and microstructure noise*, 2020.
   - https://www.sciencedirect.com/science/article/pii/S0264999320311676

4. *Technical analysis-based unsupervised intraday trading DJIA index stocks: is it profitable in long term?*, 2024.
   - https://link.springer.com/article/10.1007/s10489-024-05903-2

5. *Deep order flow imbalance: Extracting alpha at multiple horizons from the limit order book*, 2023.
   - https://ideas.repec.org/a/bla/mathfi/v33y2023i4p1044-1081.html

6. *Can Day Trading Really Be Profitable?*（SSRN）
   - http://dx.doi.org/10.2139/ssrn.4416622