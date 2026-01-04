# TechnicalIndicators 库技术指标详细分析

## 库信息

- **库名**: `technicalindicators`
- **版本**: 3.1.0
- **语言**: TypeScript/JavaScript
- **许可证**: MIT
- **GitHub**: https://github.com/anandanand84/technicalindicators
- **特性**: 零依赖、完整 TypeScript 支持、增量计算、高性能

---

## 一、移动平均类指标 (Moving Averages)

### 1. SMA (Simple Moving Average) - 简单移动平均线

**作用**: 通过计算特定周期内价格的算术平均值，平滑价格波动，识别趋势方向。

**用途**:
- 识别支撑和阻力位
- 确定长期趋势方向
- 与价格交叉产生买卖信号
- 多条不同周期的 SMA 交叉策略（金叉/死叉）

**计算公式**:
```
SMA = (P₁ + P₂ + ... + Pₙ) / n

其中：
- Pᵢ = 第 i 个周期的价格（通常为收盘价）
- n = 周期长度
```

**参数**:
- `values`: number[] - 价格数组
- `period`: number - 周期（常用：5, 10, 20, 50, 100, 200）

**特点**:
- 所有价格权重相等
- 对价格变化反应较慢
- 滞后性强，适合长期趋势
- 计算简单，易于理解

**使用示例**:
```typescript
import { SMA } from 'technicalindicators';

const sma = SMA.calculate({
  values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  period: 5
});
// 结果: [3, 4, 5, 6, 7, 8]
```

---

### 2. WMA (Weighted Moving Average) - 加权移动平均线

**作用**: 对近期价格赋予更高的权重，使指标对价格变化更加敏感。

**用途**:
- 短期趋势识别
- 价格反转信号
- 减少滞后性
- 与 SMA 或 EMA 组合使用

**计算公式**:
```
WMA = (P₁×1 + P₂×2 + ... + Pₙ×n) / (1 + 2 + ... + n)
    = (P₁×1 + P₂×2 + ... + Pₙ×n) / (n×(n+1)/2)

其中：
- Pᵢ = 第 i 个周期的价格（最近的价格权重最高）
- n = 周期长度
- 权重递增：最早的价格权重为 1，最新的价格权重为 n
```

**参数**:
- `values`: number[] - 价格数组
- `period`: number - 周期（常用：5, 10, 20）

**特点**:
- 线性递增权重
- 对价格变化反应比 SMA 快，比 EMA 慢
- 减少了滞后性
- 平滑程度介于 SMA 和 EMA 之间

**使用示例**:
```typescript
import { WMA } from 'technicalindicators';

const wma = WMA.calculate({
  values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  period: 5
});
```

---

### 3. WEMA (Wilder's Smoothing / Smoothed Moving Average) - 威尔德平滑移动平均线

**作用**: 使用 J. Welles Wilder 开发的特殊平滑方法，提供更平滑的移动平均线。

**用途**:
- RSI、ATR 等 Wilder 指标的基础计算
- 长期趋势分析
- 平滑价格噪音
- 降低假信号

**计算公式**:
```
WEMA₁ = SMA(n)  // 第一个值使用简单移动平均
WEMAₜ = (Pₜ × α) + (WEMAₜ₋₁ × (1 - α))

其中：
- Pₜ = 当前价格
- WEMAₜ₋₁ = 前一个 WEMA 值
- α = 1/n（平滑系数）
- n = 周期长度
```

**参数**:
- `values`: number[] - 价格数组
- `period`: number - 周期（常用：14 用于 RSI 和 ATR）

**特点**:
- 平滑系数固定为 1/周期
- 比 EMA 更平滑（EMA 的平滑系数为 2/(周期+1)）
- 对历史数据保留更多权重
- Wilder 指标家族的基础

**对比**:
```
WEMA α = 1/14 ≈ 0.0714
EMA α = 2/15 ≈ 0.1333
EMA 对新价格的反应约为 WEMA 的 1.87 倍
```

**使用示例**:
```typescript
import { WEMA } from 'technicalindicators';

const wema = WEMA.calculate({
  values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  period: 5
});
```

---

## 二、振荡器类指标 (Oscillators)

### 1. StochasticRSI (StochRSI) - 随机相对强弱指标

**作用**: 将随机指标的概念应用于 RSI，衡量 RSI 在其自身高低范围内的位置。

**用途**:
- 识别 RSI 的超买超卖状态
- 提供比 RSI 更敏感的信号
- 捕捉短期价格反转
- 确认趋势动量

**计算公式**:
```
第一步：计算 RSI (周期 n₁)
RSI = ... (标准 RSI 计算)

第二步：计算 StochRSI
StochRSI = (RSI - RSI最低值) / (RSI最高值 - RSI最低值)

其中：
- RSI最低值 = n₂ 周期内 RSI 的最小值
- RSI最高值 = n₂ 周期内 RSI 的最大值
- n₁ = RSI 周期（常用 14）
- n₂ = Stochastic 周期（常用 14）

第三步：计算 K 和 D 线（可选）
%K = SMA(StochRSI, 3)  // 快线
%D = SMA(%K, 3)        // 慢线
```

**参数**:
- `values`: number[] - 价格数组
- `rsiPeriod`: number - RSI 周期（默认 14）
- `stochasticPeriod`: number - Stochastic 周期（默认 14）
- `kPeriod`: number - K 线平滑周期（默认 3）
- `dPeriod`: number - D 线平滑周期（默认 3）

**数值范围**: 0-1 (或 0-100)

**交易信号**:
- StochRSI > 0.8: 超买区域，考虑卖出
- StochRSI < 0.2: 超卖区域，考虑买入
- K 线向上穿越 D 线: 买入信号
- K 线向下穿越 D 线: 卖出信号

**特点**:
- 比 RSI 更敏感，波动更大
- 更频繁地进入超买超卖区域
- 适合震荡市场
- 容易产生假信号，需结合其他指标

**使用示例**:
```typescript
import { StochasticRSI } from 'technicalindicators';

const stochRSI = StochasticRSI.calculate({
  values: [/* 价格数组 */],
  rsiPeriod: 14,
  stochasticPeriod: 14,
  kPeriod: 3,
  dPeriod: 3
});
```

---

### 2. WilliamsR (W%R) - 威廉指标

**作用**: 衡量收盘价在特定周期内高低区间的相对位置，用于识别超买超卖状态。

**用途**:
- 识别超买超卖区域
- 价格反转信号
- 确认趋势强度
- 背离分析

