# LongBridge 证券港股自动化量化交易系统

## 项目简介

基于 LongPort OpenAPI / Node.js / TypeScript 的港股自动化量化交易系统，通过监控单个标的并自动执行做多/做空交易。支持多指标组合策略、延迟验证、风险控制和订单管理。

## 开发者提示

1. 使用 Claude Code 开发时，请参阅 **[CLAUDE.md](./CLAUDE.md)** 获取专门指导。
2. 项目内置 skills，Claude Code 可自动使用以下 skill：

   - `/business-logic`：阅读业务逻辑文档（用于检查代码是否遵循业务逻辑，当你更新业务时最好一同更新这个 skill）
   - `/longbridge-openapi-documentation`：查询 LongPort API 文档，根据 API 编写代码

   启用方式：在 Claude Code 中直接输入 `/` 选择 skill，或在对话中提及 skill 名称。

### 核心功能

| 功能       | 说明                                     |
| ---------- | ---------------------------------------- |
| 多指标组合 | RSI、MFI、KDJ、MACD、EMA 组合判断        |
| 双向交易   | 支持做多（牛证）和做空（熊证）           |
| 延迟验证   | 开仓信号可配置延迟确认趋势（默认60秒）   |
| 智能风控   | 浮亏保护、持仓限制、牛熊证回收价检查     |
| 末日保护   | 收盘前15分钟拒绝买入，收盘前5分钟自动清仓 |
| 订单调整   | 自动监控和调整未成交买入订单价格         |
| 内存优化   | 对象池复用减少 GC 压力                   |
| 卖出策略   | 盈利清仓，未盈利仅卖出盈利部分订单       |

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

# 交易标的(示例)
MONITOR_SYMBOL=HSI.HK    # 监控标的（恒生指数）
LONG_SYMBOL=54806        # 做多标的（牛证）
SHORT_SYMBOL=63372       # 做空标的（熊证）

# 交易参数(示例)
TARGET_NOTIONAL=10000    # 每次买入金额（HKD）
LONG_LOT_SIZE=100        # 做多每手股数
SHORT_LOT_SIZE=100       # 做空每手股数

# 风控参数(示例)
MAX_POSITION_NOTIONAL=200000  # 单标持仓上限
MAX_DAILY_LOSS=20000          # 单日亏损上限

# 信号配置（示例，格式见下方）
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
- **指标**：
  - `RSI:n`：任意周期 RSI（n 范围 1-100），如 `RSI:6<20`
  - `MFI`：资金流量指标
  - `K`、`D`、`J`：KDJ 指标
  - `MACD`、`DIF`、`DEA`：MACD 指标
  - `EMA:n`：任意周期 EMA（n 范围 1-250）
- **运算符**：`<`、`>`

**示例**：`RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)` 表示 4 条件满足 3 个**或** J<-20 即可触发。

> **技术指标详解**：详见 [docs/TECHNICAL_INDICATORS.md](./docs/TECHNICAL_INDICATORS.md)

### 四种信号

| 信号     | 类型     | 环境变量          | 验证                                                     |
| -------- | -------- | ----------------- | -------------------------------------------------------- |
| BUYCALL  | 买入做多 | `SIGNAL_BUYCALL`  | 延迟 60 秒验证趋势：T0、T0+5s、T0+10s 指标值均需大于初值 |
| SELLCALL | 卖出做多 | `SIGNAL_SELLCALL` | 立即执行                                                 |
| BUYPUT   | 买入做空 | `SIGNAL_BUYPUT`   | 延迟 60 秒验证趋势：T0、T0+5s、T0+10s 指标值均需小于初值 |
| SELLPUT  | 卖出做空 | `SIGNAL_SELLPUT`  | 立即执行                                                 |

### 卖出策略

- **盈利状态**（当前价 > 成本价）：清空全部持仓
- **未盈利**（当前价 ≤ 成本价）：仅卖出盈利部分（买入价 < 当前价的订单）
- **无符合条件订单**：信号设为 HOLD，跳过本次卖出
- **末日保护**：收盘前5分钟无条件清仓，不受成本价判断影响

---

## 风险控制

### 买入检查顺序

