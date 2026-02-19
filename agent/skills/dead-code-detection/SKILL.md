# Dead Code Detection & Removal

TypeScript 工厂函数 + 依赖注入架构下的死代码检测与删除流程。  
目标：在不改变行为的前提下清理无用代码，优先降低误删风险。

## 0. 核心原则

- 每个删除结论都必须同时具备：搜索证据、类型证据、级联证据。
- 证据不足时不删除。
- 工具报告仅用于候选生成，不可直接作为删除依据。

## 1. 死代码类型定义

| 类别 | 判定标准 | 处理方式 |
|------|----------|----------|
| 导出未被消费 | `export` 无真实消费方 | 删除导出，或仅移除 `export`（若文件内仍用） |
| 仅被转发的导出 | 只被 re-export，未被真实使用 | 删除 re-export 与源导出 |
| 接口方法级死代码 | 接口声明 + return 暴露，但无外部消费 | 移除接口声明与 return 暴露；实现体按安全规则单独判断 |
| 门面包装器死代码 | 包装器仅透传且无外部调用 | 删除包装器；内部实现单独判断 |
| 工厂返回属性死代码 | `return { ... }` 属性未被上游消费 | 移除属性及相关接口声明 |
| 常量/类型/变量未使用 | 无引用（含级联后产生） | 删除定义及相关导入导出 |
| 仅类型层引用的运行时符号 | 仅存在于 `interface/type`，无运行时路径 | 移除类型声明与运行时实现（确认无内部调用后） |
| 级联死代码 | 删除后产生的无用导入、deps 字段、参数、注释 | 持续清理至收敛 |

## 2. 判定等级

| 等级 | 含义 | 处理策略 |
|------|------|----------|
| A | 证据完整，已排除动态调用/边界风险 | 允许删除 |
| B | 大概率无用，但仍有不确定点 | 暂不删除，补证或询问用户 |
| C | 反射/运行时注册/外部约定导致不可判定 | 不删除 |

仅 A 级可进入删除流程。

## 3. 检测流程

### 3.1 搜索边界

- 默认包含：`src/ tests/ scripts/ tools/ mock/`
- 默认排除：`node_modules/ dist/ coverage/ logs/`
- 若目标是“仅生产瘦身”，范围改为：`src/ scripts/ tools/`

### 3.2 候选生成

```bash
bun run type-check
bun run lint
# 可选（已安装时）
bunx knip --production
bunx ts-prune
```

### 3.3 方法级检索矩阵（必须逐项过）

以 `methodName` 为例：

| 场景 | 搜索命令 |
|------|----------|
| 广搜符号 | `rg -n --type ts --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' "\bmethodName\b" src tests scripts tools mock` |
| 直接调用 | `rg -n --type ts --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' "\.methodName\(" src tests scripts tools mock` |
| 可选链调用 | `rg -n --type ts "\?\.methodName(?:\?\.)?\s*\(" src tests scripts tools mock` |
| 字符串下标调用 | `rg -n --type ts "\[['\"]methodName['\"]\]\s*\(" src tests scripts tools mock` |
| 解构/别名解构 | `rg -n --type ts "\{[^}]*\bmethodName\b[^}]*\}\s*=\s*" src tests scripts tools mock` |
| 回调传递 | `rg -n --type ts "\.methodName\s*(?:,|\))" src tests scripts tools mock` |
| bind 传递 | `rg -n --type ts "methodName\.bind\(" src tests scripts tools mock` |
| deps 注入 | `rg -n --type ts "\bmethodName\s*:\s*[\w$.]+" src/main src/core src/services` |
| 实例来源反查 | `rg -n --type ts "create[A-Z]\w*\(|deps\s*:|context\." src tests scripts tools mock` |

命中只算候选，必须人工排除以下噪音：类型声明、定义体、return 引用、同文件内部辅助调用。

### 3.4 交叉验证（必须）

- 多层调用链逐层判定，不可上层结论外推到下层。  
  例：`Trader.trackOrder -> orderMonitor.trackOrder -> orderHoldRegistry.trackOrder`
- 包装器与内部实现分层判定，禁止“包装器死=实现死”。
- 导出消费方必须追到真实调用点，不只看 barrel 文件。

### 3.5 边界风险检查（必须）

出现以下任一场景，至少降为 B 级：

- 公共边界 API（SDK 对外导出、入口导出、CLI handler）
- 启动/清理链路中的单点调用
- 事件/定时器/注册表触发（如 `onXxx`、`setInterval`、`registry['x']=fn`）
- 字符串协议或外部约定键
- 动态键调度（如 `handlers[action]()`）
- 配置驱动调用（JSON/ENV/DB）
- 反射式遍历调用（`for...in`、`Object.keys`）
- 代码生成/脚手架产物引用

### 3.6 级联清理

删除后立即检查并清理：

- 无用导入
- 无用类型
- 无用变量
- 无用 deps 字段
- 无用调用参数
- 过时注释

## 4. 删除顺序与验证

### 4.1 删除顺序

1. 接口层：移除 `interface/type` 声明
2. 暴露层：移除 `return` 属性与包装器
3. 实现层：仅在确认无内部使用后删除函数实体
4. 级联层：清理导入、类型、deps、参数、注释

### 4.2 批次验证

每个小批次完成后立即执行：

```bash
bun run type-check
bun run lint
```

若仓库有测试，至少执行受影响模块测试（建议全量）。  
Windows PowerShell 不支持 `&&`，命令分开执行。

## 5. 安全规则（不可违背）

1. 内部实现仍被内部逻辑调用时，只删公共暴露，不删实现体。
2. 通过 `deps` 传入子工厂的方法，默认保留函数实体与传递关系。
3. 对外 API 或外部约定键，在无外部证明前不删除。
4. 不确定项必须升级为 B/C 级，不进入删除。
5. 每个删除项都要有可回溯证据链。

## 6. 测试引用策略（默认）

1. 生产符号仅被 `tests/` 引用：标记为 B 级，默认不自动删除，需用户确认。
2. 测试目录私有 helper：可在测试目录独立清理，不计入生产瘦身收益。
3. 任务若明确“只做生产清理”，在开始前切换到生产搜索边界。

## 7. 判定记录模板（必须留档）

```text
符号: Trader.trackOrder
定义: src/core/trader/index.ts:88
广搜命中: 14
排除项: 类型声明 4 / 定义体 3 / return 引用 2 / 同文件内部调用 5
外部有效调用: 0
动态模式排查: 可选链(无) / 下标(无) / 解构(无) / 回调传递(无) / deps 传递(无)
边界检查: 非对外 API，非运行时注册键
结论: A（可删除）
```

未填写判定记录，不进入删除。

## 8. 结果输出模板

```text
[A 可删] Trader.trackOrder
- 证据: 外部调用 0；动态模式排查通过；非公共边界
- 删除: 接口声明 + return 暴露 + 包装器
- 保留: orderMonitor.trackOrder（内部仍有调用）

[B 保留] AutoSymbolManager.clearSeat
- 风险: 通过 deps 注入子状态机
- 处理: 仅收缩公共暴露，不删函数实体
```