**计算公式**:
```
%R = ((最高价 - 收盘价) / (最高价 - 最低价)) × (-100)

其中：
- 最高价 = n 周期内的最高价
- 最低价 = n 周期内的最低价
- 收盘价 = 当前周期的收盘价
- n = 周期长度（常用 14）

等价形式：
%R = -100 × (1 - (收盘价 - 最低价) / (最高价 - 最低价))
%R = -100 × (1 - FastK%)  // FastK% 是未平滑的随机指标 K 值
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `period`: number - 周期（常用 14）

**数值范围**: -100 到 0

**交易信号**:
- %R > -20: 超买区域，考虑卖出
- %R < -80: 超卖区域，考虑买入
- %R 从超卖区域向上突破 -80: 买入信号
- %R 从超买区域向下突破 -20: 卖出信号
- 背离：价格创新高但 %R 未创新高（看跌背离）

**特点**:
- 与快速随机指标 %K 呈镜像关系
- 对价格变化非常敏感
- 在趋势市场中经常处于极值区域
- 需要结合趋势指标使用

**与 Stochastic 的关系**:
```
%R = FastK% - 100
FastK% = (%R + 100)
```

**使用示例**:
```typescript
import { WilliamsR } from 'technicalindicators';

const williamsR = WilliamsR.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  period: 14
});
```

---

### 3. CCI (Commodity Channel Index) - 商品通道指标

**作用**: 衡量价格偏离其统计平均值的程度，识别超买超卖和趋势强度。

**用途**:
- 识别超买超卖区域
- 趋势反转信号
- 趋势强度确认
- 背离分析

**计算公式**:
```
第一步：计算典型价格 (Typical Price)
TP = (最高价 + 最低价 + 收盘价) / 3

第二步：计算典型价格的简单移动平均 (SMA)
SMATP = SMA(TP, n)

第三步：计算平均偏差 (Mean Deviation)
MD = Σ|TPᵢ - SMATP| / n

第四步：计算 CCI
CCI = (TP - SMATP) / (0.015 × MD)

其中：
- n = 周期长度（常用 20）
- 0.015 = 常数，使约 70-80% 的 CCI 值落在 -100 到 +100 之间
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `period`: number - 周期（常用 20）

**数值范围**: 无限制（理论上）

**交易信号**:
- CCI > +100: 超买区域，价格异常强势
- CCI < -100: 超卖区域，价格异常弱势
- CCI 从下向上突破 +100: 强势买入信号
- CCI 从上向下跌破 -100: 强势卖出信号
- CCI 回归 0 附近: 趋势减弱

**特点**:
- 无上下限约束
- 可以长期处于超买超卖区域
- 在强趋势中表现优异
- 常用于期货和商品市场

**使用示例**:
```typescript
import { CCI } from 'technicalindicators';

const cci = CCI.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  period: 20
});
```

---

### 4. AwesomeOscillator (AO) - 动量振荡器

**作用**: 通过比较短期和长期的市场动量，识别趋势变化和动量强度。

**用途**:
- 识别趋势反转
- 确认趋势强度
- 动量变化信号
- 背离分析

**计算公式**:
```
第一步：计算中位数价格 (Median Price)
MP = (最高价 + 最低价) / 2

第二步：计算 AO
AO = SMA(MP, 5) - SMA(MP, 34)

其中：
- SMA(MP, 5) = 5 周期中位数价格的简单移动平均
- SMA(MP, 34) = 34 周期中位数价格的简单移动平均
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `fastPeriod`: number - 快速周期（默认 5）
- `slowPeriod`: number - 慢速周期（默认 34）

**交易信号**:
- AO > 0: 短期动量强于长期，看涨
- AO < 0: 短期动量弱于长期，看跌
- AO 穿越零轴: 趋势反转信号
- 碟形信号 (Saucer): 三根柱连续变化（看涨/看跌碟形）
- 双峰信号 (Twin Peaks): 两个峰值确认反转

**特点**:
- Bill Williams 开发的指标
- 使用中位数价格而非收盘价
- 柱状图显示，颜色区分涨跌
- 简单直观，适合初学者

**碟形信号**:
```
看涨碟形：三根红色柱（负值），中间柱最低
看跌碟形：三根绿色柱（正值），中间柱最高
```

**使用示例**:
```typescript
import { AwesomeOscillator } from 'technicalindicators';

const ao = AwesomeOscillator.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  fastPeriod: 5,
  slowPeriod: 34
});
```

---

### 5. TRIX (Triple Exponentially Smoothed Average) - 三重指数平滑平均线

**作用**: 通过对价格进行三次 EMA 平滑，过滤短期噪音，识别长期趋势。

**用途**:
- 识别长期趋势
- 过滤市场噪音
- 趋势反转信号
- 背离分析

**计算公式**:
```
第一步：计算第一次 EMA
EMA1 = EMA(价格, n)

第二步：计算第二次 EMA
EMA2 = EMA(EMA1, n)

第三步：计算第三次 EMA
EMA3 = EMA(EMA2, n)

第四步：计算 TRIX
TRIX = ((EMA3 - 前一个EMA3) / 前一个EMA3) × 10000

简化形式：
TRIX = ROC(EMA3, 1) × 100

其中：
- n = 周期长度（常用 15）
- ROC = Rate of Change（变化率）
- × 10000 或 × 100 是为了使数值更易读
```

**参数**:
- `values`: number[] - 价格数组
- `period`: number - EMA 周期（常用 15）

**交易信号**:
- TRIX > 0: 上升趋势
- TRIX < 0: 下降趋势
- TRIX 穿越零轴: 趋势反转信号
- TRIX 与信号线交叉: 买卖信号
- 背离：价格与 TRIX 方向不一致

**特点**:
- 三次平滑后滞后性很强
- 极大减少假信号
- 适合长期趋势交易
- 不适合短期交易

**信号线**:
```
Signal = EMA(TRIX, 9)
TRIX 向上穿越 Signal: 买入
TRIX 向下穿越 Signal: 卖出
```

**使用示例**:
```typescript
import { TRIX } from 'technicalindicators';

const trix = TRIX.calculate({
  values: [/* 价格数组 */],
  period: 15
});
```

---

## 三、动量类指标 (Momentum)

### 1. ROC (Rate of Change) - 变化率指标

**作用**: 衡量价格在特定周期内的变化速度和幅度，识别动量强度。

**用途**:
- 衡量价格动量
- 识别超买超卖
- 趋势强度确认
- 背离分析

**计算公式**:
```
ROC = ((当前价格 - N周期前价格) / N周期前价格) × 100

其中：
- N = 周期长度（常用 9, 12, 25）