1. **交易频率限制**：同方向买入间隔（默认 60 秒）
2. **买入价格限制**：当前价 > 最新成交价时拒绝（防止追高）
3. **末日保护**：收盘前 15 分钟拒绝买入
4. **牛熊证风险**：牛证距回收价 > 0.5%，熊证 < -0.5%
5. **基础风险检查**：浮亏限制、持仓市值限制

| 检查       | 说明                                | 买入    | 卖出 |
| ---------- | ----------------------------------- | ------- | ---- |
| 交易频率   | 同方向买入间隔                      | ✅ 限制 | ❌   |
| 买入价格   | 当前价 > 最新成交价时拒绝（防追高） | ✅ 检查 | ❌   |
| 末日保护   | 收盘前 15 分钟拒绝买入              | ✅ 限制 | ❌   |
| 牛熊证风险 | 使用监控标的价格计算距回收价        | ✅ 检查 | ❌   |
| 单日亏损   | 浮亏 > MAX_DAILY_LOSS               | ✅ 限制 | ❌   |
| 持仓市值   | 单标持仓 > MAX_POSITION_NOTIONAL    | ✅ 限制 | ❌   |
| 浮亏保护   | 单标浮亏 > MAX_UNREALIZED_LOSS      | ✅ 清仓（市价单） | ❌   |

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
├── index.ts              # 主入口（每秒循环）
├── core/
│   ├── strategy.ts       # 信号生成
│   ├── trader.ts         # 订单执行
│   ├── risk.ts           # 风险检查
│   ├── orderRecorder.ts  # 订单记录
│   ├── signalProcessor.ts # 信号处理
│   ├── signalVerification.ts # 延迟验证
│   ├── marketMonitor.ts  # 行情监控
│   ├── doomsdayProtection.ts # 末日保护
│   └── unrealizedLossMonitor.ts # 浮亏监控
├── services/
│   ├── indicators.ts     # 技术指标计算
│   └── quoteClient.ts    # 行情数据
├── utils/
│   ├── objectPool.ts     # 内存优化
│   ├── indicatorHelpers.ts # 指标辅助函数
│   ├── logger.ts         # 日志系统
│   ├── signalConfigParser.ts # 配置解析
│   ├── helpers.ts        # 工具函数
│   ├── tradingTime.ts    # 交易时段
│   └── accountDisplay.ts # 账户显示
└── config/
    ├── config.index.ts   # API配置
    ├── config.trading.ts # 交易配置
    └── config.validator.ts # 配置验证
```

---

## 运行流程

```
每秒循环（runOnce）：
1. 检查交易时段和交易日
2. 获取K线和实时行情（并发）
3. 计算技术指标（RSI/MFI/KDJ/MACD/EMA）
4. 生成交易信号（立即/延迟）
5. 记录延迟信号的验证历史
6. 验证到期的延迟信号（60秒后）
7. 风险检查（仅买入：频率/价格/末日/牛熊证/浮亏/持仓）
8. 处理卖出信号（成本价判断和数量计算）
9. 执行订单（ELO限价单/MO市价单）
10. 监控未成交买入订单（价格优化）
11. 更新订单记录和账户显示
```

### 交易时段

- **正常日**：09:30-12:00，13:00-16:00
- **半日**：09:30-12:00（无下午盘）

---

## 日志

- **控制台**：实时运行状态
- **文件**：`logs/system/` 和 `logs/debug/`（DEBUG 模式）
- **交易记录**：`logs/trades/YYYY-MM-DD.json`

## 风险提示

1. 不保证所有代码运行正确，若发现 BUG 请提出或自行修复
2. 本系统仅供学习研究，不构成投资建议
3. 技术指标策略不能保证盈利
4. 牛熊证有回收机制，请注意风险
5. 建议先用模拟账户测试

---

## 帮助

- [LongPort 官方文档](https://open.longbridge.com/zh-CN/docs)
- [LongPort/Node.js SDK 文档](https://longportapp.github.io/openapi/nodejs/)
- [Claude Code 官方文档](https://code.claude.com/docs)

---

## 许可证

MIT License (c) 2025 Ulysses Zheng
