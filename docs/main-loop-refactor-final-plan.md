# 主循环模块重构最终方案

> 文档版本：1.4
> 创建日期：2026-01-22
> 更新日期：2026-01-22
> 基于文档：[main-loop-refactor-plan.md](./main-loop-refactor-plan.md)
> 状态：**已审核通过，可实施**
>
> **v1.4 更新**（新增需求）：
> - **runOnce → mainProgram 重命名**：主循环函数和模块改名为 `mainProgram`，更准确反映其"主程序"语义
> - **program → asyncProgram 移动**：将 `src/program/` 重命名为 `asyncProgram` 并移至 `src/main/asyncProgram/`，强化异步任务处理模块的语义和归属
> - **保持所有子模块结构不变**：`asyncProgram` 内部的所有子模块（`buyProcessor/`, `sellProcessor/`, `delayedSignalVerifier/`, `indicatorCache/`, `tradeTaskQueue/`）结构保持不变
> - **更新所有相关命名**：`RunOnceContext` → `MainProgramContext`，所有涉及 `runOnce` 和 `program` 的代码、注释、类型都相应更新
>
> **v1.3 更新**：
> - **彻底移除 index 导出入口**：`main/index.ts` 和 `init/index.ts` 不再作为导出入口，使用者直接从源模块导入
> - **子模块独享类型放在子模块内**：`ProcessMonitorParams` 移至 `main/processMonitor/types.ts`，`CleanupContext` 移至 `init/cleanup/types.ts`
> - **公共类型放在模块级 types.ts**：`MainProgramContext`（原 `RunOnceContext`）保留在 `main/types.ts`（被多个模块使用）
> - **严格符合 `typescript-project-specifications` 规范**：遵循"最近公共位置"原则
>
> **v1.2 更新**：
> - 移除 index 导出入口，直接从源模块导入（避免 re-export 模式）
> - 子模块包含自己的 types.ts 和 utils.ts（按需创建）
> - 严格符合 `typescript-project-specifications` 规范

---

## 1. 方案审核总结

### 1.1 审核结论

| 维度 | 评估结果 | 说明 |
|------|---------|------|
| **可行性** | ✅ 通过 | 依赖关系单向，无循环依赖风险 |
| **合理性** | ✅ 通过 | 命名语义正确，职责分离清晰 |
| **业务逻辑完整性** | ✅ 通过 | 所有核心流程仅移动位置，不修改逻辑 |
| **TypeScript 规范合规性** | ✅ 通过 | 完全符合 `typescript-project-specifications` |
| **风险等级** | 低 | 纯代码重组，无逻辑变更 |

### 1.2 原方案问题与修正

原方案整体设计合理，发现以下细节问题已在本文档中修正：

| 问题 | 原方案描述 | 修正 |
|------|-----------|------|
| 阶段二步骤描述不准确 | "移除 `MainProgramContext`" | `MainProgramContext` 应保留在 `main/types.ts` |
| `processMonitor` 参数类型 | 使用内联对象类型 | 提取为 `ProcessMonitorParams` 命名类型 |
| 导入路径说明不完整 | 缺少部分模块导入变更 | 补充完整导入路径变更清单 |
| **子模块结构不规范** | 子模块使用单文件形式（如 `cleanup.ts`） | 改为文件夹形式（如 `cleanup/index.ts`），符合项目规范 |
| **类型位置不规范** | `CleanupContext` 放在 `init/types.ts` | 移至 `init/cleanup/types.ts`（独享类型放在子模块） |
| **使用 re-export 模式** | `main/index.ts` 和 `init/index.ts` 作为导出入口 | **彻底移除 index 导出入口**，直接从源模块导入 |
| **ProcessMonitorParams 位置** | 放在 `main/types.ts` | 移至 `main/processMonitor/types.ts`（仅被 processMonitor 使用的独享类型） |

---

## 2. 可行性分析

### 2.1 依赖关系验证

#### 依赖方向图

```
src/index.ts (程序入口 + main 函数)
    │
    ├──► src/init/ (初始化工具模块)
    │       ├── utils.ts              → 公共工具函数
    │       ├── cleanup/              → cleanup 子模块
    │       │   ├── index.ts          → createCleanup
    │       │   └── types.ts          → CleanupContext（独享类型）
    │       └── monitorContext/       → monitorContext 子模块
    │           └── index.ts          → createMonitorContext
    │       （无 init/index.ts，不使用 re-export）
    │
    └──► src/main/ (主程序模块)
            ├── types.ts              → MainProgramContext（公共类型，原 MainProgramContext）
            ├── mainProgram/          → 主程序子模块（原 runOnce）
            │   └── index.ts          → mainProgram 函数（原 runOnce）
            ├── processMonitor/       → 单标的处理子模块
            │   ├── index.ts          → processMonitor 函数
            │   └── types.ts          → ProcessMonitorParams（独享类型）
            └── asyncProgram/         → 异步任务处理模块（原 src/program/）
                ├── buyProcessor/     → 买入任务处理器
                ├── sellProcessor/    → 卖出任务处理器
                ├── delayedSignalVerifier/  → 延迟信号验证器
                ├── indicatorCache/   → 指标缓存
                ├── tradeTaskQueue/   → 交易任务队列
                └── types.ts          → asyncProgram 模块公共类型
            （无 main/index.ts，不使用 re-export）

src/main/
    ├──► src/init/utils.ts (仅工具函数: releaseSnapshotObjects, getPositions)
    ├──► src/main/asyncProgram/ (内部模块: 任务队列、处理器、缓存等)
    └──► 外部模块 (services/, core/, config/, utils/, types/, constants/)

src/main/asyncProgram/
    └──► 外部模块 (core/, utils/, types/, constants/)
    （不依赖 src/main/ 的其他子模块，避免循环依赖）

src/init/
    └──► src/main/asyncProgram/ (依赖 delayedSignalVerifier, indicatorCache 等)
    └──► 外部模块 (core/, utils/, types/)
    （不依赖 src/main/mainProgram/ 和 src/main/processMonitor/）
```

