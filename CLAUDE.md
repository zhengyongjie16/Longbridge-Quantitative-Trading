# 港股量化交易系统

基于 LongPort OpenAPI / Node.js / TypeScript 的港股自动化量化交易系统。

## 项目概述

**核心功能**：监控目标资产的技术指标 → 生成交易信号 → 在轮证/ETF上执行双向交易

**技术栈**：TypeScript (ES2022) + Node.js + LongPort OpenAPI + pino 日志

## 项目结构

```
src/
├── index.ts              # 主入口（每秒循环）
├── config/               # 配置模块（API/交易配置）
├── core/                 # 核心业务逻辑
│   ├── strategy/         # 信号生成
│   ├── trader/           # 订单执行与监控
│   ├── risk/             # 风险检查器
│   ├── orderRecorder/    # 订单记录
│   └── doomsdayProtection/ # 末日保护
├── main/                 # 主程序模块
│   ├── processMonitor/   # 单标的处理
│   └── asyncProgram/     # 异步任务（延迟验证、买卖队列）
├── services/             # 外部服务（行情/市场监控）
└── utils/                # 工具模块（日志/对象池/辅助函数）
```

## 项目内置文档及skills

在开始相关任务前，阅读和使用你认为需要的文档及skills：

| skills/文档 | 何时使用 |
|------|---------|
| `/core-program-business-logic` skill | 理解/修改业务逻辑、交易策略、风险控制 |
| `/typescript-project-specifications` skill | 编写/修改任何 TypeScript 代码 |
| `/longport-nodejs-sdk` skill | 调用 LongPort API、查询 SDK 文档、处理行情/订单/资产 |
| `README.md` | 了解完整配置、信号格式、运行流程 |

## 核心代码规范

当你需要编写任何TypeScript代码，强制使用typescript-project-specifications skill