等价形式：
ROC = ((Pₜ / Pₜ₋ₙ) - 1) × 100
```

**参数**:
- `values`: number[] - 价格数组
- `period`: number - 周期（常用 12）

**数值范围**: 无限制

**交易信号**:
- ROC > 0: 价格上涨，正动量
- ROC < 0: 价格下跌，负动量
- ROC 穿越零轴: 趋势反转信号
- ROC 极端值: 超买超卖（需根据历史数据确定阈值）
- 背离：价格创新高但 ROC 未创新高

**特点**:
- 振荡器类型指标
- 无固定上下限
- 对价格变化非常敏感
- 领先指标

**使用示例**:
```typescript
import { ROC } from 'technicalindicators';

const roc = ROC.calculate({
  values: [/* 价格数组 */],
  period: 12
});
```

---

### 2. KST (Know Sure Thing) - 确知指标

**作用**: 通过组合多个不同周期的 ROC，提供综合的动量信号，平滑短期波动。

**用途**:
- 综合动量分析
- 识别长期趋势变化
- 减少假信号
- 趋势确认

**计算公式**:
```
KST = (RCMA1 × 1) + (RCMA2 × 2) + (RCMA3 × 3) + (RCMA4 × 4)

其中：
RCMA1 = SMA(ROC(10), 10)  // 短期
RCMA2 = SMA(ROC(15), 10)  // 中短期
RCMA3 = SMA(ROC(20), 10)  // 中长期
RCMA4 = SMA(ROC(30), 15)  // 长期

信号线：
Signal = SMA(KST, 9)

默认参数（可自定义）：
- ROC 周期: 10, 15, 20, 30
- SMA 周期: 10, 10, 10, 15
- 权重: 1, 2, 3, 4
```

**参数**:
- `values`: number[] - 价格数组
- `ROCPer1, ROCPer2, ROCPer3, ROCPer4`: ROC 周期
- `SMAROCPer1, SMAROCPer2, SMAROCPer3, SMAROCPer4`: SMA 周期
- `signalPeriod`: 信号线周期（默认 9）

**交易信号**:
- KST 向上穿越信号线: 买入信号
- KST 向下穿越信号线: 卖出信号
- KST 穿越零轴: 趋势变化
- 背离: 价格与 KST 方向不一致

**特点**:
- Martin Pring 开发
- 综合多个时间框架
- 平滑性好，假信号少
- 适合中长期趋势交易

**使用示例**:
```typescript
import { KST } from 'technicalindicators';

const kst = KST.calculate({
  values: [/* 价格数组 */],
  ROCPer1: 10, ROCPer2: 15, ROCPer3: 20, ROCPer4: 30,
  SMAROCPer1: 10, SMAROCPer2: 10, SMAROCPer3: 10, SMAROCPer4: 15,
  signalPeriod: 9
});
```

---

### 3. PSAR (Parabolic Stop and Reverse) - 抛物线转向指标

**作用**: 提供动态的止损点和趋势反转信号，随趋势发展自动调整。

**用途**:
- 设置动态止损点
- 识别趋势反转
- 趋势跟踪
- 退出信号

**计算公式**:
```
上升趋势：
PSARₜ = PSARₜ₋₁ + AF × (EP - PSARₜ₋₁)

下降趋势：
PSARₜ = PSARₜ₋₁ - AF × (PSARₜ₋₁ - EP)

其中：
- PSAR = 抛物线 SAR 值
- EP = Extreme Point（极值点）
  - 上升趋势：周期内最高价
  - 下降趋势：周期内最低价
- AF = Acceleration Factor（加速因子）
  - 初始值：0.02
  - 每次 EP 更新，AF 增加 0.02
  - 最大值：0.20

趋势反转条件：
- 上升趋势中，价格跌破 PSAR: 转为下降趋势
- 下降趋势中，价格突破 PSAR: 转为上升趋势
- 反转时，AF 重置为 0.02
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `step`: number - AF 步长（默认 0.02）
- `max`: number - AF 最大值（默认 0.20）

**交易信号**:
- PSAR 在价格下方: 上升趋势，持有多头
- PSAR 在价格上方: 下降趋势，持有空头
- 价格突破 PSAR: 趋势反转，平仓并反向开仓

**特点**:
- J. Welles Wilder 开发
- 抛物线形状，加速跟随趋势
- 始终在场内，适合趋势市场
- 在震荡市场中会频繁反转

**使用示例**:
```typescript
import { PSAR } from 'technicalindicators';

const psar = PSAR.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  step: 0.02,
  max: 0.2
});
```

---

## 四、波动率类指标 (Volatility)

### 1. ATR (Average True Range) - 平均真实波幅

**作用**: 衡量市场波动性的大小，不指示方向，用于评估价格波动幅度。

**用途**:
- 评估市场波动性
- 设置止损距离
- 调整仓位大小
- 识别突破的有效性

**计算公式**:
```
第一步：计算真实波幅 (True Range, TR)
TR = max(以下三者):
  1. 最高价 - 最低价
  2. |最高价 - 前收盘价|
  3. |最低价 - 前收盘价|

第二步：计算 ATR（使用 Wilder 平滑法）
ATR₁ = SMA(TR, n)  // 第一个值
ATRₜ = ((ATRₜ₋₁ × (n-1)) + TRₜ) / n  // 后续值

等价形式（EMA 风格）：
ATRₜ = ATRₜ₋₁ + (1/n) × (TRₜ - ATRₜ₋₁)

其中：
- n = 周期长度（常用 14）
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `period`: number - 周期（默认 14）

**使用场景**:

1. **动态止损**:
   ```
   多头止损 = 入场价 - (2 × ATR)
   空头止损 = 入场价 + (2 × ATR)
   ```

2. **仓位管理**:
   ```
   仓位大小 = 风险金额 / (ATR × 合约乘数)
   ```

3. **突破确认**:
   ```
   有效突破 = 突破幅度 > 1.5 × ATR
   ```

4. **波动性判断**:
   - ATR 上升: 波动性增加，可能趋势加强
   - ATR 下降: 波动性减少,可能进入整理

**特点**:
- J. Welles Wilder 开发
- 绝对值指标，无方向性
- 使用 Wilder 平滑法
- 适应不同价格水平的资产

**使用示例**:
```typescript
import { ATR } from 'technicalindicators';

const atr = ATR.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  period: 14
});
```

---

### 2. BollingerBands (BB) - 布林带

**作用**: 通过标准差创建价格通道，识别价格的相对高低和波动性变化。

**用途**:
- 识别超买超卖区域
- 衡量价格波动性
- 趋势强度判断
- 突破交易策略

**计算公式**:
```
中轨 (Middle Band) = SMA(收盘价, n)
上轨 (Upper Band) = 中轨 + (k × σ)
下轨 (Lower Band) = 中轨 - (k × σ)