**结论**：依赖方向严格单向，无循环依赖风险 ✅

**类型定义位置规则**：
- **公共类型**（被多个模块使用）：放在模块级 `types.ts`
  - `MainProgramContext`（原 `MainProgramContext`）：被 `mainProgram/index.ts` 和 `src/index.ts` 使用 → `main/types.ts`
- **独享类型**（仅被单个子模块使用）：放在子模块的 `types.ts`
  - `ProcessMonitorParams`：仅被 `processMonitor/index.ts` 使用 → `main/processMonitor/types.ts`
  - `CleanupContext`：仅被 `cleanup/index.ts` 使用 → `init/cleanup/types.ts`

#### 关键依赖约束验证

| 约束 | 验证结果 | 说明 |
|------|---------|------|
| `indicatorCache` → `monitorContexts` | ✅ 保持 | 创建顺序不变 |
| `trader._orderRecorder` 共享 | ✅ 保持 | 通过 `createMonitorContext` 参数注入 |
| `lastState` 作用域 | ✅ 保持 | 始终在 `main()` 函数内 |
| 初始化顺序 | ✅ 保持 | 与原代码完全一致 |

### 2.2 代码移动可行性

#### `processMonitor` 函数依赖清单

> 注意：由于 `processMonitor` 位于 `main/processMonitor/index.ts`，相对路径需要多一层 `../`

| 类别 | 依赖项 | 移动后导入来源 |
|------|--------|---------------|
| **外部模块** | `buildIndicatorSnapshot` | `../../services/indicators/index.js` |
| | `logger` | `../../utils/logger/index.js` |
| | `positionObjectPool`, `signalObjectPool` | `../../utils/objectPool/index.js` |
| | `formatError`, `formatSignalLog`, `formatSymbolDisplay` | `../../utils/helpers/index.js` |
| | `VALID_SIGNAL_ACTIONS`, `TRADING` | `../../constants/index.js` |
| **初始化工具** | `releaseSnapshotObjects`, `getPositions` | `../../init/utils.js` |
| **独享类型** | `ProcessMonitorParams` | `./types.js`（子模块独享类型，同目录） |
| **类型** | `CandleData`, `Signal`, `Quote` 等 | `../../types/index.js` |
| | `IndicatorCache` | `../asyncProgram/indicatorCache/types.js` |
| | `BuyTaskQueue`, `SellTaskQueue` | `../asyncProgram/tradeTaskQueue/types.js` |

#### `mainProgram` 函数依赖清单（原 `runOnce`）

> 注意：由于 `mainProgram` 位于 `main/mainProgram/index.ts`，相对路径需要多一层 `../`

| 类别 | 依赖项 | 移动后导入来源 |
|------|--------|---------------|
| **同模块子模块** | `processMonitor` | `../processMonitor/index.js` |
| **外部模块** | `MULTI_MONITOR_TRADING_CONFIG` | `../../config/config.trading.js` |
| | `logger` | `../../utils/logger/index.js` |
| | `formatError`, `formatSymbolDisplay` | `../../utils/helpers/index.js` |
| | `collectAllQuoteSymbols` | `../../utils/helpers/quoteHelpers.js` |
| | `isInContinuousHKSession` | `../../utils/helpers/tradingTime.js` |
| | `displayAccountAndPositions` | `../../utils/helpers/accountDisplay.js` |
| **公共类型** | `MainProgramContext`（原 `MainProgramContext`） | `../types.js`（模块级公共类型） |
| **类型** | `MonitorContext` | `../../types/index.js` |

**结论**：所有依赖均可通过调整导入路径解决 ✅

---

## 3. 业务逻辑完整性验证

### 3.1 核心业务流程对照

根据 `core-program-business-logic` skill，逐项验证：

| 核心流程 | 原代码位置 | 重构后位置 | 逻辑变更 |
|---------|-----------|-----------|---------|
| **信号生成** | `index.ts:221-226` | `main/processMonitor/index.ts` | ❌ 无变更 |
| **信号分流（立即/延迟）** | `index.ts:243-313` | `main/processMonitor/index.ts` | ❌ 无变更 |
| **延迟验证** | `index.ts:305-312` | `main/processMonitor/index.ts` | ❌ 无变更 |
| **指标缓存存储** | `index.ts:200` | `main/processMonitor/index.ts` | ❌ 无变更 |
| **价格监控** | `index.ts:141-147` | `main/processMonitor/index.ts` | ❌ 无变更 |
| **浮亏实时监控** | `index.ts:150-160` | `main/processMonitor/index.ts` | ❌ 无变更 |
| **交易日检查** | `index.ts:363-393` | `main/mainProgram/index.ts`（原 `runOnce`） | ❌ 无变更 |
| **交易时段检查** | `index.ts:405-433` | `main/mainProgram/index.ts` | ❌ 无变更 |
| **末日保护** | `index.ts:441-469` | `main/mainProgram/index.ts` | ❌ 无变更 |
| **批量获取行情** | `index.ts:474-475` | `main/mainProgram/index.ts` | ❌ 无变更 |
| **并发处理监控标的** | `index.ts:479-503` | `main/mainProgram/index.ts` | ❌ 无变更 |
| **订单监控** | `index.ts:505-511` | `main/mainProgram/index.ts` | ❌ 无变更 |
| **缓存刷新** | `index.ts:517-570` | `main/mainProgram/index.ts` | ❌ 无变更 |

