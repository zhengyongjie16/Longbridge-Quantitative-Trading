# TechnicalIndicators 库技术指标详细分析

## 库信息

- **库名**: `technicalindicators`
- **版本**: 3.1.0
- **语言**: TypeScript/JavaScript
- **许可证**: MIT
- **GitHub**: https://github.com/anandanand84/technicalindicators

## 一、移动平均类指标 (Moving Averages)

### 1. SMA (Simple Moving Average) - 简单移动平均

- **用途**: 计算指定周期内的价格平均值
- **公式**: SMA = (P1 + P2 + ... + Pn) / n
- **特点**: 所有价格权重相等
- **使用场景**: 趋势识别、支撑阻力位判断

### 2. EMA (Exponential Moving Average) - 指数移动平均

- **用途**: 对近期价格赋予更高权重的移动平均
- **公式**: EMA = (当前价格 × 平滑系数) + (前一个 EMA × (1 - 平滑系数))
- **平滑系数**: 2 / (周期 + 1)
- **特点**: 对价格变化反应更敏感
- **使用场景**: 快速趋势识别、短期交易信号

### 3. WMA (Weighted Moving Average) - 加权移动平均

- **用途**: 对近期价格赋予线性递增权重
- **公式**: WMA = (P1×1 + P2×2 + ... + Pn×n) / (1+2+...+n)
- **特点**: 介于 SMA 和 EMA 之间
- **使用场景**: 趋势分析

### 4. WEMA (Wilder's Smoothing / Smoothed Moving Average) - 平滑移动平均

- **用途**: 使用 Wilder 平滑方法的移动平均
- **公式**: WEMA = (当前价格 × (1/周期)) + (前一个 WEMA × (1 - 1/周期))
- **特点**: 平滑系数 = 1/周期，比 EMA 更平滑
- **使用场景**: RSI 计算的基础、长期趋势分析

### 5. MACD (Moving Average Convergence Divergence) - 移动平均收敛散度

- **用途**: 趋势跟踪和动量指标
- **组成**:
  - **DIF (快线)**: EMA12 - EMA26
  - **DEA (信号线)**: DIF 的 EMA9
  - **MACD (柱状图)**: (DIF - DEA) × 2
- **使用场景**:
  - 趋势识别
  - 买卖信号（金叉/死叉）
  - 动量确认
- **当前项目使用**: 用于买入信号的延迟验证（K2 > K1 且 MACD2 > MACD1）

## 二、振荡器类指标 (Oscillators)

### 6. RSI (Relative Strength Index) - 相对强弱指标

- **用途**: 衡量价格动量的超买超卖指标
- **计算方法**: Wilder's Smoothing（Wilder 平滑法）
- **公式**:
  1. 计算价格变化（涨跌值）
  2. 分离涨幅和跌幅
  3. 使用平滑系数 1/period 计算平均涨幅和平均跌幅
  4. RS = 平均涨幅 / 平均跌幅
  5. RSI = 100 - 100 / (1 + RS)
- **数值范围**: 0-100
- **使用场景**:
  - RSI > 70: 超买信号
  - RSI < 30: 超卖信号
  - **当前项目使用**:
    - RSI6 > 80 或 RSI12 > 80: 卖出做多标的信号
    - RSI6 < 20 或 RSI12 < 20: 买入做多标的信号

### 7. Stochastic (KD) - 随机指标

- **用途**: 衡量收盘价在最近 N 根 K 线中的相对位置
- **组成**:
  - **K 值**: 快速随机指标，使用 EMA(5)平滑 RSV
  - **D 值**: 慢速随机指标，对 K 值再次平滑
  - **J 值**: J = 3K - 2D（最敏感）
- **公式**:
  - RSV = ((收盘价 - 最低价) / (最高价 - 最低价)) × 100
  - K = (2/3) × 前一个 K + (1/3) × RSV
  - D = (2/3) × 前一个 D + (1/3) × K
- **使用场景**: 超买超卖判断
- **当前项目使用**: 通过 KDJ 指标（基于 Stochastic）进行交易信号判断

### 8. StochasticRSI (StochRSI) - 随机相对强弱指标

- **用途**: RSI 的随机指标版本
- **特点**: 比 RSI 更敏感，波动范围更大
- **使用场景**: 超买超卖的更精确判断

### 9. WilliamsR (W%R) - 威廉指标

- **用途**: 衡量超买超卖水平
- **公式**: %R = ((最高价 - 收盘价) / (最高价 - 最低价)) × (-100)
- **数值范围**: -100 到 0
- **使用场景**:
  - %R > -20: 超买
  - %R < -80: 超卖

