# CLAUDE.md

## WHY - 项目目的

这是一个港股自动化量化交易系统，监控多个标的的技术指标，在轮证上自动执行做多/做空交易。

## WHAT - 技术栈与架构

### 技术栈
- **语言**: TypeScript (严格模式)
- **运行时**: Node.js
- **API**: LongPort OpenAPI
- **配置**: `.env.local` (从 `.env.example` 复制)

### 项目结构
```
src/
├── core/                       # 核心业务逻辑
│   ├── strategy/               # 信号生成
│   ├── signalVerification/     # 延迟验证
│   ├── signalProcessor/        # 风险检查与卖出计算
│   ├── trader/                 # 订单执行与监控
│   ├── orderRecorder/          # 订单记录与查询
│   ├── risk/                   # 风险检查器
│   ├── unrealizedLossMonitor/  # 浮亏监控
│   ├── doomsdayProtection/     # 末日保护
│   └── marketMonitor/          # 市场监控
├── services/                   # 外部服务
│   ├── quoteClient/            # 行情数据
│   └── indicators/             # 技术指标计算
└── utils/                      # 工具模块
    ├── objectPool/             # 对象池
    └── logger/                 # 日志系统
```

### 核心概念
- **多标的支持**: 通过 `MONITOR_COUNT` 和 `_N` 后缀配置多个监控标的
- **主循环**: 每秒执行一次 `runOnce`，协调所有模块
- **延迟验证**: 所有信号需经过趋势验证后才执行
- **对象池**: Signal、Position、KDJ、MACD 等对象复用，减少 GC

## HOW - 工作方式

### 关键工作流程
1. **信号处理流程**: strategy → signalVerification → signalProcessor → trader
2. **对象池使用**: 使用 `objectPool.acquire()` 获取，`objectPool.release()` 释放
3. **日志查看**: `logs/system/` (系统日志), `logs/trades/` (交易记录)

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
