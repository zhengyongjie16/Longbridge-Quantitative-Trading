---
name: dead-code-detection
description: 系统性搜索和删除 TypeScript 项目中的无用代码。适用于工厂函数模式和依赖注入架构。涵盖接口方法级死代码、门面模式透传包装器、常量、类型等检测。当用户提到"删除无用代码"、"清理死代码"、"dead code"、"unused code"、"代码清理"时使用此 skill。
---

# Dead Code Detection & Removal

TypeScript 工厂函数 + 依赖注入架构下的系统性死代码检测与删除流程。

## 无用代码定义

| 类别 | 说明 | 删除方式 |
|------|------|----------|
| **导出但从未被导入** | 函数/变量/类型被 `export` 但无任何外部文件 `import` | 删除整个导出，或仅移除 `export` 关键字（若内部使用） |
| **导出且仅被转发** | 被 re-export 但从未被真正调用/使用 | 删除 re-export 和源导出 |
| **仅在类型定义中引用** | 函数名仅出现在 `interface`/`type` 定义中，运行时无调用 | 从接口移除方法声明 + 移除实现 |
| **接口方法级死代码** | 接口上定义+实现了方法，但无外部代码通过该接口调用 | 从接口和 return 对象移除（可能保留内部实现，见安全规则） |
| **门面包装器死代码** | 门面/代理函数仅转发到内部模块，但自身从未被外部调用 | 删除包装函数 + 从 return 对象移除（保留内部实现） |
| **常量未使用** | 常量定义后从未被引用 | 删除常量 |
| **级联死代码** | 移除以上代码后产生的新的无用导入、变量、类型、deps 字段 | 逐层清理 |

## 检测策略（五层，按优先级）

### 第一层：接口方法级检测（最常见的盲区）

工厂函数返回的对象实现了一个接口，接口上的某些方法可能从未被外部消费者调用。

**双重搜索法：**

```
步骤 1 — 广搜：搜索方法名的所有调用点
  rg "\.methodName\(" src/

步骤 2 — 分类结果
  ✗ 接口/类型定义中的声明 → 排除
  ✗ 实现文件中的函数定义体 → 排除
  ✗ return 对象中的引用 → 排除
  ✗ 同模块内部子模块的调用（如 storage.xxx()）→ 排除
  ✓ 外部文件通过接口实例的调用 → 真正的外部调用

步骤 3 — 窄搜确认：用具体实例变量名验证
  rg "instanceVar\.methodName\(" src/
```

**定位实例变量名**：搜索工厂调用的接收变量（`const x = createX()`）、依赖注入参数名（`deps: { x: X }`）、上下文字段名（`context.x`）、属性透传（`y._x`）。

**优先检查的接口类型**：主门面接口、数据客户端接口、缓存接口、任务队列接口、子模块内部接口、服务接口。

### 第二层：门面/代理模式包装器检测

门面模式中，外层函数仅做转发，判定包装器是否被外部调用：

```typescript
// 若 orderRecorder.getBuyOrdersBelowPrice() 无外部调用 → 包装器可删
// 但 storage.getBuyOrdersBelowPrice() 若被内部其他方法调用 → 内部实现必须保留
function getBuyOrdersBelowPrice(price, dir, sym) {
  return storage.getBuyOrdersBelowPrice(price, dir, sym);
}
```

**核心原则：删除包装器 ≠ 删除内部实现。**

### 第三层：工厂返回对象属性检测

对 return 对象中的每个属性，搜索外部是否通过 `instance.propertyName` 访问。

### 第四层：导出函数/变量/常量/类型检测

对每个 `export`，搜索是否有外部文件导入并使用。若 `export` 的函数仅在同文件内使用，移除 `export` 关键字（保留函数）。

### 第五层：级联清理

每次删除后必须检查的级联项：

| 级联项 | 示例 |
|--------|------|
| **无用导入** | 删除 `trackOrder` 后 `OrderSide` 导入可能无用 |
| **无用类型** | 删除 `ensureSeatOnStartup` 后 `EnsureSeatOnStartupParams` 可能无用 |
| **无用变量** | 从 deps 解构的 `monitorConfig` 可能未使用 |
| **无用 deps 字段** | deps 类型中的 `autoSearchConfig` 字段可能无用 |
| **无用调用参数** | `createManager({ monitorConfig })` 中的参数可能无用 |
| **过时注释** | 模块注释描述了已删功能 |

## 执行流程

### Phase 1: 并行扫描

启动多个子代理并行分析不同模块区域，每个代理对区域内所有接口的每个方法执行双重搜索法：

```
代理 1: 公共类型文件中所有接口的每个方法（如 src/types/index.ts）
代理 2: src/core/ 下所有 types.ts 中的内部接口方法
代理 3: src/main/ 下所有 types.ts 中的接口方法 + 工厂返回对象属性
代理 4: src/services/ + src/utils/ + src/constants/ 的导出
```

