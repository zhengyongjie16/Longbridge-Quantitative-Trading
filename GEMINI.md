# GEMINI.md

本文档为 Gemini 在处理 `longBrige-automation-program` 代码库时提供上下文和指南。

## 项目概览

**名称**: LongBridge 港股自动化量化交易系统
**目标**: 基于技术指标监控目标资产（如恒生指数），自动执行港股窝轮/牛熊证的双向交易（做多/做空）。
**核心逻辑**: 多指标组合策略，开仓信号采用延迟验证机制，平仓信号立即执行。

## 技术栈与核心库

-   **语言**: TypeScript (Node.js)
-   **券商 API**: LongPort OpenAPI (`longport` 包)
-   **指标库**: `technicalindicators` 包
-   **日志**: `pino`
-   **环境配置**: `.env`

## 系统架构

系统每秒运行一次主循环 (`runOnce`)。

```text
src/
├── index.ts              # 入口点。主循环 `runOnce()`
├── core/
│   ├── strategy/         # 信号生成 (技术指标评估)
│   ├── signalVerification/  # 延迟信号验证 (趋势确认)
│   ├── signalProcessor/  # 信号后处理 (风险检查、数量计算)
│   ├── trader/           # 订单执行与监控 (未成交订单管理)
│   ├── risk/             # 风控逻辑 (限制、熔断)
│   ├── orderRecorder/    # 订单历史追踪 (持久化缓存)
│   ├── marketMonitor/    # 实时价格/指标监控
│   ├── doomsdayProtection/  # 收盘前安全机制 (末日保护)
│   └── unrealizedLossMonitor/  # 实时盈亏监控与止损
├── services/
│   ├── indicators/       # 指标计算封装 (RSI, MACD 等)
│   └── quoteClient/      # LongPort 行情 API 封装
├── utils/
│   ├── helpers.ts        # 通用工具函数
│   ├── signalConfigParser.ts  # 信号配置字符串解析
│   ├── tradingTime.ts    # 交易时间校验
│   ├── logger.ts         # 集中式日志
│   ├── objectPool.ts     # 内存优化 (对象池)
│   └── accountDisplay.ts # CLI 界面渲染
└── config/
    ├── config.index.ts   # 通用与 API 配置
    ├── config.trading.ts # 交易逻辑参数
    └── config.validator.ts # 配置验证模式
```

## 关键业务逻辑

### 1. 信号类型
| 信号 | 含义 | 执行方式 |
| :--- | :--- | :--- |
| `BUYCALL` | 开多仓 (买入牛证/Call) | **延迟验证** (默认 60秒) |
| `SELLCALL` | 平多仓 | **立即执行** |
| `BUYPUT` | 开空仓 (买入熊证/Put) | **延迟验证** (默认 60秒) |
| `SELLPUT` | 平空仓 | **立即执行** |
| `HOLD` | 无动作 | - |

### 2. 延迟验证 (趋势确认)
为防止假突破，开仓信号 (`BUYCALL`/`BUYPUT`) 不会立即执行。
-   **机制**: 等待 `VERIFICATION_DELAY_SECONDS` (默认 60秒)。
-   **检查**: 对比 T0, T0+5s, 和 T0+10s 的指标值与初始信号时的值。
    -   对于 **BUYCALL**: 指标必须显示 **上涨** 趋势 (当前值 > 初始值)。
    -   对于 **BUYPUT**: 指标必须显示 **下跌** 趋势 (当前值 < 初始值)。

### 3. 风险控制 (5道关卡)
在任何 `BUY` 执行前，必须依次通过以下检查：
1.  **频率限制**: 同方向交易的最小间隔 (默认 60秒)。
2.  **价格检查**: 当前价 <= 最新成交价 (防止追高)。
3.  **末日保护**: 收盘前 15 分钟禁止买入。
4.  **牛熊证安全**:
    -   牛证: 距回收价 > 0.5%
    -   熊证: 距回收价 < -0.5%
5.  **账户风控**:
    -   单日亏损 < `MAX_DAILY_LOSS`
    -   持仓市值 < `MAX_POSITION_NOTIONAL`

### 4. 卖出策略
-   **盈利状态** (当前价 > 成本价): 卖出 **100%** 持仓。
-   **未盈利状态** (当前价 <= 成本价): **仅** 卖出当前处于盈利状态的那部分订单 (FIFO 或指定批次匹配)。
-   **紧急情况**:
    -   **末日清仓 (收盘前 5分钟)**: 市价单 (MO) 卖出所有持仓。
    -   **止损**: 如果浮动亏损 > 阈值，市价单 (MO) 卖出所有持仓。

## 技术约束与规范

1.  **代码标准化**: 必须使用 `normalizeHKSymbol()` (例如 `700` -> `00700.HK`)。
2.  **数值处理**: LongPort API 返回 `Decimal` 对象。进行数学运算前必须使用 `decimalToNumber()` 转换。
3.  **订单类型**:
    -   标准开/平仓: **ELO** (增强限价单)。
    -   紧急平仓: **MO** (市价单)。
4.  **并发处理**:
    -   **买入**: 必须使用最新数据 (await `getAccountBalance`)。
    -   **卖出**: 可以使用缓存的持仓数据以加快反应速度。
5.  **API 限制**: 交易 API 频率限制严格 (30次请求 / 30秒)。`Trader` 模块负责队列和限流。
6.  **内存优化**: 对高频对象 (如市场行情 Ticks) 使用 `ObjectPool` 以减少 GC 压力。

## 配置 (.env)

调试时需检查的关键变量：
-   `MONITOR_SYMBOL`: 生成信号的监控标的 (如 `HSI.HK`)。
-   `LONG_SYMBOL`/`SHORT_SYMBOL`: 实际交易的标的 (窝轮/牛熊证)。
-   `SIGNAL_...`: 定义开/平仓条件的逻辑字符串。

## 常见任务

-   **调整策略**: 编辑 `.env` 中的信号字符串。
-   **添加指标**:
    1.  更新 `services/indicators/index.ts`。
    2.  在 `utils/signalConfigParser.ts` 中注册。
-   **修改风控**: 编辑 `core/risk/index.ts`。

## 开发指南

-   **构建**: `npm run build`
-   **Lint**: `npm run lint`
-   **启动**: `npm start`