### 3.2 关键业务规则验证

| 业务规则 | 规则描述 | 代码保证 |
|---------|---------|---------|
| **卖出信号不经风险检查** | 卖出信号直接推入 `SellTaskQueue` | ✅ 第265-273行整体移动 |
| **买入信号需风险检查** | 买入信号推入 `BuyTaskQueue`，由 `BuyProcessor` 执行检查 | ✅ 第274-281行整体移动 |
| **延迟信号需验证** | 延迟信号推入 `DelayedSignalVerifier` | ✅ 第305-312行整体移动 |
| **收盘清理待验证信号** | 交易时段结束时清理所有待验证信号 | ✅ 第416-429行整体移动 |
| **对象池及时释放** | 持仓对象在 finally 中释放 | ✅ 第320-327行整体移动 |
| **快照对象释放** | 上一次快照的 KDJ/MACD 对象释放 | ✅ 第202-209行整体移动 |

### 3.3 初始化顺序保证

重构后 `main()` 函数的初始化顺序与原代码**完全一致**：

```
1.  验证配置 (validateAllConfig)
2.  创建配置和交易器 (createConfig, createTrader)
3.  计算交易标的集合 (allTradingSymbols)
4.  创建全局状态 (lastState)
5.  创建模块实例 (marketMonitor, indicatorCache, taskQueues)
6.  创建监控上下文 (monitorContexts) ← 使用 init/monitorContext/index.ts
7.  获取账户和持仓信息 (displayAccountAndPositions)
8.  初始化订单记录
9.  初始化浮亏监控
10. 注册验证器回调
11. 创建处理器 (buyProcessor, sellProcessor)
12. 注册退出处理 ← 使用 init/cleanup/index.ts
13. 启动主循环 ← 调用 main/mainProgram/index.ts（原 runOnce）
```

**结论**：所有业务逻辑保持不变，仅移动代码位置 ✅

---

## 4. TypeScript 规范合规性检查

### 4.1 `typescript-project-specifications` 规范对照

| 规范要求 | 实现方式 | 合规状态 |
|---------|---------|---------|
| **子模块采用文件夹形式** | `cleanup/`, `monitorContext/`, `mainProgram/`, `processMonitor/`, `asyncProgram/` 均为文件夹 | ✅ |
| **类型定义放在 types.ts** | 公共类型在模块级 `types.ts`，独享类型在子模块 `types.ts` | ✅ |
| **工具函数放在 utils.ts** | `init/utils.ts` 包含所有纯工具函数 | ✅ |
| **工厂函数模式** | `createCleanup`, `createMonitorContext` 使用工厂函数 | ✅ |
| **依赖注入模式** | 所有依赖通过参数注入，不在内部创建 | ✅ |
| **不可变数据** | 类型属性使用 `readonly` | ✅ |
| **文件/文件夹命名 camelCase** | `mainProgram/`, `processMonitor/`, `monitorContext/`, `cleanup/`, `asyncProgram/` | ✅ |
| **无 re-export 模式** | **彻底移除 index 导出入口**，类型直接从源文件导入 | ✅ |
| **无兼容性代码** | 完整系统性重构，无临时性代码 | ✅ |
| **清除无用代码** | 移动后删除原位置代码 | ✅ |
| **对象池及时释放** | 释放逻辑随代码整体移动，保持不变 | ✅ |
| **类型位置遵循"最近公共位置"** | 公共类型（`MainProgramContext`）在模块级，独享类型（`ProcessMonitorParams`、`CleanupContext`）在子模块 | ✅ |

### 4.2 `typescript-strict` 规范对照

| 规范要求 | 实现方式 | 合规状态 |
|---------|---------|---------|
| **No `any`** | 代码中无 `any` 类型 | ✅ |
| **No type assertions without justification** | 仅在对象池 `acquire()` 时使用，有充分理由 | ✅ |
| **Prefer `type` over `interface`** | 数据结构使用 `type`，行为契约使用 `interface` | ✅ |
| **`readonly` on all data structures** | 类型属性使用 `readonly` | ✅ |
| **Factory functions for object creation** | 使用工厂函数而非类 | ✅ |
| **Dependency injection** | 所有依赖通过参数注入 | ✅ |

**结论**：完全符合 TypeScript 项目规范 ✅

---

## 5. 最终实施方案

### 5.1 目标文件结构

