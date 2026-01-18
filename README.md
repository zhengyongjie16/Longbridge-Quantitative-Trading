# LongBridge 证券港股自动化量化交易系统

## 项目简介及重要提示

### 项目介绍

基于 LongPort OpenAPI / Node.js / TypeScript 的港股自动化量化交易系统，通过监控目标资产（如恒生指数）的技术指标，在轮证上自动执行做多/做空交易。支持多指标组合策略、延迟验证、风险控制和订单管理。

### 重要提示（必读）

1. 请先务必掌握港股、轮证以及技术指标的相关知识，轮证自带杠杆属性且存在到期时间和回收等机制，这些因素都存在较大风险。
2. 该程序一般不会交易正股（正股仅用作实时分析，即配置中的监控标的），而是在轮证上进行多空交易，主要为交易做多或做空方向的权证或牛熊证，这存在较高风险。
3. 目前的交易策略仅针对日内交易，在交易时段内每秒获取分钟级k线进行技术指标的计算用于生成交易信号（虽然是获取分钟k线但最新的k线是是实时变动的），由于通过交易轮证这样的高杠杆衍生品，所以不需要监控大周期的k线，但这也存在更高的风险。
4. 请务必掌握相关代码知识（主要为typescript），不建议非开发者使用。
5. 该程序代码几乎全部由vibe coding（主要使用claude模型）编写，推荐使用顶级模型进行优化和再开发，这是保证代码质量的关键。
6. 请务必先使用模拟账户进行调试。

## 开发者提示

1. 使用 Claude Code 开发时，请参阅 **[CLAUDE.md](./CLAUDE.md)** 获取专门指导。
2. 项目内置 skills，Claude Code 可自动使用以下 skill：
  - `/core-program-business-logic`：阅读程序以及业务逻辑（当重构代码时应一并修改该skill文档）
  - `/longbridge-openapi-documentation`：查询 LongPort API 文档，根据 API 编写代码
  - `/typescript-project-specifications`：严格的代码规范，编写和检查任何ts代码时应该使用这个skill

### 核心功能


| 功能    | 说明                        |
| ----- | ------------------------- |
| 多标的支持 | 支持并发监控多个标的，每个标的独立配置       |
| 多指标组合 | RSI、MFI、KDJ、MACD、EMA 组合判断 |
| 双向交易  | 支持做多（牛证）和做空（熊证）           |
| 延迟验证  | 买入和卖出信号可独立配置延迟验证（默认60秒，T0/T0+5s/T0+10s 三点趋势验证） |
| 智能风控  | 浮亏保护、持仓限制、牛熊证回收价检查        |
| 末日保护  | 收盘前15分钟拒绝买入并撤销未成交订单，收盘前5分钟自动清仓 |
| 订单调整  | 自动监控和调整未成交买入订单价格（支持超时撤单） |
| 内存优化  | 对象池复用减少 GC 压力             |
| 卖出策略  | 盈利清仓，未盈利仅卖出盈利部分订单         |


---

## 快速开始

### 安装

```bash
npm install
cp .env.example .env.local
# 编辑 .env.local 填写配置
```

### 配置必需参数 (.env.local)

系统支持多个监控标的，通过 `MONITOR_COUNT` 指定数量，每个监控标的使用后缀 `_N`（N从1开始）区分配置。