### 10. CCI (Commodity Channel Index) - 商品通道指标

- **用途**: 衡量价格偏离统计平均值的程度
- **公式**: CCI = (典型价格 - 移动平均) / (0.015 × 平均偏差)
- **使用场景**: 趋势强度和反转信号

### 11. Awesome Oscillator (AO) - 动量振荡器

- **用途**: 衡量市场动量的变化
- **公式**: AO = SMA(5, 中位数价格) - SMA(34, 中位数价格)
- **使用场景**: 趋势变化和动量确认

### 12. TRIX (Triple Exponentially Smoothed Average) - 三重指数平滑平均

- **用途**: 过滤价格噪音，识别长期趋势
- **公式**: 对价格进行三次 EMA 平滑，然后计算变化率
- **使用场景**: 长期趋势识别

## 三、动量类指标 (Momentum)

### 13. ROC (Rate of Change) - 变化率

- **用途**: 衡量价格变化的速度
- **公式**: ROC = ((当前价格 - N 周期前价格) / N 周期前价格) × 100
- **使用场景**: 动量确认、趋势强度

### 14. KST (Know Sure Thing) - 确知指标

- **用途**: 综合多个 ROC 周期的动量指标
- **公式**: 加权平均多个不同周期的 ROC
- **使用场景**: 长期趋势和动量分析

### 15. PSAR (Parabolic Stop and Reverse) - 抛物线止损反转

- **用途**: 趋势跟踪和止损点设置
- **特点**: 自适应止损点，随趋势加速
- **使用场景**: 止损设置、趋势反转信号

## 四、波动率类指标 (Volatility)

### 16. ATR (Average True Range) - 平均真实波幅

- **用途**: 衡量市场波动性
- **公式**:
  - TR = max(最高价-最低价, |最高价-前收盘价|, |最低价-前收盘价|)
  - ATR = TR 的移动平均
- **使用场景**:
  - 波动性评估
  - 止损距离设置
  - 仓位大小调整

### 17. Bollinger Bands (BB) - 布林带

- **用途**: 价格波动范围和超买超卖判断
- **组成**:
  - **中轨**: SMA(20)
  - **上轨**: 中轨 + (2 × 标准差)
  - **下轨**: 中轨 - (2 × 标准差)
- **使用场景**:
  - 价格波动范围
  - 超买超卖判断
  - 趋势强度

### 18. Keltner Channels - 肯特纳通道

- **用途**: 基于 ATR 的价格通道
- **组成**:
  - **中轨**: EMA
  - **上轨**: 中轨 + (倍数 × ATR)
  - **下轨**: 中轨 - (倍数 × ATR)
- **使用场景**: 趋势识别、突破信号

### 19. Chandelier Exit - 吊灯止损

- **用途**: 基于 ATR 的动态止损点
- **公式**: 最高价 - (倍数 × ATR)
- **使用场景**: 止损设置

## 五、成交量类指标 (Volume)

### 20. ADL (Accumulation Distribution Line) - 累积/派发线

- **用途**: 衡量资金流入流出
- **公式**: ADL = 前一个 ADL + ((收盘价-最低价) - (最高价-收盘价)) / (最高价-最低价) × 成交量
- **使用场景**: 资金流向分析、趋势确认

### 21. OBV (On Balance Volume) - 能量潮

- **用途**: 基于成交量的趋势指标
- **公式**:
  - 如果收盘价 > 前收盘价: OBV = 前 OBV + 成交量
  - 如果收盘价 < 前收盘价: OBV = 前 OBV - 成交量
  - 如果收盘价 = 前收盘价: OBV = 前 OBV
- **使用场景**: 成交量确认价格趋势

### 22. VWAP (Volume Weighted Average Price) - 成交量加权平均价

- **用途**: 考虑成交量的平均价格
- **公式**: VWAP = Σ(价格 × 成交量) / Σ 成交量
- **使用场景**:
  - 机构交易基准价
  - 日内交易参考
  - **当前项目使用**: 用于买入信号判断（价格与 VWAP 比较）

### 23. Volume Profile (VP) - 成交量分布

- **用途**: 显示不同价格区间的成交量分布
- **使用场景**: 支撑阻力位识别、价格区间分析

### 24. MFI (Money Flow Index) - 资金流量指标

- **用途**: 结合价格和成交量的超买超卖指标
- **公式**: 类似 RSI，但使用"资金流量"（典型价格 × 成交量）
- **数值范围**: 0-100
- **使用场景**: 超买超卖判断（类似 RSI，但考虑成交量）