```
src/
├── index.ts                    # ~350 行：main 函数 + 程序入口
├── init/                       # 初始化工具模块（原 main/ 重命名）
│   ├── utils.ts                # 公共工具函数（initMonitorState, getPositions 等）
│   ├── cleanup/                # cleanup 子模块（文件夹形式）
│   │   ├── index.ts            # createCleanup 函数
│   │   └── types.ts            # CleanupContext 类型（独享类型）
│   └── monitorContext/         # monitorContext 子模块（文件夹形式）
│       └── index.ts            # createMonitorContext 函数
│   （无 init/index.ts，不使用 re-export）
│
└── main/                       # 主程序模块（新职责）
    ├── types.ts                # 公共类型（MainProgramContext，原 MainProgramContext）
    ├── mainProgram/            # 主程序子模块（原 runOnce，文件夹形式）
    │   └── index.ts            # mainProgram 函数（原 runOnce）
    ├── processMonitor/         # 单标的处理子模块（文件夹形式）
    │   ├── index.ts            # processMonitor 函数
    │   └── types.ts            # ProcessMonitorParams 类型（独享类型）
    └── asyncProgram/           # 异步任务处理模块（原 src/program/，移动至此）
        ├── buyProcessor/       # 买入任务处理器
        ├── sellProcessor/      # 卖出任务处理器
        ├── delayedSignalVerifier/  # 延迟信号验证器
        ├── indicatorCache/     # 指标缓存（环形缓冲区）
        ├── tradeTaskQueue/     # 交易任务队列（FIFO）
        └── types.ts            # asyncProgram 模块公共类型
    （无 main/index.ts，不使用 re-export）
```

> **注意**：
> - 子模块采用文件夹形式，符合 `typescript-project-specifications` 规范
> - 每个子模块包含 `index.ts`（主逻辑），如有独享类型则包含 `types.ts`
> - **不创建 index 导出入口**，使用者直接从源模块导入
> - **类型位置遵循"最近公共位置"原则**：
>   - 公共类型放在模块级 `types.ts`（如 `MainProgramContext`，原 `MainProgramContext`）
>   - 独享类型放在子模块的 `types.ts`（如 `ProcessMonitorParams`、`CleanupContext`）
> - **program → asyncProgram**：将 `src/program/` 重命名并移至 `src/main/asyncProgram/`，所有子模块结构保持不变

### 5.2 代码行数预估

| 文件 | 重构前 | 重构后 | 变化 |
|------|--------|--------|------|
| `src/index.ts` | 869 行 | ~350 行 | -60% |
| `src/main/mainProgram/index.ts` | - | ~250 行 | 新建 |
| `src/main/processMonitor/index.ts` | - | ~250 行 | 新建 |
| `src/main/processMonitor/types.ts` | - | ~40 行 | 新建（ProcessMonitorParams 独享类型） |
| `src/main/types.ts` | - | ~30 行 | 新建（MainProgramContext 公共类型） |
| `src/init/cleanup/index.ts` | ~50 行 | ~50 行 | 从 cleanup.ts 移动 |
| `src/init/cleanup/types.ts` | - | ~15 行 | 从 init/types.ts 拆分（CleanupContext 独享类型） |
| `src/init/monitorContext/index.ts` | ~100 行 | ~100 行 | 从 monitorContext.ts 移动 |
| `src/init/utils.ts` | ~100 行 | ~100 行 | 保持不变 |

> **注意**：不再创建 `src/main/index.ts` 和 `src/init/index.ts`，避免 re-export 模式

### 5.3 详细文件内容

#### `src/main/types.ts`（公共类型）

```typescript
/**
 * 主循环模块公共类型定义
 *
 * 这些类型被多个子模块或外部模块共享：
 * - MainProgramContext: 被 mainProgram/index.ts 和 src/index.ts 使用
 *
 * 独享类型位置：
 * - ProcessMonitorParams: 仅被 processMonitor 使用 → main/processMonitor/types.ts
 */

import type { IndicatorCache } from './asyncProgram/indicatorCache/types.js';
import type { BuyTaskQueue, SellTaskQueue } from './asyncProgram/tradeTaskQueue/types.js';
import type { BuyProcessor } from './asyncProgram/buyProcessor/types.js';
import type { SellProcessor } from './asyncProgram/sellProcessor/types.js';
import type {
  LastState,
  MonitorContext,
  MarketDataClient,
  Trader,
} from '../types/index.js';
import type { MarketMonitor } from '../services/marketMonitor/types.js';
import type { DoomsdayProtection } from '../core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../core/signalProcessor/types.js';

/**
 * 主程序运行上下文
 * 包含主循环所需的所有依赖
 */
export type MainProgramContext = {
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly marketMonitor: MarketMonitor;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly signalProcessor: SignalProcessor;
  readonly monitorContexts: Map<string, MonitorContext>;
  readonly indicatorCache: IndicatorCache;
  readonly buyTaskQueue: BuyTaskQueue;
  readonly sellTaskQueue: SellTaskQueue;
  readonly buyProcessor: BuyProcessor;
  readonly sellProcessor: SellProcessor;
};
```

#### `src/main/processMonitor/types.ts`（独享类型）

