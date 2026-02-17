# Alpha 101 量化因子库详细说明

## 一、概述与来源

### 1.1 定义

**Alpha 101**（又称 **101 Formulaic Alphas**）是世界知名量化对冲基金 **WorldQuant（世坤）** 于 2015 年在其同名报告中公开的 **101 个公式化 Alpha 因子**。这些因子以明确的数学表达式（可视为可直接运行的代码）给出，可用于在历史数据上复现、回测，并作为构建量化策略与实证研究的基础。

- **学术含义**：Alpha 是数学表达式、代码与配置的组合，用于预测金融工具的未来走势。  
- **实践含义**：Alpha 通常指可带来合理「预期回报」的交易逻辑。  
- **本因子库**：101 个因子均为基于**价量数据**（及少量基本面/行业）的**可计算、可回测**的公式化 Alpha。

### 1.2 背景与价值

- 量化领域对 Alpha 的挖掘与公式化研究一直是重要方向。  
- WorldQuant 公开这 101 个因子的目的包括：  
  - 让读者了解真实环境中较简单的 Alpha 形态；  
  - 便于在历史数据上**复现与测试**；  
  - 激励读者提出新思路并构建自己的 Alpha 模型。  
- 据业界与复现研究，其中约 **80%** 的因子在实盘或回测中仍具一定有效性；**具体哪些因子属无效未见公开清单**。本文档仅保留在常见解读与复现研究中被认为具一定逻辑或实证基础的因子，已剔除在来源解读中被明确标注为**过拟合、固定数字阈值、缺乏理论依据或逻辑粗糙**的条目（**#27、#36、#41、#42、#46、#51、#58、#59**），共 **93 条**。

---

## 二、构建逻辑与思想

### 2.1 两大核心逻辑

Alpha 101 因子从逻辑上可归纳为两类（实际因子中常混合使用）：

| 类型         | 含义说明                                                                 | 简单例子 |
|--------------|--------------------------------------------------------------------------|----------|
| **均值回归** | 价格偏离「均衡」后预期回归，信号与短期收益往往**反向**。                 | 今日开盘高于昨日收盘 → 预期回撤。 |
| **动量**     | 近期趋势延续，信号与收益**同向**。                                       | 昨日收涨 → 预期今日继续上涨。     |

**均值回归示例（0 延迟）**：

$$-\ln\left(\frac{\text{今日开盘价}}{\text{昨日收盘价}}\right)$$

- 开盘价高于昨收 → 因子为正 → 预期回归、回撤；  
- 开盘价低于昨收 → 因子为负 → 预期反弹。  
- 「0 延迟」：所用数据与交易时间一致（如当日开盘或收盘附近交易）。

**动量示例（1 延迟）**：

$$\ln\left(\frac{\text{昨日收盘价}}{\text{昨日开盘价}}\right)$$

- 昨日收涨 → 因子为正 → 预期今日延续；反之亦然。  
- 「1 延迟」：用 T-1 日数据，在 T 日交易。

### 2.2 量价特征作为「构建块」

可将 101 个因子理解为：先定义一批**显著量价特征**（如价差、波动、成交量排名、价量相关性等），再通过**组合、排名、时序函数**等得到复杂表达式。典型特征包括：

- 开盘/收盘相对关系（open vs close）；  
- 最高/最低与收盘的关系（high, low, close）；  
- 成交量与价格、波动的关系（volume, vwap, volatility）；  
- 多日收益、波动、排名（returns, stddev, rank）；  
- 价量相关性、协方差（correlation, covariance）。

复杂因子中常同时包含均值回归与动量成分，例如：  
- **Alpha#101**：偏「1 延迟」动量——若当日收 > 开且 high > low，则次日做多。  
- **Alpha#48、#53、#54**：0 延迟因子，在收盘附近交易。

### 2.3 延迟（Delay）概念

| 延迟   | 含义说明 |
|--------|----------|
| **0 延迟** | 计算所用数据与交易时间在同一天（如当日收盘附近交易）。本库保留的 0 延迟因子：**#48、#53、#54**（原 #42 已剔除）。 |
| **1 延迟** | 用 T-1 日数据，在 T 日交易。多数因子属于此类或更高延迟。 |
| **2 延迟** | 用 T-2 日及更早数据，在 T 日交易。 |

实盘或回测时需根据因子延迟设定**信号生成时间**与**下单时间**，避免使用未来数据。

### 2.4 因子分类标签（参考：千山资本）