其中：
- n = 周期长度（常用 20）
- k = 标准差倍数（常用 2）
- σ = 标准差 = √(Σ(价格 - SMA)² / n)

百分比位置 (Percent B, %B):
%B = (收盘价 - 下轨) / (上轨 - 下轨)

带宽 (Bandwidth):
BandWidth = (上轨 - 下轨) / 中轨
```

**参数**:
- `values`: number[] - 收盘价数组
- `period`: number - SMA 周期（默认 20）
- `stdDev`: number - 标准差倍数（默认 2）

**输出**:
- `upper`: 上轨
- `middle`: 中轨
- `lower`: 下轨
- `pb`: %B 值

**交易信号**:

1. **均值回归策略**:
   - 价格触及上轨: 超买，考虑卖出
   - 价格触及下轨: 超卖，考虑买入
   - 价格回归中轨: 趋势减弱

2. **突破策略**:
   - 收盘价突破上轨: 强势信号（需确认）
   - 收盘价跌破下轨: 弱势信号（需确认）

3. **波动性判断**:
   - 带宽收窄 (Squeeze): 低波动，可能即将突破
   - 带宽扩张 (Expansion): 高波动，趋势可能加强

4. **%B 信号**:
   - %B > 1: 价格在上轨之上
   - %B < 0: 价格在下轨之下
   - %B = 0.5: 价格在中轨

**特点**:
- John Bollinger 开发
- 自适应波动性通道
- 包含约 95% 的价格波动（2σ）
- 适合震荡和趋势市场

**使用示例**:
```typescript
import { BollingerBands } from 'technicalindicators';

const bb = BollingerBands.calculate({
  values: [/* 收盘价数组 */],
  period: 20,
  stdDev: 2
});
// 输出: [{ upper, middle, lower, pb }, ...]
```

---

### 3. KeltnerChannels - 肯特纳通道

**作用**: 基于 ATR 的价格通道，识别趋势和突破信号。

**用途**:
- 趋势识别
- 突破信号
- 动态支撑阻力
- 与布林带结合使用

**计算公式**:
```
中线 (Middle Line) = EMA(收盘价, n)
上轨 (Upper Band) = 中线 + (m × ATR(p))
下轨 (Lower Band) = 中线 - (m × ATR(p))

其中：
- n = EMA 周期（常用 20）
- m = ATR 倍数（常用 2）
- p = ATR 周期（常用 10 或 14）
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `period`: number - EMA 周期（默认 20）
- `atrPeriod`: number - ATR 周期（默认 10）
- `multiplier`: number - ATR 倍数（默认 2）

**输出**:
- `upper`: 上轨
- `middle`: 中线
- `lower`: 下轨

**交易信号**:
- 价格突破上轨: 买入信号
- 价格跌破下轨: 卖出信号
- 价格在通道内: 趋势延续
- 通道扩张: 波动性增加

**与布林带的区别**:
```
布林带：基于标准差，统计学方法
肯特纳通道：基于 ATR，波动性方法

结合使用：
- 布林带在肯特纳通道内: 低波动
- 布林带突破肯特纳通道: 高波动突破
```

**特点**:
- Chester Keltner 开发
- 基于真实波幅
- 对价格跳空更敏感
- 适合趋势交易

**使用示例**:
```typescript
import { KeltnerChannels } from 'technicalindicators';

const keltner = KeltnerChannels.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  period: 20,
  atrPeriod: 10,
  multiplier: 2
});
```

---

### 4. ChandelierExit - 吊灯止损

**作用**: 基于 ATR 的动态止损指标，随趋势调整止损位置。

**用途**:
- 设置动态止损
- 趋势跟踪
- 保护利润
- 退出信号

**计算公式**:
```
多头止损 (Long Exit):
Stop = n周期最高价 - (m × ATR(p))

空头止损 (Short Exit):
Stop = n周期最低价 + (m × ATR(p))

其中：
- n = 回看周期（常用 22）
- m = ATR 倍数（常用 3）
- p = ATR 周期（常用 22）
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `period`: number - 回看周期（默认 22）
- `multiplier`: number - ATR 倍数（默认 3）

**输出**:
- `exitLong`: 多头止损价
- `exitShort`: 空头止损价

**交易信号**:
- 多头持仓，收盘价跌破 exitLong: 平仓
- 空头持仓，收盘价升破 exitShort: 平仓

**特点**:
- Charles Le Beau 开发
- 基于 ATR 的波动性止损
- 自动调整止损距离
- 给予趋势足够空间

**使用示例**:
```typescript
import { ChandelierExit } from 'technicalindicators';

const chandelier = ChandelierExit.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  period: 22,
  multiplier: 3
});
```

---

## 五、成交量类指标 (Volume)

### 1. ADL (Accumulation Distribution Line) - 累积/派发线

**作用**: 通过价格和成交量的关系，评估资金流入流出，确认趋势强度。

**用途**:
- 资金流向分析
- 趋势确认
- 背离分析
- 识别机构行为

**计算公式**:
```
第一步：计算资金流量乘数 (Money Flow Multiplier)
MFM = ((收盘价 - 最低价) - (最高价 - 收盘价)) / (最高价 - 最低价)

简化：
MFM = (2 × 收盘价 - 最高价 - 最低价) / (最高价 - 最低价)

第二步：计算资金流量成交量 (Money Flow Volume)
MFV = MFM × 成交量

第三步：计算 ADL（累积）
ADL = 前一个ADL + MFV
ADL₁ = MFV₁  // 第一个值

其中：
- MFM 范围: -1 到 +1
  - 收盘在高点: MFM = +1
  - 收盘在中点: MFM = 0
  - 收盘在低点: MFM = -1
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `volume`: number[] - 成交量数组

**交易信号**:
- ADL 上升 + 价格上涨: 上升趋势确认
- ADL 下降 + 价格下跌: 下降趋势确认
- 看涨背离: 价格创新低，ADL 未创新低
- 看跌背离: 价格创新高，ADL 未创新高

**特点**:
- Marc Chaikin 开发
- 累积指标，持续累加
- 关注收盘价在区间的位置
- 结合价格和成交量

**使用示例**:
```typescript
import { ADL } from 'technicalindicators';

const adl = ADL.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  volume: [/* 成交量数组 */]
});
```

---

### 2. OBV (On Balance Volume) - 能量潮

**作用**: 通过累积成交量变化，反映资金流入流出，确认价格趋势。

**用途**:
- 趋势确认
- 背离分析
- 突破确认
- 资金流向判断