```typescript
/**
 * processMonitor 子模块独享类型定义
 *
 * 这些类型仅被 processMonitor/index.ts 使用，
 * 根据"最近公共位置"原则，放在子模块内部。
 */

import type { IndicatorCache } from '../asyncProgram/indicatorCache/types.js';
import type { BuyTaskQueue, SellTaskQueue } from '../asyncProgram/tradeTaskQueue/types.js';
import type {
  LastState,
  MonitorContext,
  MarketDataClient,
  Trader,
} from '../../types/index.js';
import type { MarketMonitor } from '../../services/marketMonitor/types.js';
import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../../core/signalProcessor/types.js';

/**
 * processMonitor 处理参数
 * 包含处理单个监控标的所需的所有依赖
 */
export type ProcessMonitorParams = {
  readonly monitorContext: MonitorContext;
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly globalState: LastState;
  readonly marketMonitor: MarketMonitor;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly signalProcessor: SignalProcessor;
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly canTradeNow: boolean;
  readonly indicatorCache: IndicatorCache;
  readonly buyTaskQueue: BuyTaskQueue;
  readonly sellTaskQueue: SellTaskQueue;
};
```

#### `src/main/processMonitor/index.ts`

```typescript
/**
 * 单个监控标的处理模块
 *
 * 职责：
 * - 获取行情数据和 K 线
 * - 计算技术指标并存入缓存
 * - 生成交易信号
 * - 信号分流：立即信号 → 任务队列，延迟信号 → 验证器
 */

import { buildIndicatorSnapshot } from '../../services/indicators/index.js';
import { logger } from '../../utils/logger/index.js';
import {
  positionObjectPool,
  signalObjectPool,
} from '../../utils/objectPool/index.js';
import {
  formatError,
  formatSignalLog,
  formatSymbolDisplay,
} from '../../utils/helpers/index.js';
import { VALID_SIGNAL_ACTIONS, TRADING } from '../../constants/index.js';
import { releaseSnapshotObjects, getPositions } from '../../init/utils.js';

// 独享类型从同目录导入
import type { ProcessMonitorParams } from './types.js';
import type { CandleData, Signal, Quote } from '../../types/index.js';

/**
 * 处理单个监控标的
 *
 * @param params 处理参数，包含所有必要的依赖和状态
 * @param quotesMap 预先批量获取的行情数据 Map
 */
export async function processMonitor(
  params: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  // ... 原 index.ts 第112-329行的完整实现（仅调整导入路径）
}
```

#### `src/main/mainProgram/index.ts`

```typescript
/**
 * 主程序循环模块
 *
 * 职责：
 * - 检查交易日和交易时段
 * - 执行末日保护检查
 * - 批量获取行情数据
 * - 并发处理所有监控标的
 * - 订单监控和缓存刷新
 */

import { processMonitor } from '../processMonitor/index.js';
import { MULTI_MONITOR_TRADING_CONFIG } from '../../config/config.trading.js';
import { logger } from '../../utils/logger/index.js';
import { formatError, formatSymbolDisplay } from '../../utils/helpers/index.js';
import { collectAllQuoteSymbols } from '../../utils/helpers/quoteHelpers.js';
import { isInContinuousHKSession } from '../../utils/helpers/tradingTime.js';
import { displayAccountAndPositions } from '../../utils/helpers/accountDisplay.js';

// 公共类型从模块级 types.ts 导入
import type { MainProgramContext } from '../types.js';
import type { MonitorContext } from '../../types/index.js';

/**
 * 主程序循环
 *
 * 每秒执行一次，协调所有监控标的的处理
 */
export async function mainProgram(context: MainProgramContext): Promise<void> {
  // ... 原 index.ts 第338-573行的完整实现（仅调整导入路径）
}
```

#### `src/init/cleanup/types.ts`（独享类型）

```typescript
/**
 * cleanup 子模块独享类型定义
 *
 * CleanupContext 仅被 cleanup/index.ts 使用，
 * 根据"最近公共位置"原则，放在子模块内部。
 */

import type { BuyProcessor } from '../../main/asyncProgram/buyProcessor/types.js';
import type { SellProcessor } from '../../main/asyncProgram/sellProcessor/types.js';
import type { IndicatorCache } from '../../main/asyncProgram/indicatorCache/types.js';
import type { LastState, MonitorContext } from '../../types/index.js';

/**
 * 清理上下文
 * 包含程序退出时需要清理的资源
 */
export type CleanupContext = {
  readonly buyProcessor: BuyProcessor;
  readonly sellProcessor: SellProcessor;
  readonly monitorContexts: Map<string, MonitorContext>;
  readonly indicatorCache: IndicatorCache;
  readonly lastState: LastState;
};
```

#### `src/init/cleanup/index.ts`（从 cleanup.ts 移动）

```typescript
/**
 * 程序退出清理模块
 *
 * 职责：
 * - 创建程序退出时的清理函数
 * - 释放所有对象池资源
 * - 清理待验证信号
 */

import { logger } from '../../utils/logger/index.js';
import { releaseAllMonitorSnapshots } from '../utils.js';

// 独享类型从同目录导入
import type { CleanupContext } from './types.js';

/**
 * 创建程序退出清理函数
 */
export const createCleanup = (context: CleanupContext) => {
  // ... 原 cleanup.ts 的完整实现（仅调整导入路径）
};
```

#### `src/init/monitorContext/index.ts`（从 monitorContext.ts 移动）