```env
# API 配置
LONGPORT_APP_KEY=your_key
LONGPORT_APP_SECRET=your_secret
LONGPORT_ACCESS_TOKEN=your_token

# 监控标的数量（必须 >= 1）
MONITOR_COUNT=1

# 交易标的配置（使用后缀 _N，N从1开始）
# 示例：第一个监控标的（_1）
MONITOR_SYMBOL_1=HSI.HK    # 监控标的（恒生指数）
LONG_SYMBOL_1=54806        # 做多标的（牛证）
SHORT_SYMBOL_1=63372       # 做空标的（熊证）

# 交易参数(示例)
TARGET_NOTIONAL_1=10000    # 每次买入金额（HKD）

# 风控参数(示例)
MAX_POSITION_NOTIONAL_1=200000  # 单标持仓上限
MAX_DAILY_LOSS_1=20000          # 单日亏损上限

# 信号配置（示例，格式见下方）
SIGNAL_BUYCALL_1=(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)
SIGNAL_SELLCALL_1=(RSI:6>80,MFI>85,D>79,J>100)/3|(J>110)
SIGNAL_BUYPUT_1=(RSI:6>80,MFI>85,D>80,J>100)/3|(J>120)
SIGNAL_SELLPUT_1=(RSI:6<20,MFI<15,D<22,J<0)/3|(J<-15)

# 如需配置第二个监控标的，使用后缀 _2，以此类推
# MONITOR_SYMBOL_2=...
# LONG_SYMBOL_2=...
```

### 启动

