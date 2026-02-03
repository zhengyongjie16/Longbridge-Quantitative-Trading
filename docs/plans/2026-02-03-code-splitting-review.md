# 代码文件拆分评估报告（2026-02-03）

## 范围与方法
- 范围：仅评估 `src/` 与主入口 `src/index.ts`；排除 `src/utils`、`src/config`、`src/constants`、`src/types`；不包含 `tests/`、`tools/` 与根目录 `utils/`
- 方法：先行数排行筛选长文件 → 重点文件通读 → 结合业务规则与“不过度拆分”标准给出边界与风险
- 原则：拆分仅在业务模块内就近归档；`src/utils`/`src/config`/`src/constants`/`src/types` 保持不动；不做 re-export
- 仅保留 P0/P1 拆分建议，P0/P1 以外文件不做重构

## 必要性判据（避免过度拆分）
- 仅在“职责边界清晰 + 共享状态可控 + 能降低修改冲突/提升测试隔离”同时满足时拆分
- 如果只是行数偏多但逻辑仍高度内聚，优先做文件内分区、抽取小函数、整理调用顺序
- 涉及交易时序/席位版本等强耦合逻辑，拆分必须能保持顺序与语义不变，否则不拆
- 任一候选项未满足判据，一律不拆

## 行数排行（仅 P0/P1 Top 5）
| 排名 | 文件 | 行数 | 备注 |
| --- | --- | --- | --- |
| 1 | `src/index.ts` | 786 | 主入口与初始化 |
| 2 | `src/services/autoSymbolManager/index.ts` | 754 | 自动寻标/换标状态机 |
| 3 | `src/main/asyncProgram/monitorTaskProcessor/index.ts` | 695 | 监控任务处理器 |
| 4 | `src/main/processMonitor/index.ts` | 557 | 单标的处理 |
| 5 | `src/core/signalProcessor/index.ts` | 507 | 信号处理与风控 |

## 候选清单（按优先级）
**P0（必要性高，但仍需满足判据才拆）**
- `src/index.ts`
- `src/services/autoSymbolManager/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- `src/main/processMonitor/index.ts`

**P1（默认不拆，只有触发条件成立才考虑）**
- `src/core/signalProcessor/index.ts`
> 说明：除 P0/P1 外不做重构，不再给出拆分建议。

## 拆分建议与边界（P0，满足判据时才用）
说明：P0 仍需满足必要性判据；未满足则保持单文件，仅做内部整理。
### `src/index.ts`
- **建议边界**
  - 启动配置与验证：dotenv、`createConfig`、`createMultiMonitorTradingConfig`、`validateAllConfig`
  - 交易日/开盘门控：`resolveTradingDayInfo`、`createStartupGate`
  - 启动期数据初始化：账户/持仓、订单初始化、席位准备、回放日志
  - 监控上下文构建：`createMonitorContext` 及其依赖（策略/风控/自动寻标/延迟验证/浮亏）
  - 异步架构 wiring：队列、处理器、worker、回调注册
  - 主循环：`mainProgram` 调度 + 异常捕获
- **风险点**
  - 初始化顺序严格（账户/订单/席位/延迟验证回调/队列），拆分必须保序
  - 延迟验证回调与席位版本校验耦合，拆分时避免丢失上下文

### `src/main/processMonitor/index.ts`
- **建议边界**
  - 席位同步与队列清理：席位变化、`clearQueuesForDirection`、`SEAT_REFRESH` 调度
  - 自动寻标/换标触发：`AUTO_SYMBOL_TICK`、`AUTO_SYMBOL_SWITCH_DISTANCE`
  - 风险任务调度：距回收价检查、浮亏检查
  - 指标管道：获取 K 线、构建快照、缓存、监控指标变化
  - 信号管道：生成 → 校验席位/行情 → enrich → 分流入队/验证器
- **风险点**
  - 对象池释放路径复杂，拆分后需统一释放策略
  - 席位版本与信号入队强耦合，必须保持同一时点视图

### `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- **建议边界**
  - 队列调度与执行器：`start/stop/scheduleNextProcess`
  - 任务处理器分拆：auto-symbol、seat refresh、清仓距离、浮亏检查
  - 快照校验与刷新助手：`validateSeatSnapshotsAfterRefresh`、`createRefreshHelpers`
- **风险点**
  - 刷新门控与快照校验存在时序依赖，拆分要保证刷新前后校验语义不变

### `src/services/autoSymbolManager/index.ts`
- **建议边界**
  - 阈值解析与输入构造：`resolveAutoSearchThresholds`、`buildFindBestWarrantInput`
  - 席位状态管理：`buildSeatState`、`updateSeatState`、`clearSeat`、`ensureSeatOnStartup`
  - 自动寻标逻辑：`maybeSearchOnTick`
  - 换标状态机：`processSwitchState`、`maybeSwitchOnDistance`
  - 交易信号构造：`buildOrderSignal`、数量计算
- **风险点**
  - 换标状态机跨多个 stage，拆分必须保持阶段转换原子性
  - 日内抑制与版本号升级是关键业务约束，不可改变触发时机

## P1 拆分触发条件（简版，未满足不拆）
- `src/core/signalProcessor/index.ts`：当风险流水线持续扩展或复用需求明显时再拆；边界可按“卖出数量计算/风险流水线”

## 风险点与不建议拆分
- `src/utils/**`、`src/config/**`、`src/constants/**`、`src/types/**`：明确不在本次优化范围，保持现状
- `tests/`、`tools/`、根目录 `utils/`：不在本次范围
- 不为了“行数”而拆分：如果内聚性高且改动集中，优先保持单文件
- 业务关键点必须稳定：席位版本号、延迟验证时序、对象池释放、清仓冷却与末日保护

## 可能的目录结构示例（仅在确需拆分时）
仅在对应 P0/P1 满足判据且触发拆分时采用，不要求一次性拆全。
```text
src/main/processMonitor/
  index.ts
  seatSync.ts
  autoSymbolTasks.ts
  riskTasks.ts
  indicatorPipeline.ts
  signalPipeline.ts
```

```text
src/main/asyncProgram/monitorTaskProcessor/
  index.ts
  queueRunner.ts
  helpers/
    seatSnapshot.ts
    refreshHelpers.ts
  handlers/
    autoSymbol.ts
    seatRefresh.ts
    liquidationDistance.ts
    unrealizedLoss.ts
```

