# Schema 组织与校验

本文展示 Schema 的组织原则和信任边界校验规则，涵盖：
- Schema 单一来源（DRY）
- 信任边界处 Schema 优先
- 何时需要/不需要 Schema

---

## 1. Schema 单一来源

避免在多处重复定义相同的校验逻辑。Schema 应在一处定义，到处引用。

### ❌ 错误：Schema 重复定义

```typescript
// ❌ 在 Express 端点中定义
app.post('/users', (req, res) => {
  const schema = z.object({ email: z.string().email(), name: z.string().min(1) });
  const result = schema.safeParse(req.body);
  // ...
});

// ❌ 在 GraphQL 解析器中重复定义相同 schema
const resolvers = {
  Mutation: {
    createUser: (_, args) => {
      const schema = z.object({ email: z.string().email(), name: z.string().min(1) });
      const validated = schema.parse(args.input);
      // ...
    },
  },
};
```

**问题：**
- ❌ 重复导致多个"事实来源"
- ❌ 修改需同步改多处
- ❌ 在知识层面违反 DRY
- ❌ 领域逻辑渗入基础设施代码

### ✅ 正确：在一处定义，到处引用

```typescript
// src/schemas/userRequests.ts — 单一来源
import { z } from 'zod';

export const CreateUserRequestSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
```

```typescript
// 在多个地方引用同一 schema
import { CreateUserRequestSchema } from '../schemas/userRequests.js';

// Express 端点
app.post('/users', (req, res) => {
  const result = CreateUserRequestSchema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: result.error });
  // 使用 result.data（已校验）
});

// GraphQL 解析器
const createUser = (input: unknown) => {
  const validated = CreateUserRequestSchema.parse(input);
  return userService.create(validated);
};
```

**好处：**
- ✅ 校验逻辑单一来源
- ✅ 修改 schema 后自动影响所有使用处
- ✅ 全库保持类型安全
- ✅ 在知识层面遵守 DRY

---

## 2. 信任边界处 Schema 优先

### 何时必须用 Schema

数据跨越信任边界（外部 → 内部）时：
- API 响应、用户输入、外部数据
- 类型带有校验规则（格式、约束）
- 多系统共享的数据契约
- 测试工厂中（保证测试数据完整且合法）

```typescript
// API 响应校验
const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
});
type User = z.infer<typeof UserSchema>;

// 在边界处校验
const user = UserSchema.parse(apiResponse);
```

### 何时不必用 Schema

纯内部数据无需 Schema 校验：
- 纯内部类型（工具、状态）
- Result/Option 等类型（无需校验）
- TypeScript 工具类型（`Partial<T>`、`Pick<T>` 等）
- 行为契约（interface，结构性约定，不做校验）
- 组件 props（除非来自 URL/API）

```typescript
// ✅ 不需要 schema
type Result<T, E> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };

// ✅ interface 不做校验
interface UserService {
  createUser(user: User): void;
}
```

---

## 3. Schema 组织方式

**常见做法：**
- **集中式**：`src/schemas/` 存放共享 schema
- **就近式**：放在使用它们的模块附近
- **分层式**：按架构层次拆分（若采用分层/六边形架构）

**原则：** 避免在多个文件中重复同一套校验逻辑。若校验逻辑被重复，应抽成共享 schema。
