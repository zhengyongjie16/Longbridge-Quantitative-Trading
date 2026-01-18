# CLAUDE.md

## WHY - 项目目的

这是一个港股自动化量化交易系统，监控多个标的的技术指标，在轮证上自动执行做多/做空交易。

## WHAT - 技术栈与架构

### 技术栈
- **语言**: TypeScript (严格模式)
- **运行时**: Node.js (ES Module)
- **API**: LongPort OpenAPI
- **配置**: `.env.local` (从 `.env.example` 复制)
- **技术指标**: technicalindicators 库
- **日志**: pino 日志库

### 项目结构
```
src/
├── index.ts                    # 程序主入口（main 和 runOnce 循环）
├── config/                     # 配置模块
│   ├── config.index.ts         # LongPort API 配置
│   ├── config.trading.ts       # 多标的交易配置
│   └── config.validator.ts     # 配置验证
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
│   │   ├── warrantRiskChecker.ts    # 牛熊证风险检查
│   │   ├── positionLimitChecker.ts  # 持仓限制检查
│   │   └── unrealizedLossChecker.ts # 浮亏检查
│   ├── unrealizedLossMonitor/  # 浮亏监控
│   └── doomsdayProtection/     # 末日保护（收盘前清仓）
├── services/                   # 外部服务
│   ├── quoteClient/            # 行情数据客户端
│   ├── marketMonitor/          # 市场监控（价格/指标变化）
│   └── indicators/             # 技术指标计算
│       ├── rsi.ts / kdj.ts / macd.ts / mfi.ts / ema.ts
│       └── index.ts            # buildIndicatorSnapshot 统一入口
└── utils/                      # 工具模块
    ├── objectPool/             # 对象池（减少 GC）
    ├── logger/                 # 日志系统（pino）
    └── helpers/                # 辅助工具
        ├── tradingTime.ts      # 交易时间判断
        ├── positionCache.ts    # 持仓缓存（O(1) 查找）
        ├── signalConfigParser.ts # 信号配置解析
        └── ...

### 核心概念
- **多标的支持**: 通过 `MONITOR_COUNT` 和 `_N` 后缀配置多个监控标的
- **主循环**: 每秒执行一次 `runOnce`，协调所有模块
- **延迟验证**: 开仓信号需经过 15 秒趋势验证后才执行，平仓信号立即执行
- **技术指标**: RSI、KDJ、MACD、MFI、EMA（支持多周期配置）
- **对象池**: Signal、Position、KDJ、MACD、IndicatorRecord、PeriodRecord 等对象复用

## HOW - 工作方式

### 关键工作流程
1. **信号处理流程**: strategy → signalVerification → signalProcessor → trader
2. **对象池使用**: 使用 `objectPool.acquire()` 获取，`objectPool.release()` 释放
3. **日志查看**: `logs/system/` (系统日志), `logs/trades/` (交易记录)
4. **订单监控**: WebSocket 推送订单状态，成交后自动刷新缓存

### 风险检查机制
风险模块采用门面模式（`createRiskChecker`），协调三个子检查器：
- **牛熊证风险**: 检查距离回收价的安全距离
- **持仓限制**: 检查单标的最大持仓市值
- **浮亏检查**: 检查单标的和单日最大浮亏

### 重要约束
- 修改文件前必须先用 Read 工具读取
- 涉及对象池的对象必须及时释放
- TypeScript 严格模式：`isolatedModules: false` (因 longport SDK 使用 const enum)

## 详细文档

需要深入了解特定主题时，请阅读以下文档：

- **业务/程序执行逻辑详解**: 使用 `/core-program-business-logic` skill 查看完整程序和业务逻辑
- **API 文档**: 使用 `/longbridge-openapi-documentation` skill 查询 LongPort API
- **代码规范**: 使用 `/typescript-project-specifications` skill 查看 TypeScript 规范

**注意**: 编写或修改 TypeScript 代码时，必须使用 `/typescript-project-specifications` skill 确保符合项目规范。
