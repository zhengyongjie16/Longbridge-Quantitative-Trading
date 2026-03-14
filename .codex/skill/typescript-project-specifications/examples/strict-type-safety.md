# 严格类型安全

本文展示 TypeScript 严格类型安全的核心规则，涵盖：

- 禁止 `any`，使用 `unknown`
- 禁止无理由的类型断言
- 禁止无说明的 `@ts-ignore`
- tsconfig.json 严格模式配置

---

## 1. 禁止使用 `any`

若类型确实未知，使用 `unknown`。`unknown` 是类型安全的 `any`——在使用前必须进行类型检查。

### ❌ 错误

```typescript
const parseJson = (input: string): any => JSON.parse(input);

const processData = (data: any) => {
  // 直接访问，无任何类型检查，运行时可能崩溃
  console.log(data.name.toUpperCase());
};
```

### ✅ 正确

```typescript
const parseJson = (input: string): unknown => JSON.parse(input);

const processData = (data: unknown) => {
  if (typeof data === 'object' && data !== null && 'name' in data) {
    const { name } = data as { name: unknown };
    if (typeof name === 'string') {
      console.log(name.toUpperCase());
    }
  }
};
```

---

## 2. 禁止无理由的类型断言

类型断言（`as Type`）绕过编译器检查，必须有明确原因。合理的使用场景：已通过 Schema 校验、第三方库类型不完善等。

### ❌ 错误：用断言掩盖类型不匹配

```typescript
const getUserName = (user: unknown): string => {
  // ❌ 无任何校验直接断言
  return (user as { name: string }).name;
};

const config = {} as AppConfig; // ❌ 空对象断言为完整配置
```

### ✅ 正确：先校验再使用，或用类型守卫

```typescript
const getUserName = (user: unknown): string | undefined => {
  if (typeof user === 'object' && user !== null && 'name' in user) {
    const { name } = user as { name: unknown };
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
};

// 使用 Schema 校验后的断言（合理——Schema 已保证类型正确）
const config = ConfigSchema.parse(rawConfig);
```

---

## 3. 禁止无说明的 `@ts-ignore`

若必须使用 `@ts-ignore`，须在注释中说明原因。

### ❌ 错误

```typescript
// @ts-ignore
const result = someFunction(invalidArg);
```

### ✅ 正确

```typescript
// @ts-ignore — 第三方库 @types/xxx v2.1.0 类型定义缺失 callback 参数，已提 issue #123
const result = someFunction(invalidArg);
```

---

## 4. tsconfig.json 严格模式配置

### 推荐配置

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "forceConsistentCasingInFileNames": true,
    "allowUnusedLabels": false
  }
}
```

### 各配置项含义

**核心严格选项：**

- **`strict: true`**：开启所有严格类型检查
- **`noImplicitAny`**：对隐式 `any` 报错
- **`strictNullChecks`**：`null` 和 `undefined` 单独成类型（不能赋给任意类型）
- **`noUnusedLocals`**：未使用的局部变量报错
- **`noUnusedParameters`**：未使用的函数参数报错
- **`noImplicitReturns`**：并非所有分支都返回值时报错
- **`noFallthroughCasesInSwitch`**：switch 中 fallthrough 报错

**额外安全选项（重要）：**

- **`noUncheckedIndexedAccess`**：数组/对象下标访问类型为 `T | undefined`（避免假定元素一定存在导致的运行时错误）
- **`exactOptionalPropertyTypes`**：区分 `property?: T` 与 `property: T | undefined`（类型更精确）
- **`noPropertyAccessFromIndexSignature`**：索引签名属性必须用方括号访问（提醒这是动态访问）
- **`forceConsistentCasingInFileNames`**：跨平台文件名大小写一致，避免问题
- **`allowUnusedLabels`**：未使用的 label 报错（避免无意义的 label）

### noUnusedParameters 的架构启示

未使用的参数往往说明该参数应该属于另一层。严格模式能尽早暴露设计问题。

**以上规则同时适用于测试代码与生产代码。**
