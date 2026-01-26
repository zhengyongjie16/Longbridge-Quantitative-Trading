# Bun 全量运行时迁移分析方案（Windows 本机）

## 背景与目标
本项目为港股自动化量化交易系统，当前运行时为 Node.js（ESM + TypeScript）。目标是将**运行时全量迁移到 Bun**，同时确保交易稳定性、日志可靠性、WebSocket 推送可靠性，并在可量化指标上至少不劣于 Node。

## 结论摘要
- **可行性：中等偏高**  
  业务逻辑几乎不依赖 Node 独有能力，核心风险集中在第三方 SDK（`longport`）与自定义日志流实现（`Writable` + `drain` + 文件轮转）。
- **合理性：有条件合理**  
  若能接受阶段性验证与回退机制，全量迁移可执行；否则建议保持 Node 作为保底入口。
- **代码质量提升：间接提升**  
  主要来源于工具链简化（`bun run`、`.env` 原生支持）与脚本一致性；不应指望“运行时切换”自动提升代码质量。
- **性能提升：需实测**  
  Bun 可能带来更快启动与更快脚本执行，但交易主循环与行情处理为长生命周期逻辑，性能收益需通过指标验证，不能主观假定。

## 现有代码的 Node 依赖分布
### 低风险（Bun 兼容性高）
- `fs/path` 常规文件读写与路径拼接  
  - 交易记录：`src/core/trader/tradeLogger.ts`
  - 日志目录与文件流：`src/utils/logger/index.ts`
- `crypto.randomUUID`：`src/main/asyncProgram/tradeTaskQueue/index.ts`
- `process.env / process.exit / process.cwd`：主入口与脚本中广泛使用

### 中风险（需重点验证）
- **日志流与 backpressure**：`src/utils/logger/index.ts`  
  自定义 `Writable`、`fs.WriteStream`、`drain` 事件与超时保护，依赖 Node Stream 行为的一致性。
- **WebSocket 推送与 SDK 事件循环语义**  
  - 订单推送：`src/core/trader/orderMonitor.ts`
  - 行情推送：`src/services/quoteClient/index.ts`
- **子进程执行（工具链）**  
  - `scripts/run-sonar.js` 使用 `child_process.execSync`

### 需确认的第三方 SDK
- `longport`：可能包含原生绑定与 WebSocket 实现差异，决定迁移成败。  
- `pino`：依赖 Node Streams，需验证写入、flush 与关闭语义。

## 对代码质量的影响评估
### 直接影响
- **无自动提升**：运行时切换不会改变逻辑正确性与设计质量。
- **类型安全不变**：Bun 运行 TS 不做类型检查，仍需保留 `tsc --noEmit` 作为质量门槛。

### 间接提升点
- **工具链一致性**：统一 `bun run` 可减少脚本分叉，降低运维复杂度。
- **依赖精简**：可考虑移除 `dotenv-cli`、`cross-env`（Bun 原生支持 `.env` 与环境变量）。

## 对性能的影响评估
- **可能收益**：启动速度与脚本执行速度更快；包安装速度更快。
- **不确定收益**：主循环与行情处理为长期运行、网络密集型逻辑，性能瓶颈不一定在 JS 引擎。
- **必须实测**：以交易稳定性和推送处理延迟为优先指标，而非单纯 CPU/吞吐。

## 全量迁移执行方案（Windows 本机）
> 目标：最终以 Bun 作为唯一运行时，同时确保交易稳定性与可回退能力。

### 阶段 0：兼容性审计（1-2 天）
**目的：定位“不可迁移点”。**
- 确认 `longport` 是否包含 Node-API 原生绑定（`.node` 文件或 node-gyp 构建痕迹）。
- 验证 Bun 在 Windows 本机运行的可用性与版本要求（以实际版本为准）。
- 确定 `pino` 与自定义流在 Bun 下的基础可运行性。