对 101 个 Alpha 进行解读与打标签后，可得到更上层的抽象分类（参见 [千山资本 | 预测股票市场的101个alpha因子的解读与总结](http://www.qianshancapital.com/h-nd-329.html)）：

**投资原理**

- **momentum**：动量，趋势延续。
- **mean-reversion**：均值回归，偏离后回归。
- **量价理论**：价涨时不与众人同买、价跌时众人恐慌时考虑介入；量价同向不买、量价反向考虑。
- **蜡烛图理论**：对 close、open、high、low 的关系进行分析，类似给定波动下的交易机会。

**数量化手段**

- 加减乘除的惩罚式模型构建。
- 基于 **Rank**（横截面）与 **Ts_Rank**（时间序列）的正/反序。
- 基于 **decay_linear**、**sum**、**ts_argmax/ts_argmin** 的时间维度鲁棒性增强。
- 基于 **scale**、**indneutralize** 的横截面鲁棒性增强。

**套利手段**

- 横截面排序（择股套利）。
- 时间序列排序（择时套利）。

下文第七节对每个因子的「**标签**」即采用上述投资原理分类（momentum / mean-reversion / 量价理论 / 蜡烛图理论等）。

---

## 三、数据基础

### 3.1 主要数据

因子**主要**基于日频「价格–成交量」类数据：

| 变量/概念    | 含义说明 |
|-------------|----------|
| **open**    | 开盘价 |
| **close**   | 收盘价（报告中多指复权收盘价） |
| **high**    | 最高价 |
| **low**     | 最低价 |
| **volume**  | 成交量 |
| **vwap**    | 成交量加权平均价（dollar volume / volume，或 amount/volume） |
| **returns** | 日收益率，通常为 close(t)/close(t-1) - 1 |

部分因子还会用到：

- **adv20 / adv120 / adv180** 等：过去 N 日的平均 **dollar volume**（如成交额 amount 的移动平均）；  
- **cap**：市值（用于个别因子，如 #56）；  
- **行业分类**：如 GICS、BICS、申万行业等，用于**行业中性化**（indneutralize）。

### 3.2 行业中性化

部分因子对截面数据按**行业**做中性化：

- **indneutralize(x, g)**：在行业（或子行业）g 内，对 x 做截面去均值，即  
  `x - mean(x within group g)`。  
- 常用分类：sector / industry / subindustry；国内复现常用**申万一级行业**等。

---

## 四、核心函数与运算符

以下为 Alpha 101 公式中**常用函数与运算符**的释义（与论文及常见实现一致）。

### 4.1 时间序列函数（ts_ 前缀）

| 函数 | 含义 |
|------|------|
| **ts_min(x, d)** | 过去 d 日 x 的最小值 |
| **ts_max(x, d)** | 过去 d 日 x 的最大值 |
| **ts_rank(x, d)** | 过去 d 日内，当前 x 值在序列中的**百分比排名**，值域通常为 [0, 1] |
| **ts_argmax(x, d)** | 过去 d 日内 x 达到最大值时的**相对位置**（如 0=当天，1=前 1 天） |
| **ts_argmin(x, d)** | 过去 d 日内 x 达到最小值时的相对位置 |
| **ts_mean(x, d)** | 过去 d 日 x 的均值（部分实现中与 sum/ d 等价） |

### 4.2 截面函数

| 函数 | 含义 |
|------|------|
| **rank(x)** | 按**日期**分组，对股票在截面上的 x 做**升序排名**，常归一化到 [0, 1]（如 pct_rank） |

### 4.3 延迟与差分

| 函数/符号 | 含义 |
|-----------|------|
| **delay(x, d)** | x 在 **d 天前**的值 |
| **delta(x, d)** | 当前 x 减去 d 天前的 x：x(t) - x(t-d) |

### 4.4 统计与缩放

| 函数 | 含义 |
|------|------|
| **correlation(x, y, d)** | 过去 d 日 x 与 y 的**皮尔逊相关系数** |
| **covariance(x, y, d)** | 过去 d 日 x 与 y 的**协方差** |
| **stddev(x, d)** | 过去 d 日 x 的**标准差** |
| **scale(x [, a])** | 对 x 做缩放，使截面 \|x\| 之和为常数 a（默认 a=1） |
| **decay_linear(x, d)** | 过去 d 日的**线性衰减加权平均**（权重 d, d-1, …, 1，再归一化） |

### 4.5 其他

| 函数/符号 | 含义 |
|-----------|------|
| **sign(x)** | 符号函数 |
| **log(x)** | 自然对数 |
| **abs(x)** | 绝对值 |
| **SignedPower(x, a)** | sign(x) * \|x\|^a |
| **product(x, d)** | 过去 d 日 x 的乘积（或按实现定义） |
| **sum(x, d)** | 过去 d 日 x 的和 |
| **min / max** | 最小值 / 最大值（依上下文为截面或时序） |

公式中的 `? :` 为三元运算符：`条件 ? 值1 : 值2`。

---

## 五、因子分类（按实现与数据需求）

### 5.1 按是否含行业信息

| 类型 | 说明 | 因子序号（示例） |
|------|------|------------------|
| **非行业信息因子** | 仅用价量（及可选 cap），入参多为矩阵/面板。 | 1–47, 49–55, 57, 60–62, 64–68, 71–75, 77–79, 81, 83–88, 92, 94–96, 98–99, 101 等 |
| **行业信息因子** | 需要行业分类，做行业中性化；入参常为「表+行业」。 | 48, 56, 58, 59, 63, 67, 69, 70, 76, 79, 80, 82, 87, 89, 90, 91, 93, 97, 100 |

不同平台实现时，行业因子约 19 个，非行业约 82 个（与具体实现有关）。

### 5.2 0 延迟因子（4 个）

以下 3 个因子为「0 延迟」，即假设在**计算日收盘附近**交易：

- **Alpha#48**  
- **Alpha#53**  
- **Alpha#54**

其余多为 1 延迟或更高延迟。

### 5.3 入参需求概览（参考）

非行业因子常见入参组合（按因子序号分组，不同实现可能略有差异）：

- **close**：1, 9, 10, 19, 24, 29, 34, 46, 49, 51 等  
- **open, close**：8, 18, 33, 37, 38 等  
- **vol, open, close**：2, 14 等  
- **vol, open**：3, 6  
- **low**：4  
- **vwap, open, close**：5  
- **vol, close**：7, 12, 13, 17, 21, 30, 39, 43, 45 等  
- **vwap, close**：32, 42, 57, 84  
- **vol, high**：15, 16, 26, 40, 44  
- **open, close, high, low**：20, 54, 101  
- 更多组合见各平台「因子入参一览表」。

行业因子除价量外，还需 **indclass**（及部分需要 **cap**）。

---

## 六、实证性质（报告结论）

WorldQuant 报告及后续复现中，101 因子的典型实证特征如下：

| 维度 | 结论 |
|------|------|
| **持有期** | 平均约 **0.6–6.4 天**，偏中短期。 |
| **因子间相关性** | 平均约 **15.9%**（中位数约 14.3%），相关性较低，适合多因子组合。 |
| **收益与波动** | 因子收益与**波动率**（如日收益标准差）相关性较强。 |
| **换手率** | 因子收益对换手率的依赖不显著。 |

这些结论基于报告中的样本与设定；在 A 股等市场复现时需重新做因子检验与组合测试。

---

## 七、因子逐条详细说明（共 93 条）

本节对**保留的 93 个因子**的**公式、说明与投资逻辑标签**进行逐条说明，整理自 [千山资本 | 预测股票市场的101个alpha因子的解读与总结](http://www.qianshancapital.com/h-nd-329.html)。已剔除在来源解读中被明确标注为过拟合、固定阈值、缺乏依据或逻辑粗糙的 #27、#36、#41、#42、#46、#51、#58、#59。公式中运算符号含义见原报告 A.1 functions and operators（如 [arXiv:1601.00991](https://arxiv.org/ftp/arxiv/papers/1601/1601.00991.pdf)）。

---

### Alpha#1

**公式**：`(rank(Ts_ArgMax(SignedPower(((returns < 0) ? stddev(returns, 20) : close), 2.), 5)) - 0.5)`

**说明**：rank 为按日对所有股票某指标排序（常标准化后均值为 0）。对每只股票过去 5 日，按「收盘价最高」或「下行波动率最高」的一天离当前日的远近排名：下行波动率最高离当前越近、或收盘价最高离当前越近，越值得投资。

**标签**：mean-reversion + momentum

---

### Alpha#2

**公式**：`(-1 * correlation(rank(delta(log(volume), 2)), rank(((close - open) / open)), 6))`

**说明**：对每只股票计算过去 6 日「log(volume) 的 2 日差分」与「当日回报 (close-open)/open」的 rank，再对两列 rank 做相关。正相关越高越不投资，负相关越高越投资。价跌对应放量、或价涨对应缩量时考虑投资；量价齐升或齐跌则不交易。

**标签**：量价理论

---

### Alpha#3

**公式**：`(-1 * correlation(rank(open), rank(volume), 10))`

**说明**：过去 10 日开盘价趋势与当日成交量趋势成正比时不投资，成反比时投资。

**标签**：量价理论

---

### Alpha#4

**公式**：`(-1 * Ts_Rank(rank(low), 9))`

**说明**：Ts_Rank 为时间序列上的排序（仅用最后一天 t-1 的值）。先对所有股票 low 做截面 rank，再对每只股票过去 9 日该 rank 做 Ts_Rank。得到的是 t-1 时 low 在 t-9 内的百分位。若 low 在 t-1 时相对过去变得更便宜（排名下降），则做多。

**标签**：mean-reversion

---

### Alpha#5

**公式**：`(rank((open - (sum(vwap, 10) / 10))) * (-1 * abs(rank((close - vwap)))))`

**说明**：第一部分：t-1 开盘价减去过去 10 日 vwap 均值，差值越大 rank 越高。第二部分：t-1 收盘价减当日 vwap 的 rank 取绝对值后乘 -1。若开盘价远低于过去 10 日均价，且 t-1 收盘价远高于 t-1 的 vwap，则做多。

**标签**：momentum

---

### Alpha#6

**公式**：`(-1 * correlation(open, volume, 10))`

**说明**：过去 10 日开盘价与成交量的相关。开盘价与成交量同升同降则不投资，完全相反则投资。量价理论：涨时众人追则不买，跌时众人抛则考虑买。

**标签**：量价理论

---

### Alpha#7

**公式**：`((adv20 < volume) ? ((-1 * ts_rank(abs(delta(close, 7)), 60)) * sign(delta(close, 7))) : (-1 * 1))`

**说明**：adv20 为过去 20 日平均成交额。若 t-1 成交量大于 adv20，则用 7 日收盘价差在 60 日内的 Ts_Rank 乘符号后取负；否则直接返回 -1。含义：成交量放大且 t-1 价格在近期下跌幅度排名靠前时投资；量价同边不买、量价反走考虑。

**标签**：量价理论

---

### Alpha#8

**公式**：`(-1 * rank(((sum(open, 5) * sum(returns, 5)) - delay((sum(open, 5) * sum(returns, 5)), 10))))`

**说明**：计算 t-5 到 t-1 的「open×returns」类 dollar return 之和，减去 10 日前的同样 5 日 dollar return 之和。若 10 日前的 5 日 dollar return 远高于近期，则投资；若近期 5 日 dollar return 远高于 10 日前，则不投资。

**标签**：mean-reversion

---

### Alpha#9

**公式**：`((0 < ts_min(delta(close, 1), 5)) ? delta(close, 1) : ((ts_max(delta(close, 1), 5) < 0) ? delta(close, 1) : (-1 * delta(close, 1))))`

**说明**：若过去 5 日价差最小值为正（全为正），则取 t-1 价差；若最大值为负（全为负），则取 t-1 价差；若有正有负（震荡），则取 t-1 价差的负值。即：5 日单调上涨则涨得越多越做多；单调下跌则跌得越多越不做多；震荡则跌得越多越做多。

**标签**：momentum + mean-reversion

---

### Alpha#10

**公式**：`rank(((0 < ts_min(delta(close, 1), 4)) ? delta(close, 1) : ((ts_max(delta(close, 1), 4) < 0) ? delta(close, 1) : (-1 * delta(close, 1)))))`

**说明**：与 Alpha#9 逻辑相同，窗口改为 4 日，并对结果做截面 rank。

**标签**：momentum + mean-reversion

---

### Alpha#11

**公式**：`((rank(ts_max((vwap - close), 3)) + rank(ts_min((vwap - close), 3))) * rank(delta(volume, 3)))`

**说明**：前两项为过去 3 日 vwap-close 的最大/最小值的 rank 之和（波动大时和更大），第三项为 t-1 成交量相对 3 日前变化的 rank。波动率高且成交量剧增时更值得投资；成交量暴跌则不投资。

**标签**：量价理论

---

### Alpha#12

**公式**：`(sign(delta(volume, 1)) * (-1 * delta(close, 1)))`

**说明**：t-1 成交量方向与 t-1 收盘价差的反向相乘。涨得多且成交量下降则做多；跌得多且成交量上升则做多。

**标签**：量价理论

---

### Alpha#13

**公式**：`(-1 * rank(covariance(rank(close), rank(volume), 5)))`

**说明**：过去 5 日收盘价 rank 与成交量 rank 的协方差做截面 rank 后取负。正关联不投资，负关联投资。

**标签**：量价理论

---

### Alpha#14

**公式**：`((-1 * rank(delta(returns, 3))) * correlation(open, volume, 10))`

**说明**：t-1 与 t-4 收益率之差乘过去 10 日开盘价与成交量的相关。近期收益推高且量价相反时投资；在量价理论基础上用 return 差值区分强弱。

**标签**：量价理论

---

### Alpha#15

**公式**：`(-1 * sum(rank(correlation(rank(high), rank(volume), 3)), 3))`

**说明**：滚动 3 日计算最高价 rank 与成交量 rank 的相关系数，再对该相关系数做 rank，再对过去 3 日该 rank 求和后取负。rank 加总越低（量价相关低）越可投资；用 3 日 sum 稳固信号。

**标签**：量价理论

---

### Alpha#16

**公式**：`(-1 * rank(covariance(rank(high), rank(volume), 5)))`

**说明**：与 #15 类似，用 covariance（未标准化）引入更多波动信息，窗口 5 日。

**标签**：量价理论

---

### Alpha#17

**公式**：`(((-1 * rank(ts_rank(close, 10))) * rank(delta(delta(close, 1), 1))) * rank(ts_rank((volume / adv20), 5)))`

**说明**：三项相乘取负：10 日收盘价趋势、收盘价二阶差分（加速度）、5 日成交量相对 adv20 的趋势。收盘涨得多、收益变化率大、成交量放大则不投资；收盘跌得多、变化率大、成交量放大则投资。

**标签**：量价理论

---

### Alpha#18

**公式**：`(-1 * rank(((stddev(abs((close - open)), 5) + (close - open)) + correlation(close, open, 10))))`

**说明**：5 日日内价差绝对值标准差 + 日内价差 + 10 日 close 与 open 相关，再做 rank 取负。波动率低、日内价差低、close 与 open 相关低更好。即：日内波动但收盘时波动小、或日内整体偏跌且波动带收窄时投资。

**标签**：mean-reversion

---

### Alpha#19

**公式**：`((-1 * sign(((close - delay(close, 7)) + delta(close, 7)))) * (1 + rank((1 + sum(returns, 250))))`

**说明**：近期 7 日价格变化符号与 250 日收益和的 rank 组合。含义可理解为：过去一年涨得特别好但近期跌得较惨的股票考虑买入。

**标签**：mean-reversion

---

### Alpha#20

**公式**：`(((-1 * rank((open - delay(high, 1)))) * rank((open - delay(close, 1)))) * rank((open - delay(low, 1))))`

**说明**：开盘价减前日最高、收盘、最低。若开盘低于昨日最高且明显高于昨日收盘和最低，则做多。即未突破前高前提下的开盘动量。

**标签**：momentum

---

### Alpha#21

**公式**：`((((sum(close, 8) / 8) + stddev(close, 8)) < (sum(close, 2) / 2)) ? (-1 * 1) : (((sum(close, 2) / 2) < ((sum(close, 8) / 8) - stddev(close, 8))) ? 1 : (((1 < (volume / adv20)) || ((volume / adv20) == 1)) ? 1 : (-1 * 1))))`

**说明**：若 8 日均价+标准差 < 2 日均价则 -1（不投资）；若 8 日均价-标准差 > 2 日均价则 1；否则看 t-1 成交量是否 ≥ adv20，是则 1 否则 -1。即：近两日涨超一个标准差不买，跌超一个标准差买；在标准差内则放量可买。

**标签**：mean-reversion

---

### Alpha#22

**公式**：`(-1 * (delta(correlation(high, volume, 5), 5) * rank(stddev(close, 20))))`

**说明**：最高价与成交量 5 日相关的 5 日变化（量价相关下降则更倾向投资），再乘 20 日收盘价标准差的 rank。量价反向程度增加且波动率大时适合投资。

**标签**：量价理论

---

### Alpha#23

**公式**：`(((sum(high, 20) / 20) < high) ? (-1 * delta(high, 2)) : 0)`

**说明**：若 t-1 最高价高于 20 日均高，则返回 t-1 与 t-3 最高价之差的负值（即近期 high 回落越多越投资）；否则 0。长期 high 处于高位但短期 high 回落时做多。

**标签**：mean-reversion + momentum（长期动量下的短期均值回归）

---

### Alpha#24

**公式**：`((((delta((sum(close, 100) / 100), 100) / delay(close, 100)) < 0.05) || ... ) ? (-1 * (close - ts_min(close, 100))) : (-1 * delta(close, 3)))`

**说明**：若 100 日均价的长期变化率 ≤ 5%，则取收盘与 100 日最低价之差的负值；否则取 3 日收盘价差的负值。长期涨太多则卖出；未超阈值则看 3 日跌得多可买。

**标签**：mean-reversion

---

### Alpha#25

**公式**：`rank(((((-1 * returns) * adv20) * vwap) * (high - close)))`

**说明**：t-1 收益为负时，乘 adv20、vwap、日内(high-close)。收益为负、日内上影线大、流动性好时更有投资价值；即短期亏损+波动+高流动性时预期收复失地。

**标签**：mean-reversion

---

### Alpha#26

**公式**：`(-1 * ts_max(correlation(ts_rank(volume, 5), ts_rank(high, 5), 5), 3))`

**说明**：5 日内成交量与最高价的 Ts_Rank 的 5 日相关，再取 3 日最大值后取负。量价正相关越高越不投资，负相关越高越投资；ts_max(.,3) 增强鲁棒性。

**标签**：量价理论

---

### Alpha#28

**公式**：`scale(((correlation(adv20, low, 5) + ((high + low) / 2)) - close))`

**说明**：将「adv20 与 low 的 5 日相关 + (high+low)/2 - close」做 scale。在波动率/流动性环境下，若收盘价相对偏低可考虑买入。

**标签**：mean-reversion

---

### Alpha#29

**公式**：`(min(product(rank(rank(scale(log(sum(ts_min(rank(rank((-1 * rank(delta((close - 1), 5))))), 2), 1))))), 1), 5) + ts_rank(delay((-1 * returns), 6), 5))`

**说明**：多层 rank/scale/log 选取近期跌得相对更惨的股票，再与 6 日前收益的负值的 Ts_Rank 组合，取 5 日内最小。即选超跌股买入。

**标签**：mean-reversion

---

### Alpha#30

**公式**：`(((1.0 - rank(((sign((close - delay(close, 1))) + sign((delay(close, 1) - delay(close, 2)))) + sign((delay(close, 2) - delay(close, 3)))))) * sum(volume, 5)) / sum(volume, 20))`

**说明**：近 3 日价差符号和的 rank 越小（跌得越多）越好，再乘以 5 日成交量占 20 日成交量的比例。跌得多且近期成交占比大则投资。

**标签**：量价理论

---

### Alpha#31

**公式**：`((rank(rank(rank(decay_linear((-1 * rank(rank(delta(close, 10)))), 10)))) + rank((-1 * delta(close, 3)))) + sign(scale(correlation(adv20, low, 12))))`

**说明**：10 日收盘价差的线性衰减加权 rank（取负）+ 3 日价差 rank（取负）+ adv20 与 low 的 12 日相关 scale 的符号。即：10 日跌、3 日跌、量价反向时做多；decay_linear 刻画长期趋势，rank 表示「相对」、偏回归方向。

**标签**：量价理论 + mean-reversion

---

### Alpha#32

**公式**：`(scale(((sum(close, 7) / 7) - close)) + (20 * scale(correlation(vwap, delay(close, 5), 230))))`

**说明**：7 日均价减 t-1 收盘（收盘远低于 7 日均更好）+ 230 日 vwap 与 5 日前收盘的相关的缩放。若 5 日价格走势与 vwap 高度相关且出现大幅下跌，则预期修复。

**标签**：mean-reversion

---

### Alpha#33

**公式**：`rank((-1 * ((1 - (open / close))^1)))`

**说明**：与当日涨幅 (1 - open/close) 正相关，短期动量。

**标签**：momentum

---

### Alpha#34

**公式**：`rank(((1 - rank((stddev(returns, 2) / stddev(returns, 5)))) + (1 - rank(delta(close, 1)))))`

**说明**：与 2 日/5 日收益波动比成反比、与 1 日价差成反比。即 5 日波动大但近 2 日波动收敛且当日大跌时考虑买入。

**标签**：mean-reversion

---

### Alpha#35

**公式**：`((Ts_Rank(volume, 32) * (1 - Ts_Rank(((close + high) - low), 16))) * (1 - Ts_Rank(returns, 32)))`

**说明**：与 32 日成交量趋势正相关，与 16 日「(close+high)-low」趋势负相关，与 32 日收益趋势负相关。即成交量增加、价格与波动下行、收益下行时投资。

**标签**：量价理论

---

### Alpha#37

**公式**：`(rank(correlation(delay((open - close), 1), close, 200)) + rank((open - close)))`

**说明**：t-2 日开收差与 t-1 收盘的 200 日相关 + t-1 开收差。前一日跌得惨而次日收得好的组合；若当日跌则预测次日涨。

**标签**：mean-reversion

---

### Alpha#38

**公式**：`((-1 * rank(Ts_Rank(close, 10))) * rank((close / open)))`

**说明**：与 10 日收盘价趋势反比、与当日 close/open 正比。前 10 日跌得多且当日有不错涨幅，预测下一日继续涨；类似进入均值回归后的动量信号。

**标签**：mean-reversion

---

### Alpha#39

**公式**：`((-1 * rank((delta(close, 7) * (1 - rank(decay_linear((volume / adv20), 9)))))) * (1 + rank(sum(returns, 250))))`

**说明**：与 7 日价差反比、与 9 日成交量/adv20 的衰减 rank 反比、与 250 日收益和正比。即今年涨得好、近期价跌但成交量未明显放大的股票可投资。

**标签**：量价理论

---

### Alpha#40

**公式**：`((-1 * rank(stddev(high, 10))) * correlation(high, volume, 10))`

**说明**：与 10 日最高价波动率正比、与最高价和成交量相关反比。过去 10 日波动大且价量反向时考虑投资。

**标签**：量价理论

---

### Alpha#43

**公式**：`(ts_rank((volume / adv20), 20) * ts_rank((-1 * delta(close, 7)), 8))`

**说明**：t-1 成交量相对 adv20 突增且 7 日价格大幅下跌时投资。

**标签**：量价理论

---

### Alpha#44

**公式**：`(-1 * correlation(high, rank(volume), 5))`

**说明**：过去 5 日最高价与成交量 rank 的相关，取负。量价理论。

**标签**：量价理论

---

### Alpha#45

**公式**：`(-1 * ((rank((sum(delay(close, 5), 20) / 20)) * correlation(close, volume, 2)) * rank(correlation(sum(close, 5), sum(close, 20), 2))))`

**说明**：与 20 日滚动 5 日滞后收盘均价正比、与 2 日量价相关反比、与 5 日/20 日收盘和的 2 日相关正比。即中长期上涨且不违背量价理论的股票。

**标签**：momentum + 量价理论

---

### Alpha#47

**公式**：`((((rank((1 / close)) * volume) / adv20) * ((high * rank(high - close)) / (sum(high, 5) / 5))) - rank((vwap - delay(vwap, 5))))`

**说明**：close 低、成交量大的更受青睐；日内高价不过高、收盘相对向下、近 5 日偏跌的更受青睐。

**标签**：量价理论

---

### Alpha#48（0 延迟）

**公式**：`(indneutralize(((correlation(delta(close, 1), delta(delay(close, 1), 1), 250) * delta(close, 1)) / close), IndClass.subindustry) / sum(((delta(close, 1) / delay(close, 1))^2), 250))`

**说明**：250 日窗口内当日与昨日收益的相关性乘当日收益/收盘，按子行业中性化后除以收益平方和的归一化。若当日与昨日收益相关高且当日释放高涨幅则投资，偏数据挖掘。

**标签**：momentum

---

### Alpha#49

**公式**：`(((((delay(close, 20) - delay(close, 10)) / 10) - ((delay(close, 10) - close) / 10)) < (-1 * 0.1)) ? 1 : ((-1 * 1) * (close - delay(close, 1))))`

**说明**：若 20~10 日平均跌幅比 10~0 日平均跌幅大 0.1 以上则投资；否则按 t-1 日跌幅（跌越多因子越大）投资。

**标签**：mean-reversion

---

### Alpha#50

**公式**：`(-1 * ts_max(rank(correlation(rank(volume), rank(vwap), 5)), 5))`

**说明**：寻找近期量价分歧最严重的个股投资。

**标签**：量价理论

---

### Alpha#52

**公式**：`((((-1 * ts_min(low, 5)) + delay(ts_min(low, 5), 5)) * rank(((sum(returns, 240) - sum(returns, 20)) / 220))) * ts_rank(volume, 5))`

**说明**：与 5 日最低价反比（越低越好）、与 5 日前 5 日最低正比（之前高）、与 220 日收益平均跌幅正比、与 5 日成交量趋势正比。即之前价高、现在价低、成交量放大。

**标签**：量价理论

---

### Alpha#53（0 延迟）

**公式**：`(-1 * delta((((close - low) - (high - close)) / (close - low)), 9))`

**说明**：与 9 日前相比，close 越接近 low 越值得投资，结合 K 线形态。

**标签**：蜡烛图 + momentum

---

### Alpha#54（0 延迟）

**公式**：`((-1 * ((low - close) * (open^5))) / ((low - high) * (close^5)))`

**说明**：同样基于 close 相对 low 的位置，蜡烛图思路。

**标签**：蜡烛图 + momentum

---

### Alpha#55

**公式**：`(-1 * correlation(rank(((close - ts_min(low, 12)) / (ts_max(high, 12) - ts_min(low, 12)))), rank(volume), 6))`

**说明**：量价关系，价格用 (close-low)/(high-low) 标准化后的 rank 与成交量 rank 的 6 日相关，取负。

**标签**：量价理论

---

### Alpha#56

**公式**：`(0 - (1 * (rank((sum(returns, 10) / sum(sum(returns, 2), 3))) * rank((returns * cap)))))`

**说明**：10 日收益和与重叠 6 日收益和的比（近期涨得多则比值大，因子反比）；再乘收益与市值的 rank。即近期涨得好且偏大盘股时做多。

**标签**：momentum

---

### Alpha#57

**公式**：`(0 - (1 * ((close - vwap) / decay_linear(rank(ts_argmax(close, 30)), 2))))`

**说明**：收盘与 vwap 差越大越不投资；收盘创近期高位越久以前（价格压制时间长）越好。即收盘不佳、长期走低的资产做多。

**标签**：mean-reversion

---

### Alpha#60

**公式**：`(0 - (1 * ((2 * scale(rank(((((close - low) - (high - close)) / (high - low)) * volume)))) - scale(rank(ts_argmax(close, 10))))))`

**说明**：标准化后的 K 线位置×成交量与近期创新高时点的 rank 组合，close 足够低且相对历史趋势偏低时投资，结合蜡烛图与均值回归。

**标签**：蜡烛图 + mean-reversion

---

### Alpha#61

**公式**：`(rank((vwap - ts_min(vwap, 16.1219))) < rank(correlation(vwap, adv180, 17.9282)))`

**说明**：价差 rank 与量价相关 rank 比较；价格低且量价走势相反时可投资。rank 与标量比较在性质上需注意。

**标签**：量价理论

---

### Alpha#62

**公式**：`((rank(correlation(vwap, sum(adv20, 22.4101), 9.91009)) < rank(((rank(open) + rank(open)) < (rank(((high + low) / 2)) + rank(high))))) * -1)`

**说明**：先判断开盘是否相对日内波动偏低，再判断量价相关是否足够低；量价相关低且开盘相对低时投资。

**标签**：量价理论 + 蜡烛图

---

### Alpha#63

**公式**：`((rank(decay_linear(delta(IndNeutralize(close, IndClass.industry), 2.25164), 8.22237)) - rank(decay_linear(correlation(...), 12.2883))) * -1)`

**说明**：行业中性收盘的 8 日衰减价差 rank 减去 vwap/open 加权与 adv180 的衰减相关 rank，取负。跌得多且量升时投资。

**标签**：量价理论

---

### Alpha#64

**公式**：`((rank(correlation(sum(((open * 0.178404) + (low * (1 - 0.178404))), 12.7054), sum(adv120, 12.7054), 16.6208)) < rank(delta(...), 3.69741)) * -1)`

**说明**：价格下跌且量价反比时投资；用 rank 比较表达条件。

**标签**：量价理论

---

### Alpha#65

**公式**：`((rank(correlation(...)) < rank((open - ts_min(open, 13.635)))) * -1)`

**说明**：开盘远低于 13 日最低且符合量价反向时投资。

**标签**：量价理论

---

### Alpha#66

**公式**：`((rank(decay_linear(delta(vwap, 3.51013), 7.23052)) + Ts_Rank(decay_linear(...), 6.72611)) * -1)`

**说明**：投资价格下跌明显、近期 low 创新低的标的。

**标签**：mean-reversion

---

### Alpha#67

**公式**：`((rank((high - ts_min(high, 2.14593)))^rank(correlation(IndNeutralize(vwap, IndClass.sector), IndNeutralize(adv20, IndClass.subindustry), 6.02936))) * -1)`

**说明**：2 日内 high 跌幅大、且量价反走的做多（行业/子行业中性化）。

**标签**：量价理论

---

### Alpha#68

**公式**：`((Ts_Rank(correlation(rank(high), rank(adv15), 8.91644), 13.9333) < rank(delta(...), 1.06157)) * -1)`

**说明**：在价格下跌的股票里选量价反走更明显的给更高分数。

**标签**：量价理论

---

### Alpha#69

**公式**：`((rank(ts_max(delta(IndNeutralize(vwap, IndClass.industry), 2.72412), 4.79344))^Ts_Rank(correlation(...), 9.0615)) * -1)`

**说明**：过去约 5 日行业中性 vwap 涨幅最小的，在其中选量价（close 与 vwap 加权）反比的。

**标签**：量价理论

---

### Alpha#70

**公式**：`((rank(delta(vwap, 1.29456))^Ts_Rank(correlation(IndNeutralize(close, IndClass.industry), adv50, 17.8256), 17.9171)) * -1)`

**说明**：vwap 价差 rank 与行业中性收盘对 adv50 的相关 Ts_Rank；跌得多、量价越反越好。

**标签**：量价理论

---

### Alpha#71

**公式**：`max(Ts_Rank(decay_linear(correlation(Ts_Rank(close, 3.43976), Ts_Rank(adv180, 12.0647), 18.0175), 4.20501), 15.6948), Ts_Rank(decay_linear((rank(((low + open) - (vwap + vwap)))^2), 16.4662), 4.4388))`

**说明**：用 max 在「价格近期相对 vwap 跌得惨」与「量价相关性近期降低」之间做选择；本质仍是价格低、量价相关低时做多。

**标签**：量价理论

---

### Alpha#72

**公式**：`(rank(decay_linear(correlation(((high + low) / 2), adv40, 8.93345), 10.1519)) / rank(decay_linear(correlation(Ts_Rank(vwap, 3.72469), Ts_Rank(volume, 18.5188), 6.86671), 2.95011)))`

**说明**：中期(9 日)高低均价与 adv40 相关 / 短期(约 3 日) vwap 与 volume 的 Ts_Rank 相关。短期量价相关相对长期更小时投资。

**标签**：量价理论（长短期套利）

---

### Alpha#73

**公式**：`(max(rank(decay_linear(delta(vwap, 4.72775), 2.91864)), Ts_Rank(decay_linear((...delta... * -1), 3.33829), 16.7411)) * -1)`

**说明**：比较 vwap 约 5 日价差 rank 与开盘/低价加权价差的 Ts_Rank 反序，取大后反序。跌得厉害且大跌发生得较早（已过去）时投资。

**标签**：mean-reversion

---

### Alpha#74

**公式**：`((rank(correlation(close, sum(adv30, 37.4843), 15.1365)) < rank(correlation(rank(...), rank(volume), 11.4791))) * -1)`

**说明**：长期(约 30 日)量价相关与短期(约 11 日)量价相关比较；短期相对长期下降明显时投资。

**标签**：量价理论（带择时）

---

### Alpha#75

**公式**：`(rank(correlation(vwap, volume, 4.24304)) < rank(correlation(rank(low), rank(adv50), 12.4413)))`

**说明**：4 日量价相关 vs 12 日 low 与 adv50 的 rank 相关；短期量价相关低于长期时投资。

**标签**：量价理论（带择时）

---

### Alpha#76

**公式**：`(max(rank(decay_linear(delta(vwap, 1.24383), 11.8259)), Ts_Rank(decay_linear(Ts_Rank(correlation(IndNeutralize(low, IndClass.sector), adv81, 8.14941), 19.569), 17.1543), 19.383)) * -1)`

**说明**：同样是 max 与 -1 组合，选取量价反走的标的（行业中性化 low）。

**标签**：量价理论

---

### Alpha#77

**公式**：`min(rank(decay_linear(((((high + low) / 2) + high) - (vwap + high)), 20.0451)), rank(decay_linear(correlation(((high + low) / 2), adv40, 3.1614), 5.64125)))`

**说明**：不用 -1，直接用 min；价格与量价相关二者取小，逻辑类似量价理论。

**标签**：量价理论

---

### Alpha#78

**公式**：`(rank(correlation(sum(((low * 0.352233) + (vwap * (1 - 0.352233))), 19.7428), sum(adv40, 19.7428), 6.83313))^rank(correlation(rank(vwap), rank(volume), 5.77492)))`

**说明**：20 日价格和与 adv40 的 7 日相关，指数为 5 日量价 rank 相关；结构较复杂，offset 多。

**标签**：量价理论

---

### Alpha#79

**公式**：`(rank(delta(IndNeutralize(((close * 0.60733) + (open * (1 - 0.60733))), IndClass.sector), 1.23438)) < rank(correlation(Ts_Rank(vwap, 3.60973), Ts_Rank(adv150, 9.18637), 14.6644)))`

**说明**：行业中性化价格跌得多，且量价相反时投资。

**标签**：量价理论

---

### Alpha#80

**公式**：`((rank(Sign(delta(IndNeutralize(((open * 0.868128) + (high * (1 - 0.868128))), IndClass.industry), 4.04545)))^Ts_Rank(correlation(high, adv10, 5.11456), 5.53756)) * -1)`

**说明**：行业中性化价格跌得多、量价关系为负的排前面，再反序得高分。

**标签**：量价理论

---

### Alpha#81

**公式**：`((rank(Log(product(rank((rank(correlation(vwap, sum(adv10, 49.6054), 8.47743))^4)), 14.9655))) < rank(correlation(rank(vwap), rank(volume), 5.07914))) * -1)`

**说明**：长期(约 15 日)量价相关的累积乘积 rank 与短期(5 日)量价 rank 相关比较；短期相关小于长期时投资。

**标签**：量价理论

---

### Alpha#82

**公式**：`(min(rank(decay_linear(delta(open, 1.46063), 14.8717)), Ts_Rank(decay_linear(correlation(IndNeutralize(volume, IndClass.sector), ...open...), 6.92131), 13.4283)) * -1)`

**说明**：15 日开盘价差与 13 日行业调整后量价(volume 与开盘)相关组合。

**标签**：量价理论

---

### Alpha#83

**公式**：`((rank(delay(((high - low) / (sum(close, 5) / 5)), 2)) * rank(rank(volume))) / (((high - low) / (sum(close, 5) / 5)) / (vwap - close)))`

**说明**：与收盘价反比、与成交量正比。

**标签**：量价理论

---

### Alpha#84

**公式**：`SignedPower(Ts_Rank((vwap - ts_max(vwap, 15.3217)), 20.7127), delta(close, 4.96796))`

**说明**：与 t-1 价格相对 15 日前 vwap 的 Ts_Rank 正比、与约 5 日收盘价差正比。

**标签**：momentum

---

### Alpha#85

**公式**：`(rank(correlation(((high * 0.876703) + (close * (1 - 0.876703))), adv30, 9.61331))^rank(correlation(Ts_Rank(((high + low) / 2), 3.70596), Ts_Rank(volume, 10.1595), 7.11408)))`

**说明**：30 日量价相关正比、7 日量价相关反比（指数）。

**标签**：量价理论（择时）

---

### Alpha#86

**公式**：`((Ts_Rank(correlation(close, sum(adv20, 14.7444), 6.00049), 20.4195) < rank(((open + close) - (vwap + open)))) * -1)`

**说明**：6 日量价相关与 (open+close)-(vwap+open) 比较；close、vwap 都偏低时更符合条件。

**标签**：量价理论

---

### Alpha#87

**公式**：`(max(rank(decay_linear(delta(((close * 0.369701) + (vwap * (1 - 0.369701))), 1.91233), 2.65461)), Ts_Rank(decay_linear(abs(correlation(IndNeutralize(adv81, IndClass.industry), close, 13.4132)), 4.89768), 14.4535)) * -1)`

**说明**：选出价格上升比量价相关更突出的，再反序。

**标签**：量价理论

---

### Alpha#88

**公式**：`min(rank(decay_linear(((rank(open) + rank(low)) - (rank(high) + rank(close))), 8.06882)), Ts_Rank(decay_linear(correlation(Ts_Rank(close, 8.44728), Ts_Rank(adv60, 20.6966), 8.01266), 6.65053), 2.61957))`

**说明**：取两者中较小值，不需再反序。

**标签**：量价理论

---

### Alpha#89

**公式**：`(Ts_Rank(decay_linear(correlation(((low * 0.967285) + (low * (1 - 0.967285))), adv10, 6.94279), 5.51607), 3.79744) - Ts_Rank(decay_linear(delta(IndNeutralize(vwap, IndClass.industry), 3.48158), 10.1466), 15.3012))`

**说明**：low 与 adv10 相关（等价于单变量）正比、vwap 行业中性价差反比；用 Ts_Rank 形成时间上的反序。

**标签**：量价理论

---

### Alpha#90

**公式**：`((rank((close - ts_max(close, 4.66719)))^Ts_Rank(correlation(IndNeutralize(adv40, IndClass.subindustry), low, 5.38375), 3.21856)) * -1)`

**说明**：5 日价差正比、量价相关（行业中性 adv40 与 low）反比做指数，再取负。

**标签**：量价理论

---

### Alpha#91

**公式**：`((Ts_Rank(decay_linear(decay_linear(correlation(IndNeutralize(close, IndClass.industry), volume, 9.74928), 16.398), 3.83219), 4.8667) - rank(decay_linear(correlation(vwap, adv30, 4.01303), 2.6809))) * -1)`

**说明**：10 日量价相关与 3 日量价相关之差，Ts_Rank 反序后使短期量价相关下降的得高分。

**标签**：量价理论

---

### Alpha#92

**公式**：`min(Ts_Rank(decay_linear(((((high + low) / 2) + close) < (low + open)), 14.72221), 18.8683), Ts_Rank(decay_linear(correlation(rank(low), rank(adv30), 7.58555), 6.94024), 6.80584))`

**说明**：价格项与量价相关项各做 Ts_Rank 后取小。

**标签**：量价理论

---

### Alpha#93

**公式**：`(Ts_Rank(decay_linear(correlation(IndNeutralize(vwap, IndClass.industry), adv81, 17.4193), 19.848), 7.54455) / rank(decay_linear(delta(((close * 0.524434) + (vwap * (1 - 0.524434))), 2.77377), 16.2664)))`

**说明**：20 日量价相关反序为分子、16 日价格项为分母；量价相关低、价格下跌多时分数高。

**标签**：量价理论

---

### Alpha#94

**公式**：`((rank((vwap - ts_min(open, 12.4105))) < Ts_Rank(correlation(Ts_Rank(vwap, 19.6462), Ts_Rank(adv60, 4.02992), 18.0926), 2.70756)) * -1)`

**说明**：12 日价差与 18 日量价相关 Ts_Rank 比较；量价负相关且价差小时整体分数高。

**标签**：量价理论

---

### Alpha#95

**公式**：`(rank((open - ts_min(open, 12.4105))) < Ts_Rank((rank(correlation(sum(((high + low) / 2), 19.1351), sum(adv40, 19.1351), 12.8742))^5), 11.7584))`

**说明**：12 日开盘价差与 12 日量价相关 Ts_Rank 比较，与 #94 相近。

**标签**：量价理论

---

### Alpha#96

**公式**：`(max(Ts_Rank(decay_linear(correlation(rank(vwap), rank(volume), 3.83878), 4.16783), 8.38151), Ts_Rank(decay_linear(Ts_ArgMax(correlation(...), 12.6556), 14.0365), 13.4143)) * -1)`

**说明**：8 日量价相关与 13 日量价相关各做 Ts_Rank 反序，取大者再反序。

**标签**：量价理论（择时）

---

### Alpha#97

**公式**：`((rank(decay_linear(delta(IndNeutralize(((low * 0.721001) + (vwap * (1 - 0.721001))), IndClass.industry), 3.3705), 20.4523)) - Ts_Rank(decay_linear(Ts_Rank(correlation(...), 18.5925), 15.7152), 6.71659)) * -1)`

**说明**：3 日价差 rank 与 18 日量价相关 Ts_Rank 反序，整体再反序。

**标签**：量价理论

---

### Alpha#98

**公式**：`(rank(decay_linear(correlation(vwap, sum(adv5, 26.4719), 4.58418), 7.18088)) - rank(decay_linear(Ts_Rank(Ts_ArgMin(correlation(rank(open), rank(adv15), 20.8187), 8.62571), 6.95668), 8.07206)))`

**说明**：5 日量价相关与 15 日量价相关 Ts_Rank 反序比较；前者大、后者小则分数高。

**标签**：量价理论

---

### Alpha#99

**公式**：`((rank(correlation(sum(((high + low) / 2), 19.8975), sum(adv60, 19.8975), 8.8136)) < rank(correlation(low, volume, 6.28259))) * -1)`

**说明**：60 日量价相关与 1 日量价相关比较；短期相关更小时投资。

**标签**：量价理论

---

### Alpha#100

**公式**：`(0 - (1 * (((1.5 * scale(indneutralize(indneutralize(rank(((((close - low) - (high - close)) / (high - low)) * volume)), IndClass.subindustry), IndClass.subindustry))) - scale(indneutralize((correlation(close, rank(adv20), 5) - rank(ts_argmin(close, 30))), IndClass.subindustry))) * (volume / adv20))))`

**说明**：通过量×价并做行业双重中性化与 scale，再减去另一项行业中性化 scale，乘 volume/adv20。相当于对「高」与「低」都施加惩罚，综合量价与流动性。

**标签**：量价理论

---

### Alpha#101

**公式**：`((close - open) / (high - low) + 0.001)` 或等价形式

**说明**：日内相对位置（收盘在高低点之间的标准化），类似波动状态下做均值回归。

**标签**：蜡烛图理论

---

## 八、应用与实现参考

### 8.1 使用注意

- **数据频率**：公式按**日频**设计；若用于分钟/小时频，需在逻辑与延迟上做适配。  
- **复权**：close、open 等价格建议使用**复权**数据，returns 与 delay/delta 一致。  
- **缺失值**：窗口前缘会产生 NaN，需统一处理（如只从第 max(window) 日开始有值）。  
- **行业**：行业因子需与本地行业分类（申万、证监会等）对齐；indneutralize 实现需按截面+行业分组去均值。  
- **基准与回测**：单因子需做 IC、分组收益、换手、夏普等检验；多因子组合需再考虑加权、中性化与风控。

### 8.2 参考实现与文档

- **原报告**：Kakushadze, Z. (2016). *101 Formulaic Alphas*. WorldQuant. ([arXiv:1601.00991](https://arxiv.org/ftp/arxiv/papers/1601/1601.00991.pdf)，函数与运算符见 A.1)  
- **千山资本**：[预测股票市场的101个alpha因子的解读与总结](http://www.qianshancapital.com/h-nd-329.html) — 对 101 因子逐条说明、打标签（momentum / mean-reversion / 量价理论 / 蜡烛图等），本文档第七节据此整理。  
- **BigQuant**：Alpha101 因子复现与 SQL 实现、因子分析流程与示例。  
- **JoinQuant / 聚宽**：Alpha101 因子字典与调用说明。  
- **DolphinDB**：wq101alpha 模块，批流一体、入参规范与性能对比。  
- **Python**：GitHub 等处的 alpha101 实现（实现细节与报告可能略有差异，需做正确性校验）。

### 8.3 在本项目中的定位

当前 **Longbridge-Quantitative-Trading** 项目若未内置 Alpha 101 计算模块，可将本文档作为**因子库说明与设计参考**；后续若接入行情与历史 K 线，可据此实现部分或全部因子的计算与回测管线。

---

## 九、小结

| 项目 | 内容 |
|------|------|
| **来源** | WorldQuant《101 Formulaic Alphas》；本文档保留 **93 条** 具一定逻辑或实证基础的因子。 |
| **逻辑** | 均值回归 + 动量；由量价特征组合、排名、时序函数构成。 |
| **数据** | 日频价量（open/close/high/low/volume/vwap/returns），部分用 adv、cap、行业。 |
| **函数** | delay、delta、rank、ts_*、correlation、covariance、scale、decay_linear 等。 |
| **延迟** | 保留的 0 延迟因子为 #48、#53、#54；多数为 1 延迟或更高。 |
| **剔除** | #27、#36、#41、#42、#46、#51、#58、#59（过拟合/固定阈值/缺乏依据/逻辑粗糙）。 |
| **实证** | 持有期约 0.6–6.4 天，因子间相关约 15.9%，收益与波动相关较强。 |

本文档对 Alpha 101 因子库的**作用、构建思路、数据与函数、分类及保留因子逐条说明**做了集中说明，便于在研究与实盘中正确理解与使用该因子集。
