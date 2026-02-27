# 代码组织示例：types / utils / constants / tests

本文展示如何根据规范正确组织：

- 类型定义到 `types.ts`
- 工具函数到 `utils.ts`
- 常量统一到 `src/constants/index.ts`
- 单元测试到 `tests/`，并与 `src/` 目录结构一一对应

---

## 1. 目录结构示例

假设有如下业务场景：

- `src/aaa/bbb/index.ts` 与 `src/aaa/ccc/ddd/index.ts` 都使用同一个类型 `SharedConfig`
- `src/aaa/bbb/index.ts` 与 `src/aaa/ccc/ddd/index.ts` 都使用同一个工具函数 `calculateScore`
- 所有模块都需要使用统一常量 `MAX_RETRY_COUNT`

**正确的目录组织方式：**

```text
src/
├── aaa/
│   ├── types.ts              # aaa 级别的共享类型（如 SharedConfig）
│   ├── utils.ts              # aaa 级别的共享工具函数（如 calculateScore）
│   ├── bbb/
│   │   ├── index.ts          # 业务逻辑（引用 aaa/types.ts 与 aaa/utils.ts）
│   │   └── types.ts          # 仅 bbb 模块使用的私有类型
│   └── ccc/
│       ├── ddd/
│       │   ├── index.ts      # 业务逻辑（引用 aaa/types.ts 与 aaa/utils.ts）
│       │   └── types.ts      # 仅 ddd 子模块使用的私有类型
│       └── utils.ts          # 仅 ccc 子模块使用的私有工具函数
├── constants/
│   └── index.ts              # 所有全局常量统一放在这里
└── ...

tests/                         # 单元测试目录，与 src/ 结构对应
├── aaa/
│   ├── bbb/
│   │   └── index.test.ts     # 对应 src/aaa/bbb/index.ts
│   └── ccc/
│       └── ddd/
│           └── index.test.ts # 对应 src/aaa/ccc/ddd/index.ts
└── ...
```

---

## 2. 类型组织：跨模块共享与局部类型

### 2.1 跨模块共享类型放在共同父级的 `types.ts`

#### ✅ 正确示例

`src/aaa/types.ts`：

```typescript
export type SharedConfig = {
  readonly enabled: boolean;
  readonly threshold: number;
};
```

`src/aaa/bbb/types.ts`（仅 bbb 使用的私有类型）：

```typescript
export type BbbLocalState = {
  readonly id: string;
  readonly value: number;
};
```

`src/aaa/bbb/index.ts`：

```typescript
import type { SharedConfig } from '../types';
import type { BbbLocalState } from './types';

export const createBbb = (config: SharedConfig): BbbLocalState => {
  return {
    id: 'bbb',
    value: config.threshold,
  };
};
```

`src/aaa/ccc/ddd/index.ts`：

```typescript
import type { SharedConfig } from '../../types';

export const createDdd = (config: SharedConfig): string => {
  return config.enabled ? 'enabled' : 'disabled';
};
```

**要点：**

- `SharedConfig` 被 `bbb` 和 `ddd` 公共使用，因此放在它们共同父级目录 `src/aaa/types.ts`
- 每个子模块自己的本地类型（如 `BbbLocalState`）放在各自的 `types.ts` 中

### 2.2 错误示例：在多个子模块分别定义等价类型

#### ❌ 错误写法

`src/aaa/bbb/types.ts`：

```typescript
export type SharedConfig = {
  readonly enabled: boolean;
  readonly threshold: number;
};
```

`src/aaa/ccc/ddd/types.ts`：

```typescript
export type SharedConfig = {
  readonly enabled: boolean;
  readonly threshold: number;
};
```

问题：

- 相同结构的类型在多个文件重复定义，后续修改时极易不一致
- 违反了"共享类型应定义在公共 `types.ts` 文件"的规则

### 2.3 反例：公共类型不要放在祖父级，应放在最近共同父级

仅被 `bbb` 与 `ccc/ddd` 使用的类型，其**最近共同父级**是 `aaa`，应放在 `src/aaa/types.ts`，而不是 `src/types.ts`（祖父级）。

#### ❌ 错误写法

`src/types.ts`（祖父级，与 `src/aaa` 平级）：

```typescript
// ❌ SharedConfig 只被 aaa/bbb 和 aaa/ccc/ddd 使用，不应提升到 src 级
export type SharedConfig = {
  readonly enabled: boolean;
  readonly threshold: number;
};
```

问题：

- 公共类型应放在**使用它的多个模块的最近共同父级**，而非更上层的祖父级
- 放在祖父级会暴露给整个 `src` 下无关模块，职责边界模糊，耦合过宽

#### ✅ 正确