**代理输出格式**：
```
方法: Trader.trackOrder
调用点: (排除定义和实现后)
  无外部调用
判定: 死代码
```

### Phase 2: 交叉验证

对每个候选死代码执行二次确认：

**1. 全名广搜** — 检查非标准调用模式：
```bash
rg "methodName" src/ --type ts
```
需排查：解构（`const { methodName } = instance`）、回调传递（`someFunc(instance.methodName)`）、动态属性（`instance['methodName']`）。

**2. 闭包依赖注入检查** — 这是最关键的验证：
```typescript
// index.ts — clearSeat 作为闭包依赖传给子工厂
createSwitchStateMachine({
  clearSeat: seatStateManager.clearSeat,  // 传入 ≠ 外部调用
});
// switchStateMachine.ts 内部通过 deps 调用
const { clearSeat } = deps;
clearSeat({ direction, reason });  // 内部真正使用
```
搜索 `methodName:` 和 `methodName,` 模式可发现此类传递。判定规则见安全规则第 2 条。

**3. 多层调用链追踪** — 每层独立验证：
```
Trader.trackOrder()  → orderMonitor.trackOrder()  → orderHoldRegistry.trackOrder()
若 trader.trackOrder() 无外部调用 → Trader 层死代码
但 orderMonitor.trackOrder() 需单独搜索 → 可能存活
```

### Phase 3: 安全删除

按顺序执行：

1. **接口层**：从 `interface`/`type` 移除方法声明
2. **实现层**：从工厂函数移除函数定义体 + 从 return 对象移除引用
3. **级联清理**：移除无用导入、类型、变量、deps 字段、调用参数、过时注释

**每完成一个模块后立即运行** `bun run type-check`。TypeScript 严格模式会通过 TS6133（变量未使用）和 TS6196（声明未使用）精确指出残留的级联问题，按报错逐一修复即可。

### Phase 4: 最终验证

```bash
bun run type-check   # 必须通过
bun run lint         # 必须通过
```

> Windows PowerShell 不支持 `&&`，需分开执行两条命令。

### Phase 5: 回顾审查

启动验证子代理对每个修改过的文件进行审查：

1. 确认接口定义与 return 对象的方法一一对应
2. 对每个被删方法，再次搜索确认无遗漏的外部调用
3. 确认内部调用链未被打断（包装器删除后，内部实现仍被内部方法调用）

## 安全规则（必须遵守）

### 不可删除的场景

**1. 内部实现被其他内部方法调用**

仅删公共接口和包装器，保留内部实现：
```
✓ 删除: OrderRecorder.getBuyOrdersBelowPrice（公共接口 + 包装函数）
✗ 不删: storage.getBuyOrdersBelowPrice（被 getProfitableSellOrders 内部调用）
```

**2. 闭包依赖注入的内部函数**

方法通过 deps 传入同模块子工厂内部使用时，仅删公共接口暴露，保留函数实体和传递代码：
```
✓ 删除: AutoSymbolManager 接口上的 clearSeat 声明 + return 对象中的 clearSeat
✗ 不删: seatStateManager.clearSeat 函数实体
✗ 不删: createSwitchStateMachine({ clearSeat: seatStateManager.clearSeat })
```

**3. 仅在启动/清理链路中调用一次的方法**

`src/index.ts` 或 cleanup 模块中可能仅调用一次，需搜索入口文件确认。

**4. 通过属性透传链访问的方法**

如 `trader._orderRecorder.fetchAllOrdersFromAPI()`，需搜索 `_orderRecorder\.methodName\(` 模式。

**5. 回调注册后运行时触发的方法**

如 `onVerified(callback)` 注册后在定时器/事件中触发。

### 操作纪律

1. **逐批验证**：每删一批后运行 type-check，不积累大量未验证的删除
2. **保守判断**：不确定时保留，宁可漏删不可错删
3. **搜索先行**：每个删除必须有搜索证据支撑，不凭直觉删除

## 常见误判场景

| 场景 | 为何不是死代码 | 识别方式 |
|------|---------------|----------|
| 方法作为闭包 deps 传入子工厂 | 子工厂内部通过 deps 调用 | 搜索 `methodName:` 或 `methodName,` 模式 |
| 内部函数被同文件其他函数调用 | 不在公共接口上但内部使用 | 广搜 `methodName` 查看同文件引用 |
| 类型仅作为函数参数/返回类型 | 编译期使用，非运行时死代码 | 搜索 `import type.*TypeName` |
| `_` 前缀方法 | 可能被外部通过 `._method()` 访问 | 搜索 `\._method\(` |
| 启动/清理流程中的方法 | 可能仅在入口文件调用一次 | 搜索 `src/index.ts` 和 cleanup 模块 |
| 属性透传链上的方法 | 如 `trader._orderRecorder.xxx()` | 搜索 `_orderRecorder\.xxx\(` |
| 被传递为回调的函数 | 注册后运行时会被触发 | 搜索函数名作为参数传递的模式 |
