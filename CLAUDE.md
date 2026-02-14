## 项目概述

- **系统简介**：基于 LongPort OpenAPI / Node.js / TypeScript 的港股自动化量化交易系统。
- **核心功能**：监控目标资产的技术指标 → 生成交易信号 → 在轮证/ETF上执行双向交易
- **技术栈**：TypeScript (ES2022) + Node.js + LongPort OpenAPI + pino 日志

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
| `/core-program-business-logic` | 理解/修改业务逻辑、交易策略、风险控制 |
| `/typescript-project-specifications` | 编写/修改任何 TypeScript 代码 |
| `/longport-nodejs-sdk` | 调用 LongPort API、查询 SDK 文档、处理行情/订单/资产 |
| `README.md` | 了解完整配置、信号格式、运行流程 |

## 行为约束

- 当我没有明确让你修改和重构时你不能进行代码修改，你必须确认我的指令
- 当我没有明确让你编写文档时你不能新建文档，你必须确认我的指令
- 在你执行任务过程中如果有疑问或存在不确定的地方必须询问我的意见，必须与我进行确认

## 方案规范

- 当需要你给出修改或重构方案时，所有方案必须是系统性且完整性的修改或重构，不允许给出兼容性或补丁性的方案
- 不允许自行给出我提供的需求以外的方案，例如一些兜底方案，这可能导致业务逻辑偏移问题
- 必须确保方案的逻辑正确，必须经过全链路的逻辑验证
- 任何不确定的地方必须同我进行确认

## 代码规范

- 当你需要编写任何TypeScript代码，强制使用typescript-project-specifications skill