将 `SharedConfig` 定义在 `src/aaa/types.ts`（`bbb` 与 `ddd` 的共同父级），见 2.1。

### 2.4 反例：私有类型不要放在父级或祖父级公共 `types.ts`

仅被单一子模块使用的类型是**私有类型**，应定义在该模块自己的 `types.ts` 中，不能放在父级或祖父级的公共 `types.ts` 里。

#### ❌ 错误写法

`src/aaa/types.ts`（公共文件）：

```typescript
export type SharedConfig = {
  /* ... */
};

// ❌ BbbLocalState 仅被 bbb 使用，不应放在 aaa 的公共 types.ts
export type BbbLocalState = {
  readonly id: string;
  readonly value: number;
};
```

问题：

- 私有类型放在父级公共文件中会污染公共类型，其他模块可能误引用
- 违反"仅本模块使用的类型放在本模块 `types.ts`"的规则

#### ✅ 正确

将 `BbbLocalState` 定义在 `src/aaa/bbb/types.ts`，见 2.1。

---

## 3. 工具函数组织：跨模块共享与局部工具

### 什么是工具函数

满足以下条件的函数视为**工具函数**，必须放在 `utils.ts` 中（私有或公共的 `utils.ts` 文件，按使用范围选择）：

- **纯函数、无副作用**：相同入参得到相同结果；不改外部状态、不请求网络、不写库、不抛不可预期异常。
- **无业务归属**：不体现具体业务规则（如「是否允许下单」「风控阈值」），只做通用计算、格式、判断。
- **可复用**：多处或跨模块会用到，而不是只服务某一个流程的一小段逻辑。
- **职责单一**：做一件事（例如：算百分比、格式化字符串、安全地取数组元素）。

不符合上述条件的应放在业务模块（如 `index.ts`）或工厂/服务中，不要放入 `utils.ts`。

### 3.1 跨模块共享工具函数放在共同父级的 `utils.ts`

#### ✅ 正确示例

`src/aaa/utils.ts`：

```typescript
export const calculateScore = (value: number, threshold: number): number => {
  if (value <= 0) return 0;
  if (value >= threshold) return 100;
  return Math.round((value / threshold) * 100);
};
```

`src/aaa/bbb/index.ts`：

```typescript
import { calculateScore } from '../utils';

export const getBbbScore = (value: number, threshold: number): number => {
  return calculateScore(value, threshold);
};
```

`src/aaa/ccc/ddd/index.ts`：

```typescript
import { calculateScore } from '../../utils';

export const getDddScoreLabel = (value: number, threshold: number): string => {
  const score = calculateScore(value, threshold);
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
};
```

**要点：**

- `calculateScore` 被 `bbb` 和 `ddd` 公共使用，因此放在它们共同父级目录 `src/aaa/utils.ts`
- 子模块各自的私有工具函数仍然放在各自目录下的 `utils.ts` 中

### 3.2 错误示例：在多个子模块复制粘贴相同工具函数

#### ❌ 错误写法

`src/aaa/bbb/utils.ts`：

```typescript
export const calculateScore = (value: number, threshold: number): number => {
  if (value <= 0) return 0;
  if (value >= threshold) return 100;
  return Math.round((value / threshold) * 100);
};
```

`src/aaa/ccc/ddd/utils.ts`：

```typescript
export const calculateScore = (value: number, threshold: number): number => {
  if (value <= 0) return 0;
  if (value >= threshold) return 100;
  return Math.round((value / threshold) * 100);
};
```

问题：

- 相同逻辑的工具函数在多个文件重复实现，修改时容易遗漏
- 违反了"公共工具应定义在公共 `utils.ts` 文件中"的规则

### 3.3 反例：公共工具函数不要放在祖父级，应放在最近共同父级

仅被 `bbb` 与 `ccc/ddd` 使用的工具函数，其**最近共同父级**是 `aaa`，应放在 `src/aaa/utils.ts`，而不是 `src/utils.ts`（祖父级）。

#### ❌ 错误写法

`src/utils.ts`（祖父级）：

```typescript
// ❌ calculateScore 只被 aaa/bbb 和 aaa/ccc/ddd 使用，不应提升到 src 级
export const calculateScore = (value: number, threshold: number): number => {
  if (value <= 0) return 0;
  if (value >= threshold) return 100;
  return Math.round((value / threshold) * 100);
};
```

问题：

- 公共工具函数应放在**使用它的多个模块的最近共同父级**，而非更上层的祖父级
- 放在祖父级会暴露给整个 `src` 下无关模块，职责边界模糊

#### ✅ 正确

将 `calculateScore` 定义在 `src/aaa/utils.ts`，见 3.1。

### 3.4 反例：私有工具函数不要放在父级或祖父级公共 `utils.ts`

