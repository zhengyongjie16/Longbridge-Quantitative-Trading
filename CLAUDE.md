# CLAUDE.md

本文件为 Claude Code 在此代码库中工作时提供指导。

## 系统概述

LongBridge 港股自动化量化交易系统。通过技术指标监控目标资产（如恒生指数），在牛熊证上执行双向交易。

**核心模式**：多指标组合策略，开仓信号延迟验证（默认60秒），平仓信号立即执行。

**技术栈**：TypeScript + Node.js + LongPort OpenAPI + technicalindicators

## 架构

```
src/
├── index.ts              # 主循环，每秒执行 runOnce()
├── core/
│   ├── strategy.ts       # 信号生成（立即/延迟）
│   ├── signalVerification.ts  # 延迟信号验证
│   ├── signalProcessor.ts     # 风险检查、卖出数量计算
│   ├── trader.ts         # 订单执行和监控
│   ├── risk.ts           # 风险控制（牛熊证/浮亏/持仓）
│   ├── orderRecorder.ts  # 历史订单跟踪
│   ├── marketMonitor.ts  # 价格和指标监控
│   ├── doomsdayProtection.ts  # 收盘前保护
│   └── unrealizedLossMonitor.ts  # 浮亏监控
├── services/
│   ├── indicators.ts     # 技术指标（RSI/MFI/KDJ/MACD/EMA）
│   └── quoteClient.ts    # 行情数据
├── utils/
│   ├── helpers.ts        # 工具函数
│   ├── signalConfigParser.ts  # 信号配置解析
│   ├── tradingTime.ts    # 交易时段
│   ├── logger.ts         # 日志系统
│   ├── objectPool.ts     # 对象池
│   ├── accountDisplay.ts # 账户显示
│   └── indicatorHelpers.ts # 指标辅助函数
└── config/
    ├── config.index.ts   # API配置
    ├── config.trading.ts # 交易配置
    └── config.validator.ts # 配置验证
```

## 运行

```bash
npm install
cp .env.example .env  # 填写配置
npm start
```

## 信号类型

| 信号 | 含义 | 执行方式 |
|------|------|----------|
| BUYCALL | 买入做多（牛证） | 延迟验证 |
| SELLCALL | 卖出做多 | 立即执行 |
| BUYPUT | 买入做空（熊证） | 延迟验证 |
| SELLPUT | 卖出做空 | 立即执行 |
| HOLD | 持有不动 | - |

## 信号配置格式

通过环境变量配置（`SIGNAL_BUYCALL`, `SIGNAL_SELLCALL`, `SIGNAL_BUYPUT`, `SIGNAL_SELLPUT`）：

```
格式: (条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M
- /N: 需满足N项，不设则全部满足
- |: 分隔条件组，满足任一组即可

支持指标: RSI:n, MFI, K, D, J, MACD, DIF, DEA, EMA:n
运算符: < 和 >

示例: (RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)
```

## 关键业务规则

### 买入检查顺序
1. 交易频率限制（同方向间隔，默认60秒）
2. 买入价格限制（当前价 > 最新成交价时拒绝买入，防止追高）
3. 末日保护（收盘前15分钟拒绝买入）
4. 牛熊证风险（牛证距回收价 > 0.5%，熊证 < -0.5%）
5. 基础风险检查（浮亏限制和持仓市值限制）

### 卖出数量计算（signalProcessor.ts）
- **盈利状态**（currentPrice > costPrice）：清空全部持仓
- **未盈利状态**（currentPrice ≤ costPrice）：仅卖出 buyPrice < currentPrice 的历史订单
- **无符合条件订单**：信号设为 HOLD，跳过本次卖出
- **末日保护**：无条件清仓，不受成本价判断影响

### 延迟验证逻辑（60秒延迟确认趋势）
- **BUYCALL**：验证指标的3个时间点值（T0, T0+5s, T0+10s）都要**大于**初始值（上涨趋势）
- **BUYPUT**：验证指标的3个时间点值（T0, T0+5s, T0+10s）都要**小于**初始值（下跌趋势）
- **验证窗口**：触发时间前5秒到后15秒内记录指标值
- **时间点误差**：每个时间点允许±5秒误差
- **验证指标**：默认为 D, DIF（可通过 VERIFICATION_INDICATORS 配置）