**计算公式**:
```
如果 收盘价ₜ > 收盘价ₜ₋₁:
  OBVₜ = OBVₜ₋₁ + 成交量ₜ  // 上涨日，成交量为正

如果 收盘价ₜ < 收盘价ₜ₋₁:
  OBVₜ = OBVₜ₋₁ - 成交量ₜ  // 下跌日，成交量为负

如果 收盘价ₜ = 收盘价ₜ₋₁:
  OBVₜ = OBVₜ₋₁  // 平盘，成交量不计

初始值：
OBV₀ = 0 或 成交量₀
```

**参数**:
- `close`: number[] - 收盘价数组
- `volume`: number[] - 成交量数组

**交易信号**:
- OBV 上升 + 价格上涨: 上升趋势确认
- OBV 下降 + 价格下跌: 下降趋势确认
- 看涨背离: 价格创新低，OBV 上升
- 看跌背离: 价格创新高，OBV 下降
- OBV 突破: 先于价格突破，领先信号

**特点**:
- Joseph Granville 开发
- 最简单的成交量指标
- 累积指标
- 领先于价格

**OBV 趋势判断**:
```
OBV 趋势上升：多方控盘
OBV 趋势下降：空方控盘
OBV 横盘：蓄势待发
```

**使用示例**:
```typescript
import { OBV } from 'technicalindicators';

const obv = OBV.calculate({
  close: [/* 收盘价数组 */],
  volume: [/* 成交量数组 */]
});
```

---

### 3. VWAP (Volume Weighted Average Price) - 成交量加权平均价

**作用**: 计算考虑成交量的平均价格，作为日内交易的重要基准价。

**用途**:
- 日内交易基准价
- 机构交易参考
- 价格公允性判断
- 支撑阻力位

**计算公式**:
```
第一步：计算典型价格 (Typical Price)
TP = (最高价 + 最低价 + 收盘价) / 3

第二步：计算 VWAP
VWAP = Σ(TP × 成交量) / Σ成交量

日内 VWAP（从开盘到当前时刻）:
VWAPₜ = (TP₁×V₁ + TP₂×V₂ + ... + TPₜ×Vₜ) / (V₁ + V₂ + ... + Vₜ)

增量计算：
VWAPₜ = (VWAPₜ₋₁ × 累积成交量ₜ₋₁ + TPₜ × Vₜ) / 累积成交量ₜ
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `volume`: number[] - 成交量数组

**交易信号**:
- 价格 > VWAP: 多方强势，考虑买入
- 价格 < VWAP: 空方强势，考虑卖出
- 价格回归 VWAP: 均值回归机会
- VWAP 作为支撑/阻力位

**特点**:
- 日内指标，每日重置
- 机构常用基准
- 考虑成交量权重
- 动态支撑阻力

**使用场景**:
```
机构执行：以优于 VWAP 的价格成交为目标
日内交易者：VWAP 上方做多，下方做空
算法交易：VWAP 算法确保大单不影响市场
```

**使用示例**:
```typescript
import { VWAP } from 'technicalindicators';

const vwap = VWAP.calculate({
  high: [/* 日内最高价数组 */],
  low: [/* 日内最低价数组 */],
  close: [/* 日内收盘价数组 */],
  volume: [/* 日内成交量数组 */]
});
```

---

### 4. VolumeProfile - 成交量分布

**作用**: 显示不同价格区间的成交量分布，识别关键支撑阻力位。

**用途**:
- 识别价值区域 (Value Area)
- 确定支撑阻力位
- 分析市场结构
- 识别高成交量节点 (HVN) 和低成交量节点 (LVN)

**计算方法**:
```
第一步：划分价格区间
将价格范围分为 N 个区间（例如 24 或 48 个）

第二步：统计每个价格区间的成交量
对于每个K线，根据其价格范围，将成交量分配到相应区间

第三步：计算关键指标
- POC (Point of Control): 成交量最大的价格区间
- Value Area: 包含 70% 成交量的价格区间
  - VAH (Value Area High): 价值区域上限
  - VAL (Value Area Low): 价值区域下限
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `volume`: number[] - 成交量数组
- `noOfBars`: number - 价格区间数量（默认 24）

**交易信号**:
- POC: 强支撑/阻力位
- VAH/VAL: 价值区域边界
- HVN (高成交量节点): 强支撑/阻力
- LVN (低成交量节点): 弱支撑/阻力，容易快速穿越

**特点**:
- 市场结构分析工具
- 显示市场共识价格
- 横向柱状图显示
- 适合日内和波段交易

**使用示例**:
```typescript
import { VolumeProfile } from 'technicalindicators';

const vp = VolumeProfile.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  volume: [/* 成交量数组 */],
  noOfBars: 24
});
```

---

### 5. ForceIndex - 力度指标

**作用**: 通过价格变化和成交量的乘积，衡量趋势的力度和可持续性。

**用途**:
- 衡量趋势力度
- 确认突破有效性
- 识别背离
- 趋势强度分析

**计算公式**:
```
第一步：计算原始力度指数
FI = (收盘价 - 前收盘价) × 成交量

第二步：平滑处理（可选）
FI(1) = 原始力度指数
FI(13) = EMA(FI, 13)  // 短期
FI(100) = EMA(FI, 100)  // 长期

其中：
- 正值：多方力度强
- 负值：空方力度强
- 数值大小：力度强弱
```

**参数**:
- `close`: number[] - 收盘价数组
- `volume`: number[] - 成交量数组
- `period`: number - EMA 平滑周期（可选）

**交易信号**:

1. **单日力度指数（未平滑）**:
   - 极端正值：强烈买入压力
   - 极端负值：强烈卖出压力

2. **13 日力度指数**:
   - 穿越零轴：短期趋势变化
   - 背离：反转信号

3. **100 日力度指数**:
   - 长期趋势确认
   - 与价格背离：重要反转信号

**特点**:
- Alexander Elder 开发
- 结合价格和成交量
- 振荡器类型
- 可多周期分析

**使用示例**:
```typescript
import { ForceIndex } from 'technicalindicators';

const fi = ForceIndex.calculate({
  close: [/* 收盘价数组 */],
  volume: [/* 成交量数组 */],
  period: 13  // EMA 平滑周期
});
```

---

## 六、方向性指标 (Directional Movement)

### 1. ADX (Average Directional Index) - 平均趋向指标

**作用**: 衡量趋势的强度（不指示方向），帮助判断市场是处于趋势还是震荡状态。

**用途**:
- 判断趋势强度
- 区分趋势市和震荡市
- 确认趋势开始或结束
- 与方向指标结合判断趋势方向