仅被单一子模块使用的工具函数是**私有工具**，应定义在该模块自己的 `utils.ts` 中，不能放在父级或祖父级的公共 `utils.ts` 里。

#### ❌ 错误写法

`src/aaa/utils.ts`（公共文件）：

```typescript
export const calculateScore = (value: number, threshold: number): number => {
  /* ... */
};

// ❌ formatBbbId 仅被 bbb 使用，不应放在 aaa 的公共 utils.ts
export const formatBbbId = (id: string): string => `bbb-${id}`;
```

问题：

- 私有工具放在父级公共文件中会污染公共 utils，其他模块可能误引用
- 违反"仅本模块使用的工具放在本模块 `utils.ts`"的规则

#### ✅ 正确

将 `formatBbbId` 定义在 `src/aaa/bbb/utils.ts`，仅在 `bbb` 内引用。

---

## 4. 常量组织：统一放在 `src/constants/index.ts`

### 4.1 正确示例

`src/constants/index.ts`：

```typescript
export const MAX_RETRY_COUNT = 3;
export const DEFAULT_THRESHOLD = 100;
```

`src/aaa/bbb/index.ts`：

```typescript
import { MAX_RETRY_COUNT } from '../../constants';

export const retryOperation = (run: () => void): void => {
  for (let i = 0; i < MAX_RETRY_COUNT; i += 1) {
    run();
  }
};
```

`src/aaa/ccc/ddd/index.ts`：

```typescript
import { DEFAULT_THRESHOLD } from '../../../constants';

export const isAboveDefaultThreshold = (value: number): boolean => {
  return value >= DEFAULT_THRESHOLD;
};
```

**要点：**

- 所有常量统一集中到 `src/constants/index.ts`
- 其他模块**只能从这里引用**，不得在业务模块中随意定义重复常量

### 4.2 错误示例：在各个模块中硬编码或重复定义常量

#### ❌ 错误写法

`src/aaa/bbb/index.ts`：

```typescript
const MAX_RETRY_COUNT = 3; // ❌ 与其他模块重复
```

`src/aaa/ccc/ddd/index.ts`：

```typescript
const DEFAULT_THRESHOLD = 100; // ❌ 与其他模块重复
```

问题：

- 常量分散在多个文件中，不利于统一修改和查找
- 容易出现值不一致的问题

---

## 5. 单元测试组织：`tests/` 与 `src/` 目录结构一一对应

### 5.1 正确示例

`src/aaa/bbb/index.ts`：

```typescript
export const sum = (a: number, b: number): number => a + b;
```

对应的测试文件放在 `tests/aaa/bbb/index.test.ts`：

```typescript
import { sum } from '../../../src/aaa/bbb/index';

describe('sum', () => {
  it('adds two numbers', () => {
    expect(sum(1, 2)).toBe(3);
  });
});
```

`src/aaa/ccc/ddd/index.ts`：

```typescript
export const multiply = (a: number, b: number): number => a * b;
```

对应的测试文件放在 `tests/aaa/ccc/ddd/index.test.ts`：

```typescript
import { multiply } from '../../../../src/aaa/ccc/ddd/index';

describe('multiply', () => {
  it('multiplies two numbers', () => {
    expect(multiply(2, 3)).toBe(6);
  });
});
```

**要点：**

- `tests/` 下的目录结构必须与 `src/` 一一对应
- 测试文件命名建议为 `*.test.ts`，便于测试框架自动识别

### 5.2 错误示例：将所有测试混在一个目录或文件中

#### ❌ 错误写法

`tests/index.test.ts`：

```typescript
// 同时测试 src/aaa/bbb/index.ts 和 src/aaa/ccc/ddd/index.ts
// ❌ 所有测试堆在一起，难以维护和定位
```

问题：

- `tests/` 目录结构与 `src/` 不对应，查找测试文件困难
- 模块间测试相互耦合，后续拆分与重构成本高

---

## 6. 小结

- **类型**：先判断使用范围，跨模块共享类型放在**最近共同父级**的 `types.ts` 中，局部类型放在各自模块的 `types.ts` 中。公共类型不要提升到祖父级；私有类型不要放进父级/祖父级公共 `types.ts`。
- **工具函数**：公共工具函数放在**最近共同父级**的 `utils.ts` 中，避免复制粘贴；各模块的私有工具函数放在本模块 `utils.ts` 中。公共工具不要提升到祖父级；私有工具不要放进父级/祖父级公共 `utils.ts`。
- **常量**：所有常量统一放在 `src/constants/index.ts`，禁止在业务模块中到处定义重复常量
- **测试**：单元测试统一放在 `tests/` 下，并与 `src/` 目录结构一一对应，便于查找和维护