### 25. Force Index (FI) - 力度指标

- **用途**: 衡量价格变化和成交量的关系
- **公式**: FI = (当前收盘价 - 前收盘价) × 成交量
- **使用场景**: 趋势强度、突破确认

## 六、方向性指标 (Directional Movement)

### 26. ADX (Average Directional Index) - 平均趋向指标

- **用途**: 衡量趋势强度（不指示方向）
- **组成**:
  - **+DI**: 正向方向指标
  - **-DI**: 负向方向指标
  - **ADX**: 方向性运动的平均值
- **数值范围**: 0-100
- **使用场景**:
  - ADX > 25: 强趋势
  - ADX < 20: 无趋势/震荡
  - +DI > -DI: 上升趋势
  - -DI > +DI: 下降趋势

### 27. True Range (TR) - 真实波幅

- **用途**: ATR 计算的基础
- **公式**: TR = max(最高价-最低价, |最高价-前收盘价|, |最低价-前收盘价|)
- **使用场景**: 波动性计算的基础

## 七、图表类型 (Chart Types)

### 28. Renko - 砖形图

- **用途**: 过滤价格噪音，只显示趋势
- **特点**: 基于价格变化而非时间
- **使用场景**: 趋势识别、减少假信号

### 29. Heikin-Ashi (HA) - 平均 K 线

- **用途**: 平滑价格波动，突出趋势
- **公式**:
  - 收盘价 = (开盘+最高+最低+收盘) / 4
  - 开盘价 = (前一根 HA 开盘 + 前一根 HA 收盘) / 2
- **使用场景**: 趋势识别、减少噪音

### 30. Typical Price - 典型价格

- **用途**: 价格的代表值
- **公式**: (最高价 + 最低价 + 收盘价) / 3
- **使用场景**: 其他指标计算的基础

## 八、K 线形态识别 (Candlestick Patterns)

### 反转形态 (Reversal Patterns)

#### 看涨形态 (Bullish)

1. **Abandoned Baby** - 弃婴形态
2. **Bullish Engulfing Pattern** - 看涨吞没形态
3. **Bullish Harami** - 看涨孕线
4. **Bullish Harami Cross** - 看涨十字孕线
5. **Bullish Marubozu** - 看涨光头光脚
6. **Bullish Spinning Top** - 看涨纺锤线
7. **Bullish Hammer** - 看涨锤子线
8. **Bullish Inverted Hammer** - 看涨倒锤子线
9. **Morning Doji Star** - 晨星十字
10. **Morning Star** - 晨星
11. **Piercing Line** - 刺透形态
12. **Three White Soldiers** - 三白兵

#### 看跌形态 (Bearish)

1. **Bearish Engulfing Pattern** - 看跌吞没形态
2. **Bearish Harami** - 看跌孕线
3. **Bearish Harami Cross** - 看跌十字孕线
4. **Bearish Marubozu** - 看跌光头光脚
5. **Bearish Spinning Top** - 看跌纺锤线
6. **Bearish Hammer** - 看跌锤子线
7. **Bearish Inverted Hammer** - 看跌倒锤子线
8. **Dark Cloud Cover** - 乌云盖顶
9. **Downside Tasuki Gap** - 下跌跳空并列
10. **Evening Doji Star** - 暮星十字
11. **Evening Star** - 暮星
12. **Three Black Crows** - 三只乌鸦
13. **Hanging Man** - 上吊线
14. **Shooting Star** - 流星

### 中性形态 (Neutral Patterns)

1. **Doji** - 十字星
2. **DragonFly Doji** - 蜻蜓十字
3. **GraveStone Doji** - 墓碑十字

### 确认形态 (Confirmation Patterns)

1. **Hammer Pattern** - 锤子形态（已确认）
2. **Hammer Pattern (Unconfirmed)** - 锤子形态（未确认）
3. **Hanging Man (Unconfirmed)** - 上吊线（未确认）
4. **Shooting Star (Unconfirmed)** - 流星（未确认）
5. **Tweezer Top** - 镊子顶
6. **Tweezer Bottom** - 镊子底

## 九、特殊指标

### 31. Ichimoku Cloud - 一目均衡表