**计算公式**:
```
第一步：计算方向移动 (Directional Movement)
+DM = 当前最高价 - 前最高价（如果 > 0 且 > -DM，否则为 0）
-DM = 前最低价 - 当前最低价（如果 > 0 且 > +DM，否则为 0）

第二步：计算真实波幅 (True Range)
TR = max(最高价-最低价, |最高价-前收盘价|, |最低价-前收盘价|)

第三步：计算平滑后的 DM 和 TR（使用 Wilder 平滑法）
+DM(n) = Wilder平滑(+DM, n)
-DM(n) = Wilder平滑(-DM, n)
ATR(n) = Wilder平滑(TR, n)

第四步：计算方向指标
+DI = (+DM(n) / ATR(n)) × 100
-DI = (-DM(n) / ATR(n)) × 100

第五步：计算方向性指数 (Directional Index)
DX = (|+DI - -DI| / (+DI + -DI)) × 100

第六步：计算 ADX（DX 的 Wilder 平滑）
ADX = Wilder平滑(DX, n)

其中：
- n = 周期（常用 14）
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `period`: number - 周期（默认 14）

**输出**:
- `adx`: ADX 值
- `pdi`: +DI 值
- `mdi`: -DI 值

**数值范围**: 0-100

**交易信号**:

1. **趋势强度判断**:
   - ADX < 20: 弱趋势或无趋势，震荡市
   - ADX 20-25: 趋势开始形成
   - ADX > 25: 强趋势
   - ADX > 50: 极强趋势
   - ADX > 75: 趋势极端强劲（少见）

2. **趋势方向（结合 DI）**:
   - +DI > -DI 且 ADX > 25: 强上升趋势
   - -DI > +DI 且 ADX > 25: 强下降趋势
   - +DI 和 -DI 交叉: 趋势可能反转

3. **趋势变化**:
   - ADX 上升: 趋势加强
   - ADX 下降: 趋势减弱
   - ADX 转向: 可能趋势反转或进入震荡

**特点**:
- J. Welles Wilder 开发
- 滞后指标
- 不指示方向，只指示强度
- 需结合 +DI 和 -DI 使用

**使用策略**:
```
趋势跟随：
- ADX > 25 且 +DI > -DI: 买入
- ADX > 25 且 -DI > +DI: 卖出
- ADX < 20: 避免趋势策略，使用震荡策略

震荡交易：
- ADX < 20: 使用区间策略
- ADX 开始上升: 准备趋势交易
```

**使用示例**:
```typescript
import { ADX } from 'technicalindicators';

const adx = ADX.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  period: 14
});
// 输出: [{ adx, pdi, mdi }, ...]
```

---

### 2. TrueRange (TR) - 真实波幅

**作用**: 衡量单个周期的价格波动范围，考虑跳空缺口的影响。

**用途**:
- ATR 计算的基础
- 衡量单日波动性
- 识别异常波动
- 风险管理

**计算公式**:
```
TR = max(以下三者):
  1. 最高价 - 最低价
  2. |最高价 - 前收盘价|
  3. |最低价 - 前收盘价|

说明：
- 情况1：正常波动，无跳空
- 情况2：向上跳空或前日收盘价低于当日最低价
- 情况3：向下跳空或前日收盘价高于当日最高价
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组

**特点**:
- J. Welles Wilder 开发
- 考虑跳空缺口
- ATR 的基础计算单元
- 绝对值指标

**使用示例**:
```typescript
import { TrueRange } from 'technicalindicators';

const tr = TrueRange.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */]
});
```

---

## 七、图表类型 (Chart Types)

### 1. Renko - 砖形图

**作用**: 过滤时间和小幅波动，只关注价格变化达到特定幅度时才绘制新砖块。

**用途**:
- 过滤市场噪音
- 识别趋势
- 支撑阻力位
- 减少假信号

**绘制规则**:
```
砖块大小设定：固定点数或 ATR 的倍数

向上砖块（白色/绿色）：
- 价格上涨超过砖块大小时绘制
- 新砖块的底部 = 前砖块的顶部

向下砖块（黑色/红色）：
- 价格下跌超过砖块大小时绘制
- 新砖块的顶部 = 前砖块的底部

反转条件：
- 价格反向移动超过 2 倍砖块大小
```

**参数**:
- `open/high/low/close`: K线数据
- `brickSize`: 砖块大小

**交易信号**:
- 连续白色砖块: 上升趋势
- 连续黑色砖块: 下降趋势
- 颜色改变: 趋势反转
- 支撑阻力更清晰

**特点**:
- 忽略时间因素
- 固定砖块大小
- 趋势清晰
- 滞后性强

**使用示例**:
```typescript
import { renko } from 'technicalindicators';

const renkoData = renko({
  open: [/* 开盘价 */],
  high: [/* 最高价 */],
  low: [/* 最低价 */],
  close: [/* 收盘价 */],
  brickSize: 10  // 砖块大小
});
```

---

### 2. HeikinAshi - 平均K线

**作用**: 通过平均价格创建更平滑的 K 线，过滤噪音，突出趋势。

**用途**:
- 识别趋势方向
- 过滤市场噪音
- 确认趋势强度
- 减少假信号

**计算公式**:
```
HA收盘价 = (开盘价 + 最高价 + 最低价 + 收盘价) / 4

HA开盘价 = (前一根HA开盘价 + 前一根HA收盘价) / 2

HA最高价 = max(最高价, HA开盘价, HA收盘价)

HA最低价 = min(最低价, HA开盘价, HA收盘价)

初始值：
第一根HA开盘价 = (开盘价 + 收盘价) / 2
```

**参数**:
- `open`: number[] - 开盘价数组
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组

**输出**:
- `open`: HA 开盘价
- `high`: HA 最高价
- `low`: HA 最低价
- `close`: HA 收盘价

**交易信号**:

1. **趋势识别**:
   - 连续阳线（无下影线）: 强上升趋势
   - 连续阴线（无上影线）: 强下降趋势

2. **趋势反转**:
   - 出现上下影线: 趋势减弱
   - K 线颜色改变: 可能反转

3. **趋势强度**:
   - 实体大、影线小: 强趋势
   - 实体小、影线长: 弱趋势

**特点**:
- 平滑价格波动
- 保留时间因素
- 与普通 K 线相似但更平滑
- 滞后性比普通 K 线强

**使用示例**:
```typescript
import { HeikinAshi } from 'technicalindicators';

const ha = HeikinAshi.calculate({
  open: [/* 开盘价数组 */],
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */]
});
```

---

## 八、综合指标 (Composite Indicators)

