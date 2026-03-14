# 注释规范示例

## 文件头注释

新增 `.ts` 模块（除 `types.ts`、`utils.ts` 及 `types/`、`utils/` 下的文件外）必须添加文件头块注释，描述"模块名 + 功能/职责/执行流程"。

```typescript
// ✅ src/services/autoSymbolFinder/index.ts
/**
 * autoSymbolFinder — 自动标的筛选服务
 *
 * 订阅行情快照，按信号策略筛选符合条件的交易标的，
 * 并将结果写入候选队列供主交易循环消费。
 */
export function createAutoSymbolFinder(deps: Deps): AutoSymbolFinder { ... }

// ✅ tests/services/autoSymbolFinder/index.business.test.ts
/**
 * autoSymbolFinder 业务逻辑测试
 *
 * 验证筛选策略的边界条件：信号命中、过滤规则、候选队列写入行为。
 */
describe('autoSymbolFinder', () => { ... })

// ❌ 错误：缺少文件头注释
export function createAutoSymbolFinder(deps: Deps): AutoSymbolFinder { ... }
```

---

## types.ts / types/ — 类型定义注释

无需文件头注释，但每个类型必须有独立块注释，说明用途、数据来源（如适用）和使用范围。

```typescript
// ✅
/** autoSymbolFinder 工厂函数的依赖注入参数 */
type Deps = {
  readonly quoteContext: QuoteContext;
  readonly config: SymbolFinderConfig;
};

/** 候选标的条目，由筛选结果写入候选队列，仅供主交易循环内部消费 */
type CandidateEntry = {
  readonly symbol: string;
  readonly score: number;
};

// ❌ 缺少注释
type Deps = { ... }
```

---

## utils.ts / utils/ — 工具函数注释

无需文件头注释，但每个工具函数必须有完整 JSDoc，包含功能说明、`@param`、`@returns`。

```typescript
// ✅
/**
 * 将原始信号分数归一化到 [0, 1] 区间。
 * 若 max === min，默认返回 0 避免除以零。
 * @param score 原始分数
 * @param min 样本最小值
 * @param max 样本最大值
 * @returns 归一化后的分数
 */
export function normalizeScore(score: number, min: number, max: number): number {
  if (max === min) return 0;
  return (score - min) / (max - min);
}

// ❌ 缺少 JSDoc
export function normalizeScore(score: number, min: number, max: number): number { ... }
```

---

## 关键函数注释

核心业务流程、状态机迁移、风控检查、生命周期处理、异步队列处理等必须有函数注释，说明"做什么 + 为什么"，必要时补充副作用。

```typescript
// ✅ 风控检查函数
/**
 * 执行开仓前风控门禁。
 * 依次检查：账户余额 → 持仓上限 → 冷却期，任一不通过立即短路返回，
 * 避免后续昂贵的行情查询。余额不足时同步触发告警推送。
 */
function checkOpenRisk(context: RiskContext): RiskResult { ... }

// ✅ 状态机迁移
/**
 * 将订单状态从 PENDING 迁移到 FILLED。
 * 迁移成功后刷新持仓缓存（副作用），确保后续风控读到最新持仓。
 */
function transitionToFilled(order: PendingOrder): FilledOrder { ... }

// ❌ 关键函数缺少注释
function checkOpenRisk(context: RiskContext): RiskResult { ... }
```

---

## 行内注释

仅用于解释复杂业务判断或顺序约束，避免对显而易见的代码重复描述。

```typescript
// ✅ 解释顺序约束
// 必须先检查冷却期，再检查余额：冷却期失败时无需查询账户余额（减少 API 调用）
if (!cooldownPassed(symbol)) return failure('cooldown');
if (!hasSufficientBalance(account)) return failure('balance');

// ✅ 解释业务判断
// 牛熊证距到期日 ≤ 3 个交易日时强制平仓，防止到期归零
if (daysToExpiry <= 3) return forceClose(position);

// ❌ 对显而易见代码写注释
const total = price * quantity; // 计算总价
```

---

## 测试代码注释

保持轻量，重点说明场景意图、边界条件和业务期望。

```typescript
// ✅
it('信号分数等于阈值时应触发买入', () => {
  // 边界：score === threshold，验证闭区间语义
  const result = evaluateSignal({ score: THRESHOLD });
  expect(result.action).toBe('buy');
});

it('冷却期内不允许重复开仓', () => {
  triggerOpen(symbol);
  const second = tryOpen(symbol); // 立即再次尝试，应被冷却期阻断
  expect(second.blocked).toBe(true);
});

// ❌ 为每个断言都写注释（过度）
expect(result.action).toBe('buy'); // 验证 action 是 buy
expect(result.price).toBe(100); // 验证 price 是 100
```