- **用途**: 综合趋势、支撑阻力、动量的多维度指标
- **组成**:
  - **Tenkan-sen (转换线)**: (9 周期最高价 + 9 周期最低价) / 2
  - **Kijun-sen (基准线)**: (26 周期最高价 + 26 周期最低价) / 2
  - **Senkou Span A (先行带 A)**: (转换线 + 基准线) / 2，前移 26 周期
  - **Senkou Span B (先行带 B)**: (52 周期最高价 + 52 周期最低价) / 2，前移 26 周期
  - **Chikou Span (滞后线)**: 收盘价，后移 26 周期
- **使用场景**:
  - 趋势识别
  - 支撑阻力位
  - 买卖信号（云层突破）

## 十、工具函数 (Utils)

### 数学工具

1. **Average Gain** - 平均涨幅
2. **Average Loss** - 平均跌幅
3. **Highest** - 周期内最高值
4. **Lowest** - 周期内最低值
5. **Sum** - 周期内求和
6. **SD (Standard Deviation)** - 标准差

### 交叉工具

1. **CrossUp** - 向上交叉（价格从下向上穿越）
2. **CrossDown** - 向下交叉（价格从上向下穿越）
3. **CrossOver** - 交叉（向上或向下）

### 绘图工具

1. **Fibonacci Retracement** - 斐波那契回调

## 十一、当前项目使用的指标

### 已使用的指标

1. **RSI** (RSI6, RSI12)

   - 用途: 买入/卖出信号判断
   - 位置: `src/indicators.js` - `calculateRSI()`

2. **KDJ** (基于 Stochastic)

   - 用途: 买入/卖出信号判断
   - 位置: `src/indicators.js` - `calculateKDJ()`
   - 实现: 使用 EMA(5)平滑 RSV 得到 K 和 D 值

3. **MACD**

   - 用途: 买入信号的延迟验证
   - 位置: `src/indicators.js` - `calculateMACD()`

4. **VWAP**
   - 用途: 买入信号判断（价格与 VWAP 比较）
   - 位置: `src/indicators.js` - `calculateVWAP()`

### 可考虑使用的其他指标

1. **ATR** - 用于动态止损设置
2. **Bollinger Bands** - 用于超买超卖判断
3. **ADX** - 用于趋势强度确认
4. **OBV** - 用于成交量确认价格趋势
5. **Ichimoku Cloud** - 用于综合趋势分析

## 十二、API 使用方式

### 方式 1: 静态方法 calculate

```javascript
import { RSI } from "technicalindicators";

const rsi = RSI.calculate({
  values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  period: 6,
});
```

### 方式 2: 实例方法 nextValue（增量计算）

```javascript
import { EMA } from "technicalindicators";

const ema = new EMA({ period: 5, values: [] });
const result1 = ema.nextValue(10); // 第一个值
const result2 = ema.nextValue(11); // 第二个值
```

### 方式 3: 实例方法 getResult（批量计算后增量）

```javascript
import { SMA } from "technicalindicators";

const sma = new SMA({ period: 5, values: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
const results = sma.getResult(); // 获取所有结果
const next = sma.nextValue(10); // 获取下一个值
```

## 十三、性能特点

1. **零依赖**: 库本身不依赖其他 npm 包（除了 TypeScript 类型定义）
2. **TypeScript 支持**: 完整的类型定义
3. **增量计算**: 支持`nextValue`方法进行增量更新，适合实时数据流
4. **内存效率**: 使用固定大小链表（FixedSizeLinkedList）优化内存使用
5. **精度控制**: 支持设置计算精度（默认无限制）

## 十四、注意事项

1. **版本兼容性**:

   - Node.js >= 10: 使用 3.x 版本
   - Node.js < 10: 使用 1.x 版本

2. **模式检测**:

   - 版本 3.0+ 移除了模式检测功能
   - 如需模式检测，使用 2.0 版本

3. **精度设置**:

   ```javascript
   const technicalIndicators = require("technicalindicators");
   technicalIndicators.setConfig("precision", 10);
   ```

4. **浏览器支持**:
   - ES6 浏览器: 使用 `browser.es6.js`
   - ES5 浏览器: 需要 `babel-polyfill` + `browser.js`

## 十五、总结

`technicalindicators` 库提供了 **26 个主要技术指标**、**35 个 K 线形态识别**、**2 种图表类型**和**多个工具函数**，涵盖了技术分析的主要需求。库的设计注重性能和易用性，支持增量计算，非常适合实时交易系统使用。

当前项目已经使用了其中的 4 个核心指标（RSI、KDJ、MACD、VWAP），这些指标足以支持当前的交易策略。如需扩展策略，可以考虑使用其他指标如 ATR、Bollinger Bands、ADX 等。