### 阶段 1：最小化运行验证（1-2 天）
**目的：在不改业务逻辑的前提下验证主程序跑通。**
- 使用 Bun 直接运行入口 `src/index.ts`。
- 验证 `.env.local` 读取、配置校验、行情订阅初始化、订单推送回调是否可用。
- 不修改策略与风控逻辑，仅验证运行时兼容性。

### 阶段 2：关键链路压力验证（2-4 天）
**目的：验证“日志 + WebSocket + 订单”三条关键链路。**
- **日志链路**：高频日志写入、文件轮转与 `drain` 行为一致性。  
- **行情链路**：WebSocket 推送与缓存更新稳定性。  
- **订单链路**：订单状态推送、撤改单、超时处理与重启恢复逻辑。

### 阶段 3：脚本与运行入口统一（1-2 天）
**目的：全量迁移到 Bun 运行入口。**
- 统一 `start/dev/tools` 入口到 `bun run`。
- 保留 `type-check`（`tsc --noEmit`）作为质量门槛。
- 处理 `perf:*` 脚本（`clinic` 仅 Node 可用，可替换或保留 Node 专用入口）。

### 阶段 4：稳定性窗口与回退阈值（至少 2 周）
**目的：确保交易稳定性不回退。**
- 运行连续交易日（模拟/小仓位）稳定性验证。
- 达成阈值后移除 Node 入口（可选）。

## 关键验证清单（必须完成）
### 运行时兼容性
- [ ] Bun 在 Windows 本机稳定运行（无异常崩溃、无明显内存泄漏）
- [ ] `process.on('SIGINT'/'SIGTERM')` 触发清理与退出逻辑正常

### WebSocket 与 SDK
- [ ] 行情订阅推送稳定、延迟可控（`QuoteContext`）
- [ ] 订单推送回调稳定（`setOnOrderChanged`）
- [ ] 撤改单与超时逻辑正常执行

### 日志系统
- [ ] `DateRotatingStream` 文件轮转正常
- [ ] `drain` 与超时保护逻辑触发符合预期
- [ ] `flush/close` 退出阶段能落盘，不丢日志

### 性能指标（建议）
- [ ] 主循环周期耗时对比（Node vs Bun）
- [ ] 行情推送到处理完成的平均延迟
- [ ] 内存曲线与 GC 波动（长时间运行）

## 回退策略（必须预留）
- 保留一个 Node 入口脚本用于紧急回退（至少保留至稳定窗口结束）。
- 日志中记录运行时标识（Node/Bun），便于对比与定位问题。

## 脚本调整建议（不改变业务逻辑）
### 建议的新入口示例
- `start`: `bun src/index.ts`
- `dev:watch`: `bun --watch src/index.ts`
- `find-warrant`: `bun tools/findWarrant.ts`
- `analyze-indicators`: `bun tools/indicatorAnalysis.ts`
- `monitor-daily`: `bun tools/dailyKlineMonitor.ts`
- `sonarqube`: `bun scripts/run-sonar.js`
- `sonarqube:report`: `bun scripts/get-report.js`

### 保留的质量门槛
- `type-check`: `tsc --noEmit`

### 可能移除的依赖（可选）
- `dotenv-cli`、`cross-env`（Bun 原生支持）
- `clinic`（Bun 不兼容；可保留 Node 专用入口或改用 Bun profile）

## 迁移完成验收标准
- 交易流程在 Bun 下连续运行无异常（含模拟与小仓位）
- 行情与订单推送无明显丢失或延迟异常
- 日志稳定落盘，文件轮转正常
- 关键性能指标不低于 Node 版本

## 附录：关键代码点
- 日志系统：`src/utils/logger/index.ts`
- 订单推送：`src/core/trader/orderMonitor.ts`
- 行情订阅：`src/services/quoteClient/index.ts`
- 入口与清理：`src/index.ts`、`src/services/cleanup/index.ts`
