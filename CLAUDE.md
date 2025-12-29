# CLAUDE.md

本文件为 Claude Code 在此代码库中工作时提供指导。

## 系统概述

LongBridge 港股自动化量化交易系统。通过技术指标监控目标资产（如恒生指数），在牛熊证上执行双向交易。

**核心模式**：多指标组合策略，开仓信号延迟验证（默认60秒），平仓信号立即执行。

## 架构

```
src/
├── index.js              # 主循环，每秒执行 runOnce()
├── core/
│   ├── strategy.js       # 信号生成（立即/延迟）
│   ├── signalVerification.js  # 延迟信号验证
│   ├── signalProcessor.js     # 风险检查、卖出数量计算
│   ├── trader.js         # 订单执行和监控
│   ├── risk.js           # 风险控制（牛熊证/浮亏/持仓）
│   ├── orderRecorder.js  # 历史订单跟踪
│   ├── marketMonitor.js  # 价格和指标监控
│   ├── doomsdayProtection.js  # 收盘前保护
│   └── unrealizedLossMonitor.js  # 浮亏监控
├── services/
│   ├── indicators.js     # 技术指标（RSI/MFI/KDJ/MACD/EMA）
│   └── quoteClient.js    # 行情数据
├── utils/
│   ├── helpers.js        # 工具函数
│   ├── signalConfigParser.js  # 信号配置解析
│   ├── tradingTime.js    # 交易时段
│   ├── logger.js         # 日志系统
│   └── objectPool.js     # 对象池
└── config/
    ├── config.js         # API配置
    └── config.trading.js # 交易配置
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
2. 买入价格限制（防止追高：当前价 > 最新成交价则拒绝）
3. 末日保护（收盘前15分钟拒绝买入）
4. 牛熊证风险（距回收价 > 0.5%）
5. 浮亏和持仓限制

### 卖出数量计算
- 盈利时（currentPrice > costPrice）：清空全部持仓
- 未盈利时：仅卖出 buyPrice < currentPrice 的历史订单
- 无符合订单：信号设为 HOLD

### 延迟验证逻辑
- BUYCALL：所有验证指标的第二个值 > 第一个值
- BUYPUT：所有验证指标的第二个值 < 第一个值
- 验证窗口：触发时间 ±5秒

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
// 使用监控标的价格（非牛熊证价格）
距离回收价% = (监控标的价 - 回收价) / 回收价 × 100%
// 牛证要求 > 0.5%，熊证要求 < -0.5%
```

## 常见修改任务

| 任务 | 修改位置 |
|------|----------|
| 修改信号条件 | `.env` 文件（无需改代码） |
| 添加新指标 | `indicators.js` + `signalConfigParser.js` |
| 调整风险检查 | `risk.js`（仅门控买入） |
| 修改订单逻辑 | `trader.js` |
| 修改配置参数 | `.env` 或 `config.trading.js` |

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