### IchimokuCloud - 一目均衡表

**作用**: 综合趋势、支撑阻力、动量的多维度指标系统，一目了然地展示市场状态。

**用途**:
- 综合趋势分析
- 动态支撑阻力
- 趋势强度判断
- 买卖信号生成

**计算公式**:
```
转换线 (Tenkan-sen) = (9周期最高价 + 9周期最低价) / 2

基准线 (Kijun-sen) = (26周期最高价 + 26周期最低价) / 2

先行带A (Senkou Span A) = (转换线 + 基准线) / 2
[向前平移 26 周期]

先行带B (Senkou Span B) = (52周期最高价 + 52周期最低价) / 2
[向前平移 26 周期]

滞后线 (Chikou Span) = 当前收盘价
[向后平移 26 周期]

云层 (Kumo) = 先行带A 和 先行带B 之间的区域
```

**参数**:
- `high`: number[] - 最高价数组
- `low`: number[] - 最低价数组
- `close`: number[] - 收盘价数组
- `conversionPeriod`: 转换线周期（默认 9）
- `basePeriod`: 基准线周期（默认 26）
- `spanPeriod`: 先行带周期（默认 52）
- `displacement`: 平移周期（默认 26）

**输出**:
- `conversion`: 转换线
- `base`: 基准线
- `spanA`: 先行带 A
- `spanB`: 先行带 B
- `chikou`: 滞后线

**交易信号**:

1. **转换线与基准线交叉**:
   - 转换线向上穿越基准线: 买入信号
   - 转换线向下穿越基准线: 卖出信号

2. **价格与云层关系**:
   - 价格在云层上方: 上升趋势
   - 价格在云层下方: 下降趋势
   - 价格在云层内: 震荡或趋势不明

3. **云层颜色**:
   - 先行带A > 先行带B: 看涨云（绿色）
   - 先行带A < 先行带B: 看跌云（红色）
   - 云层颜色改变: 趋势可能反转

4. **突破信号**:
   - 价格突破云层: 强信号（需确认）
   - 云层越厚: 支撑/阻力越强

5. **滞后线**:
   - 滞后线在价格上方: 确认上升趋势
   - 滞后线在价格下方: 确认下降趋势

**强势信号（多重确认）**:
```
看涨：
1. 价格在云层上方
2. 转换线 > 基准线
3. 滞后线在价格上方
4. 云层为绿色

看跌：
1. 价格在云层下方
2. 转换线 < 基准线
3. 滞后线在价格下方
4. 云层为红色
```

**特点**:
- Goichi Hosoda 开发
- 一张图包含多个指标
- 提前显示未来支撑阻力（先行带）
- 适合中长期交易

**使用示例**:
```typescript
import { IchimokuCloud } from 'technicalindicators';

const ichimoku = IchimokuCloud.calculate({
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */],
  conversionPeriod: 9,
  basePeriod: 26,
  spanPeriod: 52,
  displacement: 26
});
```

---

## 九、工具函数 (Utility Functions)

### 1. 数学工具

#### AverageGain - 平均涨幅
```typescript
import { AverageGain } from 'technicalindicators';

// 计算价格上涨的平均幅度
const avgGain = AverageGain.calculate({
  values: [/* 价格数组 */],
  period: 14
});
```

#### AverageLoss - 平均跌幅
```typescript
import { AverageLoss } from 'technicalindicators';

// 计算价格下跌的平均幅度
const avgLoss = AverageLoss.calculate({
  values: [/* 价格数组 */],
  period: 14
});
```

#### SD (Standard Deviation) - 标准差
```typescript
import { SD } from 'technicalindicators';

// 计算标准差，衡量价格波动性
const sd = SD.calculate({
  values: [/* 价格数组 */],
  period: 20
});
```

#### Highest - 周期内最高值
```typescript
import { Highest } from 'technicalindicators';

// 查找周期内的最高价
const highest = Highest.calculate({
  values: [/* 价格数组 */],
  period: 14
});
```

#### Lowest - 周期内最低值
```typescript
import { Lowest } from 'technicalindicators';

// 查找周期内的最低价
const lowest = Lowest.calculate({
  values: [/* 价格数组 */],
  period: 14
});
```

#### Sum - 周期内求和
```typescript
import { Sum } from 'technicalindicators';

// 计算周期内的总和
const sum = Sum.calculate({
  values: [/* 数值数组 */],
  period: 14
});
```

---

### 2. 交叉检测工具

#### CrossUp - 向上交叉
```typescript
import { CrossUp } from 'technicalindicators';

// 检测线A从下向上穿越线B
const crossUp = CrossUp.calculate({
  lineA: [/* 快线数据 */],
  lineB: [/* 慢线数据 */]
});
// 返回: [false, false, true, false, ...]
```

**用途**:
- 金叉检测（如 EMA5 向上穿越 EMA10）
- 价格突破检测
- 指标信号确认

#### CrossDown - 向下交叉
```typescript
import { CrossDown } from 'technicalindicators';

// 检测线A从上向下穿越线B
const crossDown = CrossDown.calculate({
  lineA: [/* 快线数据 */],
  lineB: [/* 慢线数据 */]
});
// 返回: [false, false, true, false, ...]
```

**用途**:
- 死叉检测（如 EMA5 向下穿越 EMA10）
- 价格跌破检测
- 指标信号确认

---

### 3. 绘图工具

#### FibonacciRetracement - 斐波那契回调
```typescript
import { fibonacciretracement } from 'technicalindicators';

// 计算斐波那契回调位
const fib = fibonacciretracement({
  high: 100,  // 波段最高价
  low: 80     // 波段最低价
});

// 输出回调位:
// {
//   '0%': 100,      // 0% 回调（最高点）
//   '23.6%': 95.28, // 23.6% 回调
//   '38.2%': 92.36, // 38.2% 回调
//   '50%': 90,      // 50% 回调
//   '61.8%': 87.64, // 61.8% 回调
//   '78.6%': 84.28, // 78.6% 回调
//   '100%': 80      // 100% 回调（最低点）
// }
```

**用途**:
- 确定回调支撑位（上升趋势）
- 确定反弹阻力位（下降趋势）
- 目标位设置
- 止损位参考

**重要回调位**:
- 38.2%: 浅回调，强趋势
- 50%: 中等回调
- 61.8%: 黄金分割，强支撑/阻力
- 78.6%: 深度回调

---

## 十、K 线形态识别 (Candlestick Patterns)

technicalindicators 库提供 30+ 种 K 线形态识别功能。所有形态识别函数返回布尔值数组，true 表示该位置识别到形态。

### 看涨反转形态

