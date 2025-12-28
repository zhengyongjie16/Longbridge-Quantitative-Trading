# LongBridge 证券港股自动化量化交易系统

## 项目简介

基于 LongPort OpenAPI / Node.js 的港股自动化量化交易系统，通过监控单个标的并自动执行做多/做空交易。

## 开发者提示

1. 使用 Claude Code 开发时，请参阅 **[CLAUDE.md](./CLAUDE.md)** 获取专门指导。
2. 项目内置 skills，Claude Code 可自动使用以下 skill：

   - `/business-logic`：阅读业务逻辑文档（用于检查代码是否遵循业务逻辑，当你更新业务时最好一同更新这个 skill）
   - `/longbridge-openapi-documentation`：查询 LongPort API 文档，根据 API 编写代码

   启用方式：在 Claude Code 中直接输入 `/` 选择 skill，或在对话中提及 skill 名称。

### 核心功能

| 功能       | 说明                                 |
| ---------- | ------------------------------------ |
| 多指标组合 | RSI、MFI、KDJ、MACD 组合判断         |
| 双向交易   | 支持做多（牛证）和做空（熊证）       |
| 延迟验证   | 开仓信号 60 秒延迟确认趋势           |
| 智能风控   | 浮亏保护、持仓限制、牛熊证回收价检查 |
| 末日保护   | 收盘前自动清仓                       |
| 订单优化   | 自动监控和调整未成交订单             |

---

## 快速开始

### 安装

```bash
npm install
cp .env.example .env
# 编辑 .env 填写配置
```

### 配置必需参数 (.env)

```env
# API 配置
LONGPORT_APP_KEY=your_key
LONGPORT_APP_SECRET=your_secret
LONGPORT_ACCESS_TOKEN=your_token

# 交易标的
MONITOR_SYMBOL=HSI.HK    # 监控标的（恒生指数）
LONG_SYMBOL=54806        # 做多标的（牛证）
SHORT_SYMBOL=63372       # 做空标的（熊证）

# 交易参数
TARGET_NOTIONAL=10000    # 每次买入金额（HKD）
LONG_LOT_SIZE=100        # 做多每手股数
SHORT_LOT_SIZE=100       # 做空每手股数

# 风控参数
MAX_POSITION_NOTIONAL=200000  # 单标持仓上限
MAX_DAILY_LOSS=20000          # 单日亏损上限

# 信号配置（必需，格式见下方）
SIGNAL_BUYCALL=(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)
SIGNAL_SELLCALL=(RSI:6>80,MFI>85,D>79,J>100)/3|(J>110)
SIGNAL_BUYPUT=(RSI:6>80,MFI>85,D>80,J>100)/3|(J>120)
SIGNAL_SELLPUT=(RSI:6<20,MFI<15,D<22,J<0)/3|(J<-15)
```

### 启动

```bash
npm start
```

---

## 信号配置格式

**格式**：`(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M`

- **括号内**：条件列表，逗号分隔
- **/N**：括号内条件需满足 N 项
- **|**：分隔条件组，满足任一组即可
- **指标**：`RSI:n`（任意周期）、`MFI`、`D`（KDJ.D）、`J`（KDJ.J）
- **运算符**：`<`、`>`

**示例**：`RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)` 表示 4 条件满足 3 个**或** J<-20 即可触发。

> **技术指标详解**：详见 [docs/TECHNICAL_INDICATORS.md](./docs/TECHNICAL_INDICATORS.md)

### 四种信号

| 信号     | 类型     | 环境变量          | 验证                           |
| -------- | -------- | ----------------- | ------------------------------ |
| BUYCALL  | 买入做多 | `SIGNAL_BUYCALL`  | 延迟 60 秒，D2>D1 且 DIF2>DIF1 |
| SELLCALL | 卖出做多 | `SIGNAL_SELLCALL` | 立即执行                       |
| BUYPUT   | 买入做空 | `SIGNAL_BUYPUT`   | 延迟 60 秒，D2<D1 且 DIF2<DIF1 |
| SELLPUT  | 卖出做空 | `SIGNAL_SELLPUT`  | 立即执行                       |

### 卖出策略

- **盈利状态**（当前价 > 成本价）：清空全部持仓
- **未盈利**（当前价 ≤ 成本价）：仅卖出盈利部分（买入价 < 当前价的订单）

---

## 风险控制