### 收盘保护（DoomsdayProtection）
- 收盘前15分钟：拒绝买入
- 收盘前5分钟：自动清仓

## 技术约束

### 必须遵守
1. **标的代码规范化**：始终用 `normalizeHKSymbol()` 处理，确保带 `.HK` 后缀
2. **Decimal转换**：LongPort API 返回 Decimal 对象，必须用 `decimalToNumber()` 转换
3. **订单类型**：所有订单用 ELO（增强限价单），保护性清仓用 MO（市价单）
4. **买入必须实时数据**：买入前必须获取最新账户/持仓数据
5. **卖出可用缓存**：卖出操作可使用缓存数据

### 时区处理
- 系统内部：UTC
- 港股交易：09:30-12:00, 13:00-16:00（UTC+8）
- 日志显示：北京时间（`toBeijingTimeLog()`）

### 频率限制
- Trade API：30秒内≤30次，间隔≥0.02秒
- 买入间隔：同方向默认60秒（按 LONG/SHORT 区分，非标的代码）

### 牛熊证风险计算
```javascript
// 使用监控标的价格（非牛熊证价格）计算距离回收价百分比
距离回收价% = (监控标的价 - 回收价) / 回收价 × 100%

// 风险阈值：
// - 牛证：距离回收价 > 0.5% 时允许买入
// - 熊证：距离回收价 < -0.5% 时允许买入
```

## 常见修改任务

| 任务         | 修改位置                                                   |
| ------------ | ---------------------------------------------------------- |
| 修改信号条件 | `.env` 文件（无需改代码）                                  |
| 添加新指标   | `indicators.ts` + `signalConfigParser.ts`                  |
| 调整风险检查 | `risk.ts`（仅门控买入）                                    |
| 修改订单逻辑 | `trader.ts`                                                |
| 修改卖出策略 | `signalProcessor.ts` 中的 `calculateSellQuantity` 函数     |
| 修改配置参数 | `.env` 或 `config.trading.ts`                              |
| 调整验证逻辑 | `signalVerification/index.ts` 中的 `_verifySingleSignal` 方法 |
| 订单记录逻辑 | `orderRecorder/index.ts` 中的 `refreshOrders` 方法（过滤算法） |
| 修改账户显示 | `utils/accountDisplay.ts` 中的 `displayAccountAndPositions` 函数 |
| 修改指标计算 | `services/indicators/index.ts` 中的各指标计算函数 |

## 必需配置

```env
# API凭证
APP_KEY, APP_SECRET, ACCESS_TOKEN

# 标的
MONITOR_SYMBOL    # 监控标的（生成信号）
LONG_SYMBOL       # 做多标的（执行买入）
SHORT_SYMBOL      # 做空标的（执行买入）

# 交易
TARGET_NOTIONAL, LONG_LOT_SIZE, SHORT_LOT_SIZE

# 风险
MAX_POSITION_NOTIONAL, MAX_DAILY_LOSS

# 信号（必需）
SIGNAL_BUYCALL, SIGNAL_SELLCALL, SIGNAL_BUYPUT, SIGNAL_SELLPUT
```

## 可选配置

```env
DOOMSDAY_PROTECTION=true          # 收盘保护
DEBUG=false                        # 调试模式
MAX_UNREALIZED_LOSS_PER_SYMBOL=0  # 单标的浮亏保护
VERIFICATION_DELAY_SECONDS=60     # 验证延迟（0=不延迟）
VERIFICATION_INDICATORS=D,DIF     # 验证指标
BUY_INTERVAL_SECONDS=60           # 同方向买入间隔
```

## 调试

启用 `DEBUG=true` 查看详细指标值。

日志位置：
- 系统日志：`logs/system/`
- 调试日志：`logs/debug/`
- 交易记录：`logs/trades/YYYY-MM-DD.json`

## 相关文档

- [README.md](./README.md) - 用户指南
- [docs/TECHNICAL_INDICATORS.md](./docs/TECHNICAL_INDICATORS.md) - 指标计算原理