```bash
npm run dev
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

> **技术指标详解**：详见 [docs/TECHNICAL_INDICATORS.md](./docs/TECHNICAL_INDICATORS.md)

### 交易策略

#### 信号生成与验证流程

系统采用延迟验证机制，所有交易信号（买入和卖出）都需要经过延迟验证后才能执行。

**四种信号类型**：


| 信号       | 类型   | 环境变量                | 延迟验证规则                               |
| -------- | ---- | ------------------- | ------------------------------------ |
| BUYCALL  | 买入做多 | `SIGNAL_BUYCALL_N`  | T0、T0+5s、T0+10s 三个时间点的指标值均需**大于**初始值（上涨趋势） |
| SELLCALL | 卖出做多 | `SIGNAL_SELLCALL_N` | T0、T0+5s、T0+10s 三个时间点的指标值均需**小于**初始值（下跌趋势） |
| BUYPUT   | 买入做空 | `SIGNAL_BUYPUT_N`   | T0、T0+5s、T0+10s 三个时间点的指标值均需**小于**初始值（下跌趋势） |
| SELLPUT  | 卖出做空 | `SIGNAL_SELLPUT_N`  | T0、T0+5s、T0+10s 三个时间点的指标值均需**大于**初始值（上涨趋势） |


> **注意**：环境变量中的 `N` 表示监控标的索引（如 `_1`、`_2`）。买入和卖出的延迟验证时间（默认60秒）、验证指标可独立配置。

**延迟验证机制**：

1. 信号触发时记录指标初始值（indicators1）
2. 在触发时间窗口内记录指标值（T0-5s 至 T0+15s）
3. 等待配置的延迟时间（默认60秒）后进行验证，检查 T0、T0+5s、T0+10s 三个时间点的指标值
4. 每个时间点允许 ±5 秒误差
5. 验证通过后信号进入执行流程，验证失败则丢弃该信号

#### 买入策略

1. **信号生成**：监控标的技术指标满足配置条件时，生成延迟验证买入信号
2. **延迟验证**：等待配置的延迟时间（默认60秒，范围0-120秒），验证 T0/T0+5s/T0+10s 三点指标趋势
3. **风险检查**：通过验证后，执行多层风险检查（频率限制、价格限制、末日保护、牛熊证风险、浮亏限制、持仓限制）
4. **订单执行**：风险检查通过后，按目标金额计算买入数量并提交限价单（默认 ELO 增强限价单）

#### 卖出策略

1. **信号生成**：监控标的技术指标满足配置条件，且存在买入订单记录时，生成延迟验证卖出信号
2. **延迟验证**：等待配置的延迟时间（默认60秒，范围0-120秒），验证 T0/T0+5s/T0+10s 三点指标趋势
3. **智能平仓判断**（可通过 `SMART_CLOSE_ENABLED_N` 关闭）：根据当前价格与持仓成本价的关系决定卖出数量：
  - **当前价 > 持仓成本价**：清空全部持仓（盈利状态）
  - **当前价 ≤ 持仓成本价**：仅卖出历史买入订单中买入价低于当前价的部分（部分盈利订单）
  - **无符合条件订单**：信号设为 HOLD，跳过本次卖出
4. **特殊规则**：末日保护程序的清仓信号无条件清仓，不受智能平仓判断影响
5. **订单执行**：确定卖出数量后提交订单执行（默认 MO 市价单）

---

## 风险控制

### 买入检查顺序

1. **交易频率限制**：同方向买入间隔（默认 60 秒）
2. **买入价格限制**：当前价 > 最新成交价时拒绝（防止追高）
3. **末日保护**：收盘前 15 分钟拒绝买入
4. **牛熊证风险**：牛证距回收价 > 0.5%，熊证 < -0.5%
5. **基础风险检查**：浮亏限制、持仓市值限制


| 检查    | 说明                           | 买入          | 卖出  |
| ----- | ---------------------------- | ----------- | --- |
| 交易频率  | 同方向买入间隔（默认60秒）               | ✅ 限制        | ❌   |
| 买入价格  | 当前价 > 最新成交价时拒绝（防追高）          | ✅ 检查        | ❌   |
| 末日保护  | 收盘前 15 分钟拒绝买入                | ✅ 限制        | ❌   |
| 牛熊证风险 | 使用监控标的价格计算距回收价               | ✅ 检查        | ❌   |
| 单日亏损  | 浮亏 > MAX_DAILY_LOSS          | ✅ 限制        | ❌   |
| 持仓市值  | 单标持仓 > MAX_POSITION_NOTIONAL | ✅ 限制        | ❌   |
| 浮亏保护  | 单标浮亏 > MAX_UNREALIZED_LOSS   | 实时监控（市价单清仓） | ❌   |

### 可选配置

**全局配置**：


| 参数                                  | 默认值   | 说明                                       |
| ----------------------------------- | ----- | ---------------------------------------- |
| `DOOMSDAY_PROTECTION`               | `true`  | 启用末日保护                                 |
| `DEBUG`                             | `false` | 启用调试日志                                 |
| `TRADING_ORDER_TYPE`                | `ELO`   | 交易订单类型（LO 限价单 / ELO 增强限价单 / MO 市价单） |
| `LIQUIDATION_ORDER_TYPE`            | `MO`    | 清仓订单类型（LO / ELO / MO）                 |
| `ORDER_MONITOR_TIMEOUT_SECONDS`     | `180`   | 订单监控超时时间（秒，范围30-600）               |
| `ORDER_MONITOR_PRICE_UPDATE_INTERVAL` | `5`   | 订单价格更新间隔（秒，范围1-60）                  |
| `ENABLE_ORDER_TIMEOUT_MONITOR`      | `true`  | 启用订单超时监控（超时后自动撤单）                  |


**每个监控标的配置**（使用后缀 `_N`，如 `_1`、`_2`）：


| 参数                                  | 默认值      | 说明                                       |
| ----------------------------------- | -------- | ---------------------------------------- |
| `MAX_UNREALIZED_LOSS_PER_SYMBOL_N`  | `0`      | 单标浮亏保护阈值（0表示禁用）                        |
| `VERIFICATION_DELAY_SECONDS_BUY_N`  | `60`     | 买入延迟验证时间（秒，范围0-120）                    |
| `VERIFICATION_INDICATORS_BUY_N`     | `K,MACD` | 买入验证指标（逗号分隔，可选：K/D/J/MACD/DIF/DEA/EMA:n） |
| `VERIFICATION_DELAY_SECONDS_SELL_N` | `60`     | 卖出延迟验证时间（秒，范围0-120）                    |
| `VERIFICATION_INDICATORS_SELL_N`    | `K,MACD` | 卖出验证指标（逗号分隔，可选：K/D/J/MACD/DIF/DEA/EMA:n） |
| `BUY_INTERVAL_SECONDS_N`            | `60`     | 同向买入间隔（秒，范围10-600）                      |
| `SMART_CLOSE_ENABLED_N`             | `true`   | 启用智能平仓策略（禁用后卖出信号直接全仓卖出）         |


---

## 系统架构

```
src/
├── index.ts                    # 主入口（每秒循环）
├── config/                     # 配置模块
│   ├── config.index.ts         # LongPort API 配置
│   ├── config.trading.ts       # 多标的交易配置
│   ├── config.validator.ts     # 配置验证
│   └── types.ts                # 配置类型定义
├── constants/                  # 全局常量定义
├── types/                      # TypeScript 类型定义
├── core/                       # 核心业务逻辑
│   ├── strategy/               # 信号生成
│   ├── signalVerification/     # 延迟验证
│   ├── signalProcessor/        # 风险检查与卖出计算
│   ├── trader/                 # 订单执行与监控
│   │   ├── orderExecutor.ts    # 订单执行
│   │   ├── orderMonitor.ts     # 订单状态监控（WebSocket）
│   │   ├── orderCacheManager.ts # 订单缓存管理
│   │   ├── accountService.ts   # 账户服务
│   │   ├── rateLimiter.ts      # API 限流
│   │   └── tradeLogger.ts      # 交易日志
│   ├── orderRecorder/          # 订单记录与查询
│   ├── risk/                   # 风险检查器（门面模式）
│   ├── unrealizedLossMonitor/  # 浮亏监控
│   └── doomsdayProtection/     # 末日保护（收盘前清仓）
├── services/                   # 外部服务
│   ├── quoteClient/            # 行情数据客户端
│   ├── marketMonitor/          # 市场监控（价格/指标变化）
│   └── indicators/             # 技术指标计算（RSI/KDJ/MACD/MFI/EMA）
└── utils/                      # 工具模块
    ├── objectPool/             # 对象池（减少 GC）
    ├── logger/                 # 日志系统（pino）
    └── helpers/                # 辅助工具
        ├── tradingTime.ts      # 交易时间判断
        ├── positionCache.ts    # 持仓缓存（O(1) 查找）
        ├── signalConfigParser.ts # 信号配置解析
        ├── indicatorHelpers.ts # 指标辅助函数
        ├── accountDisplay.ts   # 账户显示
        └── quoteHelpers.ts     # 行情辅助函数