| 检查       | 说明                             | 买入    | 卖出 |
| ---------- | -------------------------------- | ------- | ---- |
| 交易频率   | 同方向买入间隔                   | ✅ 限制 | ❌   |
| 买入价格   | 不追高（当前价 ≤ 最新成交价）    | ✅ 检查 | ❌   |
| 末日保护   | 收盘前 15 分钟拒绝买入           | ✅ 限制 | ❌   |
| 牛熊证风险 | 距离回收价 > 0.5%                | ✅ 检查 | ❌   |
| 单日亏损   | 浮亏 > MAX_DAILY_LOSS            | ✅ 限制 | ❌   |
| 持仓市值   | 单标持仓 > MAX_POSITION_NOTIONAL | ✅ 限制 | ❌   |
| 浮亏保护   | 单标浮亏 > MAX_UNREALIZED_LOSS   | ✅ 清仓 | ❌   |

### 末日保护（可配置）

- 收盘前 15 分钟：拒绝所有买入
- 收盘前 5 分钟：自动清空所有持仓

### 可选配置

| 参数                             | 默认值  | 说明               |
| -------------------------------- | ------- | ------------------ |
| `DOOMSDAY_PROTECTION`            | `true`  | 启用末日保护       |
| `DEBUG`                          | `false` | 启用调试日志       |
| `MAX_UNREALIZED_LOSS_PER_SYMBOL` | `0`     | 单标浮亏保护阈值   |
| `VERIFICATION_DELAY_SECONDS`     | `60`    | 延迟验证时间（秒） |
| `VERIFICATION_INDICATORS`        | `D,DIF` | 验证指标           |
| `BUY_INTERVAL_SECONDS`           | `60`    | 同向买入间隔（秒） |

---

## 系统架构

```
src/
├── index.js              # 主入口（每秒循环）
├── core/
│   ├── strategy.js       # 信号生成
│   ├── trader.js         # 订单执行
│   ├── risk.js           # 风险检查
│   ├── orderRecorder.js  # 订单记录
│   ├── signalProcessor.js # 信号处理
│   ├── signalVerification.js # 延迟验证
│   ├── marketMonitor.js  # 行情监控
│   ├── doomsdayProtection.js # 末日保护
│   └── unrealizedLossMonitor.js # 浮亏监控
├── services/
│   ├── indicators.js     # 技术指标计算
│   └── quoteClient.js    # 行情数据
├── utils/
│   ├── objectPool.js     # 内存优化
│   ├── logger.js         # 日志系统
│   ├── signalConfigParser.js # 配置解析
│   └── tradingTime.js    # 交易时段
└── config/
    ├── config.js         # API配置
    └── config.trading.js # 交易配置
```

---

## 运行流程

```
每秒循环：
1. 检查交易时段
2. 获取K线和实时行情
3. 计算技术指标
4. 生成交易信号（立即/延迟）
5. 验证延迟信号（60秒后）
6. 风险检查（仅买入）
7. 执行订单
8. 监控未成交订单
9. 更新订单记录
```

### 交易时段

- **正常日**：09:30-12:00，13:00-16:00
- **半日**：09:30-12:00（无下午盘）

---

## 日志

- **控制台**：实时运行状态
- **文件**：`logs/system/` 和 `logs/debug/`（DEBUG 模式）
- **交易记录**：`logs/trades/YYYY-MM-DD.json`

---

## 常见问题

| 问题         | 原因         | 解决                   |
| ------------ | ------------ | ---------------------- |
| 不在交易时段 | 非交易时间   | 等待交易时段           |
| 配置验证失败 | 环境变量缺失 | 检查 .env 配置         |
| 余额不足     | 账户资金不足 | 减小 TARGET_NOTIONAL   |
| 延迟验证失败 | 趋势未确认   | 正常现象，系统自动放弃 |

---

## 风险提示

1. 不保证所有代码允许正确，若发现 BUG 请提出或自行修复
2. 本系统仅供学习研究，不构成投资建议
3. 技术指标策略不能保证盈利
4. 牛熊证有回收机制，请注意风险
5. 建议先用模拟账户测试

---

## 帮助

- [LongPort 官方文档](https://open.longbridge.com/zh-CN/docs)
- [Node.js SDK 文档](https://longportapp.github.io/openapi/nodejs/)
- [Claude Code 官方文档](https://code.claude.com/docs)

---

## 许可证

MIT License (c) 2025 Ulysses Zheng