```typescript
/**
 * 监控上下文创建模块
 *
 * 职责：
 * - 创建单个监控标的的上下文对象
 * - 初始化监控状态
 */

import { createHangSengMultiIndicatorStrategy } from '../../core/strategy/index.js';
import { createRiskChecker } from '../../core/risk/index.js';
import { createUnrealizedLossMonitor } from '../../core/unrealizedLossMonitor/index.js';
import { createDelayedSignalVerifier } from '../../main/asyncProgram/delayedSignalVerifier/index.js';
import { extractEmaPeriods, extractRsiPeriodsWithDefault } from '../utils.js';

import type { IndicatorCache } from '../../main/asyncProgram/indicatorCache/types.js';
import type {
  MonitorConfig,
  MonitorState,
  MonitorContext,
  Quote,
  Trader,
} from '../../types/index.js';

/**
 * 创建监控上下文
 */
export function createMonitorContext(
  config: MonitorConfig,
  state: MonitorState,
  trader: Trader,
  quotesMap: ReadonlyMap<string, Quote | null>,
  indicatorCache: IndicatorCache,
): MonitorContext {
  // ... 原 monitorContext.ts 的完整实现（仅调整导入路径）
}
```

> **注意**：`src/init/` 目录不再创建 `index.ts` 导出入口，使用者直接从源模块导入

### 5.4 `src/index.ts` 导入变更

```typescript
// === 删除的本地函数定义 ===
// - processMonitor 函数（第93-329行）
// - mainProgram 函数（第338-573行）

// === 变更的导入路径（直接从源模块导入，不使用 index 入口）===
// 原：from './main/index.js'
// 新：直接从各个源模块导入
import {
  initMonitorState,
  releaseSnapshotObjects,
  getPositions,
  extractEmaPeriods,
  extractRsiPeriodsWithDefault,
  releaseAllMonitorSnapshots,
} from './init/utils.js';

import { createMonitorContext } from './init/monitorContext/index.js';
import { createCleanup } from './init/cleanup/index.js';

// === 新增的导入（直接从源模块导入）===
import { mainProgram } from './main/mainProgram/index.js';

// === 类型直接从源文件导入，避免 re-export 模式 ===
import type { MainProgramContext } from './main/types.js';
import type { CleanupContext } from './init/cleanup/types.js';

// === 删除的导入（已移至 main/ 子模块内部） ===
// - buildIndicatorSnapshot（移至 main/processMonitor/index.ts）
// - VALID_SIGNAL_ACTIONS, TRADING（移至 main/processMonitor/index.ts）
// - positionObjectPool, signalObjectPool（移至 main/processMonitor/index.ts）
// - formatSignalLog（移至 main/processMonitor/index.ts）
// - collectAllQuoteSymbols（移至 main/mainProgram/index.ts，原 runOnce）
// - isInContinuousHKSession（移至 main/mainProgram/index.ts）
// - displayAccountAndPositions（移至 main/mainProgram/index.ts）
```

---

## 6. 实施步骤

### 阶段一：准备工作

1. 确保代码已提交到 Git
2. 创建重构分支：`git checkout -b refactor/main-loop-module`

### 阶段二：重命名 main/ 为 init/ 并重构为子模块结构

1. 重命名目录：`src/main/` → `src/init/`
2. 创建 `src/init/cleanup/` 子模块目录：
   - 移动 `src/init/cleanup.ts` → `src/init/cleanup/index.ts`
   - 创建 `src/init/cleanup/types.ts`：从 `init/types.ts` 移动 `CleanupContext` 类型
3. 创建 `src/init/monitorContext/` 子模块目录：
   - 移动 `src/init/monitorContext.ts` → `src/init/monitorContext/index.ts`
4. 删除 `src/init/types.ts`（`CleanupContext` 已移至 `cleanup/types.ts`，`MainProgramContext` 将移至新 `main/types.ts`）
5. **删除 `src/init/index.ts`**（不使用 re-export，直接从源模块导入）
6. 更新 `src/init/cleanup/index.ts`：导入路径从 `./utils.js` 改为 `../utils.js`
7. 更新 `src/init/monitorContext/index.ts`：导入路径从 `./utils.js` 改为 `../utils.js`

### 阶段三：移动 program/ 至 main/asyncProgram/

1. **移动整个 program 模块**：
   - 移动 `src/program/` → `src/main/asyncProgram/`
   - 保持所有子模块结构不变：
     - `buyProcessor/`
     - `sellProcessor/`
     - `delayedSignalVerifier/`
     - `indicatorCache/`
     - `tradeTaskQueue/`
     - `types.ts`

2. **更新所有导入 program 的文件**（批量替换）：
   - `from '../program/` → `from '../asyncProgram/`（在 main/ 内部）
   - `from './program/` → `from './main/asyncProgram/`（在 src/index.ts）
   - `from '../../program/` → `from '../../main/asyncProgram/`（在 init/ 等其他目录）

### 阶段四：创建新的 main/ 模块（子模块结构）

1. 创建 `src/main/` 目录（如果阶段三还未创建）
2. 创建 `src/main/types.ts`：定义 `MainProgramContext`（公共类型，原 `RunOnceContext`）
3. 创建 `src/main/processMonitor/` 子模块目录：
   - 创建 `src/main/processMonitor/types.ts`：定义 `ProcessMonitorParams`（独享类型）
   - 创建 `src/main/processMonitor/index.ts`：移动 `processMonitor` 函数
   - 更新导入路径（注意多一层 `../`，类型从 `./types.js` 导入，asyncProgram 从 `../asyncProgram/` 导入）