```typescript
import {
  abandonedbaby,           // 弃婴形态
  bullishengulfingpattern, // 看涨吞没
  bullishharami,           // 看涨孕线
  bullishharamicross,      // 看涨十字孕线
  bullishmarubozu,         // 看涨光头光脚
  bullishspinningtop,      // 看涨纺锤线
  bullishhammerstick,      // 看涨锤子线
  bullishinvertedhammerstick, // 看涨倒锤子
  morningdojistar,         // 晨星十字
  morningstar,             // 晨星
  piercingline,            // 刺透形态
  threewhitesoldiers       // 三白兵
} from 'technicalindicators';

// 示例：检测看涨吞没形态
const bullishEngulfing = bullishengulfingpattern({
  open: [/* 开盘价数组 */],
  high: [/* 最高价数组 */],
  low: [/* 最低价数组 */],
  close: [/* 收盘价数组 */]
});
```

### 看跌反转形态

```typescript
import {
  bearishengulfingpattern, // 看跌吞没
  bearishharami,           // 看跌孕线
  bearishharamicross,      // 看跌十字孕线
  bearishmarubozu,         // 看跌光头光脚
  bearishspinningtop,      // 看跌纺锤线
  bearishhammerstick,      // 看跌锤子线
  bearishinvertedhammerstick, // 看跌倒锤子
  darkcloudcover,          // 乌云盖顶
  downsidetasukigap,       // 下跌跳空并列
  eveningdojistar,         // 暮星十字
  eveningstar,             // 暮星
  threeblackcrows,         // 三只乌鸦
  hangingman,              // 上吊线
  shootingstar             // 流星
} from 'technicalindicators';
```

### 中性形态

```typescript
import {
  doji,           // 十字星
  dragonflydoji,  // 蜻蜓十字
  gravestonedoji  // 墓碑十字
} from 'technicalindicators';
```

### 确认形态

```typescript
import {
  hammerpattern,              // 锤子形态（已确认）
  hammerpatternunconfirmed,   // 锤子形态（未确认）
  hangingmanunconfirmed,      // 上吊线（未确认）
  shootingstarunconfirmed,    // 流星（未确认）
  tweezertop,                 // 镊子顶
  tweezerbottom               // 镊子底
} from 'technicalindicators';
```

**使用注意**:
- K 线形态识别应结合趋势和成交量
- 单一形态可靠性有限，建议多重确认
- "未确认"形态需要后续 K 线确认
- 适合作为辅助信号，不应单独使用

---

## 十一、性能优化特性

### 1. 增量计算 (nextValue)

适合实时数据流场景，避免重复计算历史数据：

```typescript
import { EMA } from 'technicalindicators';

// 初始化时批量计算
const ema = new EMA({ period: 5, values: [1, 2, 3, 4, 5] });
const results = ema.getResult(); // [3, 4, ...]

// 新数据到达时增量计算
const newValue = ema.nextValue(6); // 只计算新值
```

### 2. 内存效率

库内部使用 `FixedSizeLinkedList` 优化内存：

```typescript
import { FixedSizeLinkedList } from 'technicalindicators';

// 固定大小链表，自动丢弃旧数据
const list = new FixedSizeLinkedList(100);
```

### 3. 精度控制

```typescript
import { setConfig, getConfig } from 'technicalindicators';

// 设置计算精度（小数位数）
setConfig('precision', 2);

// 获取当前配置
const config = getConfig('precision');
```

---

## 十二、API 使用方式

### 方式 1: 静态方法 calculate（批量计算）

```typescript
import { RSI } from 'technicalindicators';

const rsi = RSI.calculate({
  values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  period: 6
});
// 返回完整结果数组
```

### 方式 2: 实例方法 nextValue（增量计算）

```typescript
import { EMA } from 'technicalindicators';

const ema = new EMA({ period: 5, values: [] });
const result1 = ema.nextValue(10);
const result2 = ema.nextValue(11);
const result3 = ema.nextValue(12);
```

### 方式 3: 混合方式（批量 + 增量）

```typescript
import { MACD } from 'technicalindicators';

// 先批量计算历史数据
const macd = new MACD({
  values: [/* 历史价格 */],
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
  SimpleMAOscillator: false,
  SimpleMASignal: false
});

const historicalResults = macd.getResult();

// 新数据到达时增量计算
const newResult = macd.nextValue(newPrice);
```

---

## 十三、注意事项

### 1. 版本兼容性
- **Node.js >= 10**: 使用 3.x 版本（当前）
- **Node.js < 10**: 使用 1.x 版本

### 2. 模式检测功能
- **版本 3.0+**: 移除了图表形态检测（Head and Shoulders, Double Top/Bottom 等）
- **需要模式检测**: 使用 2.0 版本

### 3. TypeScript 支持
完整的 TypeScript 类型定义，位于 `declarations/` 目录。

### 4. 浏览器支持
- **现代浏览器 (ES6)**: 使用 `browser.es6.js`
- **旧版浏览器 (ES5)**: 需要 `babel-polyfill` + `browser.js`

---

## 十四、总结

### 库统计
- **技术指标**: 30+ 个
- **K线形态**: 30+ 种
- **图表类型**: 2 种（Renko, Heikin-Ashi）
- **工具函数**: 10+ 个

### 指标分类
| 类别 | 指标数量 | 主要指标 |
|------|---------|---------|
| 移动平均 | 4 | SMA, EMA, WMA, WEMA |
| 振荡器 | 5 | CCI, StochRSI, WilliamsR, AO, TRIX |
| 动量 | 4 | ROC, KST, PSAR, Stochastic |
| 波动率 | 4 | ATR, BollingerBands, KeltnerChannels, ChandelierExit |
| 成交量 | 5 | ADL, OBV, VWAP, VolumeProfile, ForceIndex |
| 方向性 | 2 | ADX, TrueRange |
| 综合 | 1 | IchimokuCloud |

### 适用场景
- **实时交易系统**: 增量计算支持
- **量化策略回测**: 批量计算高效
- **多时间框架分析**: 丰富的指标选择
- **风险管理**: ATR、标准差等工具

### 扩展建议
当前项目可考虑集成的未使用指标：
1. **ATR**: 动态止损和仓位管理
2. **BollingerBands**: 波动性突破策略
3. **ADX**: 趋势强度过滤器
4. **OBV**: 成交量确认
5. **IchimokuCloud**: 综合趋势分析

---

## 十五、参考资源

- **GitHub**: https://github.com/anandanand84/technicalindicators
- **npm**: https://www.npmjs.com/package/technicalindicators
- **文档**: 查看库的 TypeScript 定义文件获取详细 API 参数