```

---

## 运行流程

```
每秒循环（runOnce）：
1. 检查交易日和交易时段
2. 末日保护检查（收盘前15分钟撤单、收盘前5分钟清仓）
3. 批量获取所有标的行情（减少 API 调用）
4. 并发处理所有监控标的：
   a. 监控价格变化和浮亏检查
   b. 获取K线数据，计算技术指标（RSI/MFI/KDJ/MACD/EMA）
   c. 监控指标变化
   d. 生成延迟验证信号（买入和卖出）
   e. 记录待验证信号的指标历史值（T0-5s 至 T0+15s 窗口）
   f. 验证到期信号（等待配置的延迟时间后，检查 T0/T0+5s/T0+10s 趋势）
   g. 风险检查（买入：频率/价格/末日/牛熊证/浮亏/持仓）
   h. 智能平仓处理（成本价判断和数量计算）
   i. 执行订单
5. 订单监控（WebSocket 推送订单状态，未成交订单价格调整和超时撤单）
6. 订单成交后刷新缓存（账户、持仓、浮亏数据）
```

---

## 日志

- **控制台**：实时运行状态
- **文件**：`logs/system/` 、 `logs/debug/`（DEBUG 模式）和`logs/trades/`（交易信息）
- **交易记录**：`logs/trades/YYYY-MM-DD.json`

---

## 帮助

- [LongPort 官方文档](https://open.longbridge.com/zh-CN/docs)
- [LongPort/Node.js SDK 文档](https://longportapp.github.io/openapi/nodejs/)
- [Claude Code 官方文档](https://code.claude.com/docs)

---

## 许可证

MIT License (c) 2026 Ulysses Zheng