4. 创建 `src/main/mainProgram/` 子模块目录（原 `runOnce`）：
   - 创建 `src/main/mainProgram/index.ts`：移动 `runOnce` 函数并重命名为 `mainProgram`
   - 更新导入路径（注意多一层 `../`，类型从 `../types.js` 导入）
   - 更新所有函数名、注释、JSDoc 中的 `runOnce` 为 `mainProgram`
5. **不创建 `src/main/index.ts`**（不使用 re-export）

### 阶段五：更新 src/index.ts

1. 删除 `processMonitor` 函数定义
2. 删除 `runOnce` 函数定义
3. 更新导入（直接从源模块导入，不使用 index 入口）：
   - 工具函数从 `./init/utils.js` 导入
   - `createMonitorContext` 从 `./init/monitorContext/index.js` 导入
   - `createCleanup` 从 `./init/cleanup/index.js` 导入
   - `mainProgram`（原 `runOnce`）从 `./main/mainProgram/index.js` 导入
   - `MainProgramContext` 类型从 `./main/types.js` 导入
   - `CleanupContext` 类型从 `./init/cleanup/types.js` 导入
4. 清理不再需要的导入
5. 更新所有 `runOnce` 调用为 `mainProgram`

### 阶段六：验证

1. 运行 `npm run type-check`
2. 运行 `npm run lint`
3. 手动启动程序验证
4. 验证退出清理

### 阶段七：完成

1. 提交代码：
   ```bash
   git commit -m "refactor: reorganize main program and async modules

   - 重命名 src/main/ → src/init/（初始化工具模块）
   - 创建新的 src/main/（主程序模块）
   - 移动 src/program/ → src/main/asyncProgram/（异步任务处理模块）
   - runOnce → mainProgram（主程序函数重命名）
   - RunOnceContext → MainProgramContext（类型重命名）
   - 子模块采用文件夹形式：cleanup/, monitorContext/, mainProgram/, processMonitor/, asyncProgram/
   - 彻底移除 index 导出入口，直接从源模块导入
   - 独享类型放在子模块 types.ts（ProcessMonitorParams, CleanupContext）
   - 公共类型放在模块级 types.ts（MainProgramContext）
   - 符合 typescript-project-specifications 规范"
   ```
2. 合并到开发分支

---

## 7. 风险评估与回滚方案

### 7.1 风险矩阵

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| 导入路径遗漏 | 中 | 低 | 重构后运行 `npm run type-check` |
| 循环依赖 | 低 | 高 | 已验证依赖方向单向 |
| 业务逻辑变化 | 极低 | 高 | 仅移动代码，不修改逻辑 |
| 对象池释放遗漏 | 无 | 高 | 释放逻辑随代码整体移动 |
| 初始化顺序错误 | 无 | 高 | `main()` 函数逻辑不变 |

### 7.2 回滚方案

如果重构出现问题：

1. **Git 回滚**：`git checkout -- src/` 恢复所有源文件
2. **逐步撤销**：按实施步骤逆序撤销

---

## 8. 验收标准

### 8.1 编译验证

```bash
npm run type-check  # 必须无错误
npm run lint        # 必须无错误
```

### 8.2 功能验证清单

- [ ] 程序正常启动
- [ ] 配置验证通过
- [ ] 账户信息获取成功
- [ ] 订单记录初始化成功
- [ ] 浮亏监控初始化成功
- [ ] 信号生成正常（立即信号和延迟信号）
- [ ] 延迟验证正常
- [ ] 交易执行正常
- [ ] 末日保护正常
- [ ] 退出清理正常（Ctrl+C）

### 8.3 代码质量验证

- [ ] 无循环依赖
- [ ] 所有类型正确导入
- [ ] 符合 `typescript-project-specifications` 规范
- [ ] 代码注释完整

---

## 9. 附录

### A. 移动代码行号对照

| 内容 | 原位置 (index.ts) | 新位置 |
|------|------------------|--------|
| `processMonitor` 函数 | 第93-329行 | `main/processMonitor/index.ts` |
| `mainProgram` 函数（原 `runOnce`） | 第338-573行 | `main/mainProgram/index.ts` |
| `MainProgramContext` 类型（原 `RunOnceContext`） | 从 `main/types.ts` | 保持在 `main/types.ts` |
| `CleanupContext` 类型 | 从 `main/types.ts` | 移到 `init/cleanup/types.ts` |
| `createCleanup` 函数 | `main/cleanup.ts` | `init/cleanup/index.ts` |
| `createMonitorContext` 函数 | `main/monitorContext.ts` | `init/monitorContext/index.ts` |
| 整个 `program/` 模块 | `src/program/` | `src/main/asyncProgram/` |

### B. 导入路径变更汇总

| 文件 | 原导入 | 新导入 |
|------|--------|--------|
| `src/index.ts` | `from './main/index.js'` | `from './init/utils.js'`（工具函数） |
| `src/index.ts` | - | `from './init/monitorContext/index.js'`（createMonitorContext） |
| `src/index.ts` | - | `from './init/cleanup/index.js'`（createCleanup） |
| `src/index.ts` | `from './main/types.js'` | `from './main/types.js'`（MainProgramContext，位置不变） |
| `src/index.ts` | - | `from './main/mainProgram/index.js'`（mainProgram，原 runOnce） |
| `src/index.ts` | - | `from './init/cleanup/types.js'`（CleanupContext 独享类型） |
| `src/index.ts` | `from './program/` | `from './main/asyncProgram/`（所有 asyncProgram 模块导入） |
| `src/main/processMonitor/index.ts` | - | `from '../../init/utils.js'`（注意多一层 `../`） |
| `src/main/processMonitor/index.ts` | - | `from './types.js'`（独享类型，同目录） |
| `src/main/processMonitor/index.ts` | `from '../../program/` | `from '../asyncProgram/`（asyncProgram 模块导入） |
| `src/main/mainProgram/index.ts` | - | `from '../processMonitor/index.js'`（同级子模块调用） |
| `src/main/mainProgram/index.ts` | - | `from '../types.js'`（公共类型，模块级） |
| `src/init/cleanup/index.ts` | `from './utils.js'` | `from '../utils.js'`（上一级） |
| `src/init/cleanup/index.ts` | - | `from './types.js'`（独享类型，同目录） |
| `src/init/cleanup/index.ts` | `from '../../program/` | `from '../../main/asyncProgram/`（asyncProgram 模块导入） |
| `src/init/monitorContext/index.ts` | `from './utils.js'` | `from '../utils.js'`（上一级） |
| `src/init/monitorContext/index.ts` | `from '../../program/` | `from '../../main/asyncProgram/`（asyncProgram 模块导入） |
| 其他所有引用 `program/` 的文件 | `from '../program/` 或 `../../program/` | 根据新位置调整为 `../asyncProgram/` 或 `../../main/asyncProgram/` |

### C. 类型定义位置变更

| 类型 | 原位置 | 新位置 | 说明 |
|------|--------|--------|------|
| `MainProgramContext` | `main/types.ts` | `main/types.ts` | 保持（公共类型，被多个模块使用） |
| `CleanupContext` | `main/types.ts` | `init/cleanup/types.ts` | 移动到子模块（独享类型，仅被 cleanup 使用） |
| `ProcessMonitorParams` | 无（内联类型） | `main/processMonitor/types.ts` | 新增（独享类型，仅被 processMonitor 使用） |

### D. 文件结构对比

#### 重构前

```
src/
├── index.ts                    # 869 行
├── main/                       # 初始化工具模块（旧名称）
│   ├── index.ts                # re-export 入口
│   ├── types.ts                # RunOnceContext, CleanupContext
│   ├── utils.ts
│   ├── cleanup.ts              # 文件形式
│   └── monitorContext.ts       # 文件形式
└── program/                    # 异步任务处理模块（旧位置）
    ├── buyProcessor/
    ├── sellProcessor/
    ├── delayedSignalVerifier/
    ├── indicatorCache/
    ├── tradeTaskQueue/
    └── types.ts
```

#### 重构后

```
src/
├── index.ts                    # ~350 行
├── init/                       # 初始化工具模块（新名称）
│   ├── utils.ts                # 公共工具函数
│   ├── cleanup/                # 子模块（文件夹形式）
│   │   ├── index.ts
│   │   └── types.ts            # CleanupContext（独享类型）
│   └── monitorContext/         # 子模块（文件夹形式）
│       └── index.ts
│   （无 init/index.ts，不使用 re-export）
│
└── main/                       # 主程序模块（新职责）
    ├── types.ts                # MainProgramContext（公共类型，原 RunOnceContext）
    ├── mainProgram/            # 主程序子模块（原 runOnce，文件夹形式）
    │   └── index.ts            # mainProgram 函数（原 runOnce）
    ├── processMonitor/         # 单标的处理子模块（文件夹形式）
    │   ├── index.ts
    │   └── types.ts            # ProcessMonitorParams（独享类型）
    └── asyncProgram/           # 异步任务处理模块（原 program，新位置）
        ├── buyProcessor/
        ├── sellProcessor/
        ├── delayedSignalVerifier/
        ├── indicatorCache/
        ├── tradeTaskQueue/
        └── types.ts
    （无 main/index.ts，不使用 re-export）
```

#### 关键变化说明

| 变化点 | 原方案 | 新方案 |
|--------|--------|--------|
| **index 导出入口** | `main/index.ts` 和 `init/index.ts` 作为 re-export 入口 | 彻底移除，直接从源模块导入 |
| **类型位置** | 所有类型放在模块级 `types.ts` | 遵循"最近公共位置"原则：公共类型在模块级，独享类型在子模块 |
| **ProcessMonitorParams** | 放在 `main/types.ts` | 放在 `main/processMonitor/types.ts`（仅被 processMonitor 使用） |
| **CleanupContext** | 放在 `init/types.ts` | 放在 `init/cleanup/types.ts`（仅被 cleanup 使用） |
| **runOnce → mainProgram** | 函数名为 `runOnce` | 重命名为 `mainProgram`，更准确反映"主程序"语义 |
| **RunOnceContext → MainProgramContext** | 类型名为 `RunOnceContext` | 重命名为 `MainProgramContext`，与函数名保持一致 |
| **program → asyncProgram** | `src/program/` 独立存在 | 移至 `src/main/asyncProgram/`，强化模块归属关系 |

### E. 参考文档

- [TypeScript Project Specifications](../.claude/skills/typescript-project-specifications/SKILL.md)
- [TypeScript Strict Mode](../.claude/skills/typescript-project-specifications/reference/typescript-strict.md)
- [Core Program Business Logic](../.claude/skills/core-program-business-logic/SKILL.md)
- [原始重构方案](./main-loop-refactor-plan.md)
- [前次重构方案](./index-refactor-plan.md)
