# ADX 延迟验证指标系统性改造方案（评审稿）

## 1. 需求确认与目标边界

### 1.1 已确认需求

1. 新增 `ADX` 指标，包含：
   - 指标计算
   - 实时显示
   - 延迟验证业务逻辑
2. ADX 是趋势强度指标，无方向性。
3. 无论信号类型如何，ADX 的真实业务目标都一致：
   - `T0`、`T0+5s`、`T0+10s` 三个时间点均需 **小于** 初始 ADX。
4. 兼容现有延迟验证框架（现有框架按动作分为“上涨比较”与“下跌比较”）：
   - `SELLCALL`、`BUYPUT`：ADX 使用正数比较（`<`）
   - `BUYCALL`、`SELLPUT`：ADX 使用负数比较（`>`）
5. 实时显示统一为 ADX 正数显示，不显示负值；负值仅用于延迟验证内部比较变换。
6. 术语确认：需求中的 `BUYPULL` 已按 `BUYPUT` 执行。

### 1.2 本次方案范围

1. 仅新增并接入 ADX，不改变其他指标语义。
2. 不调整既有延迟验证调度时序（`T0/T0+5s/T0+10s`，容忍度 ±5s）。
3. 不改动交易执行、风控顺序、席位版本门禁等非指标链路。

## 2. 当前系统现状（与 ADX 相关）

### 2.1 延迟验证当前规则

当前 `DelayedSignalVerifier` 的核心比较逻辑为：

1. `BUYCALL`、`SELLPUT` 走“上涨比较”：`current > initial`
2. `BUYPUT`、`SELLCALL` 走“下跌比较”：`current < initial`

该逻辑适用于方向性指标，但对 ADX（无方向）需要做专门映射。

### 2.2 指标数据链路

当前指标链路是：

`candles -> indicator snapshot -> indicatorCache -> delayed verifier / market monitor`

要让 ADX 全链路可用，需要同步改造：

1. 指标计算：`services/indicators`
2. 快照类型：`types/quote.ts`
3. 监控缓存：`types/data.ts` + `objectPool`
4. 缓存克隆：`indicatorCache/utils.ts`
5. 指标读取：`utils/indicatorHelpers`
6. 配置解析：`config/utils.ts` + 常量集合
7. 实时显示与变化检测：`services/marketMonitor`
8. 延迟验证比较：`main/asyncProgram/delayedSignalVerifier/utils.ts`

## 3. ADX 判定模型（核心）

### 3.1 统一业务目标

对任意信号动作，ADX 验证目标都为：

`ADX_t < ADX_0`（t ∈ {T0, T0+5s, T0+10s}）

### 3.2 与现有框架兼容的映射函数

定义动作级别判定：

1. `isUptrendAction = (action === 'BUYCALL' || action === 'SELLPUT')`
2. `needNegativeForAdx = (indicatorName === 'ADX') && isUptrendAction`

定义比较值变换：

1. `effectiveInitial = needNegativeForAdx ? -initialValue : initialValue`
2. `effectiveCurrent = needNegativeForAdx ? -currentValue : currentValue`

然后复用原比较分支：

1. 若 `isUptrendAction`：判断 `effectiveCurrent > effectiveInitial`
2. 否则：判断 `effectiveCurrent < effectiveInitial`

### 3.3 逻辑正确性证明（关键）

#### 情况 A：`SELLCALL` / `BUYPUT`

1. `needNegativeForAdx = false`
2. 使用原值比较：`current < initial`
3. 与业务目标一致：`ADX_t < ADX_0`

#### 情况 B：`BUYCALL` / `SELLPUT`

1. `needNegativeForAdx = true`
2. 比较变为：`(-current) > (-initial)`
3. 数学等价：`current < initial`
4. 与业务目标一致：`ADX_t < ADX_0`

结论：四类动作最终全部等价于“ADX 三时点都小于初始 ADX”，且不破坏现有框架。

## 4. 全链路改造方案

### 4.1 指标计算层：新增 ADX 计算

改造目标：

1. 新增 `src/services/indicators/adx.ts`
2. 采用标准 Wilder ADX 流程（默认周期 14）
3. 输出 `number | null`，无效输入或样本不足返回 `null`

接入点：

1. `src/services/indicators/snapshotBuilder.ts`
2. 在 `buildIndicatorSnapshot` 返回结构中新增 `adx`

### 4.2 类型与对象池层：补齐 ADX 字段

改造文件：

1. `src/types/quote.ts` 的 `IndicatorSnapshot` 增加 `adx: number | null`
2. `src/types/data.ts` 的 `MonitorValues` 增加 `adx: number | null`
3. `src/utils/objectPool/types.ts` 的 `PoolableMonitorValues` 增加 `adx`
4. `src/utils/objectPool/index.ts` 监控值对象池初始化/重置增加 `adx`
5. `src/main/asyncProgram/indicatorCache/utils.ts` 的克隆逻辑复制 `adx`

目标：

1. 保证 ADX 可进入缓存、可被监控状态持有、不会因对象池释放导致引用污染。

### 4.3 配置与解析层：允许 ADX 作为延迟验证指标

改造文件：

1. `src/constants/index.ts`
   - `VERIFICATION_FIXED_INDICATORS` 增加 `ADX`
2. `src/config/utils.ts`
   - `parseVerificationIndicators` 文案与支持范围增加 `ADX`
3. `README.md`
   - `VERIFICATION_INDICATORS_BUY_N/SELL_N` 可选值列表补充 `ADX`

目标：

1. 允许通过环境变量直接配置 ADX 延迟验证。
2. 配置、运行时日志、文档三者一致。

### 4.4 指标读取层：延迟验证初始值提取支持 ADX

改造文件：

1. `src/utils/indicatorHelpers/types.ts`：`IndicatorState` 增加 `adx`
2. `src/utils/indicatorHelpers/index.ts`：`getIndicatorValue` 增加 `case 'ADX'`

目标：

1. 策略在生成延迟信号时可提取 `indicators1.ADX`。
2. 延迟验证在任意时间点可读取快照中的 ADX。

### 4.5 延迟验证层：实现 ADX 正负值比较分流

改造文件：

1. `src/main/asyncProgram/delayedSignalVerifier/utils.ts`

改造原则：

1. 不改时序，不改三点读取，不改缺失点失败规则。
2. 不改其他指标比较逻辑。
3. 只对 `indicatorName === 'ADX'` 且 `action in {BUYCALL, SELLPUT}` 做负值变换后比较。

目标：

1. 保持现有框架结构不变。
2. 满足 ADX 的统一业务目标与动作兼容要求。

### 4.6 实时显示层：仅正数显示 ADX

改造文件：

1. `src/services/marketMonitor/index.ts`

改造项：

1. 指标打印行新增 `ADX=...`（正数）
2. 指标变化检测新增 ADX 阈值检测
3. `monitorValues` 同步写入 `adx`

目标：

1. 控制台实时观察 ADX 变化。
2. 显示层不引入负值概念，避免业务误读。

## 5. 关键业务规则（明确落地口径）

### 5.1 三时点规则

对于 ADX，必须同时满足：

1. `ADX(T0) < ADX0`
2. `ADX(T0+5s) < ADX0`
3. `ADX(T0+10s) < ADX0`

任一点不满足即验证失败。

### 5.2 缺失数据规则

若任一时间点快照缺失，则按当前机制直接失败，不新增兜底。

### 5.3 多指标混合规则

当验证指标同时包含 ADX 与其他指标时：

1. ADX 按本方案“动作感知的正负值映射”比较。
2. 其他指标保持原规则比较。
3. 所有指标在三时点均通过才整体通过（现有 AND 语义）。

## 6. 测试方案（系统性）

### 6.1 指标计算测试

文件：

1. `tests/services/indicators/business.test.ts`

新增断言：

1. 样本足够时 ADX 可计算为有限数
2. 样本不足/无效输入时 ADX 为 `null`

### 6.2 延迟验证测试（重点）

文件：

1. `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`

新增场景：

1. `SELLCALL + ADX`：三点下降，验证通过（正值路径）
2. `BUYPUT + ADX`：三点下降，验证通过（正值路径）
3. `BUYCALL + ADX`：三点下降，验证通过（负值路径）
4. `SELLPUT + ADX`：三点下降，验证通过（负值路径）
5. 任一时间点 ADX 未下降，验证失败
6. 缺失任一点，验证失败

### 6.3 实时监控测试

文件：

1. `tests/services/marketMonitor/business.test.ts`

新增场景：

1. ADX 首次有效值触发指标变更
2. ADX 超阈值变化触发刷新
3. `monitorValues.adx` 与快照一致

### 6.4 其他受影响测试同步

由于 `IndicatorSnapshot` 增加字段，所有构造快照的测试替身需同步补齐 `adx`，避免类型错误或隐式默认差异。重点包括：

1. `tests/main/processMonitor/indicatorPipeline.business.test.ts`
2. `tests/main/processMonitor/signalPipeline.business.test.ts`
3. `tests/helpers/testDoubles.ts`（若包含快照工厂）
4. 其他直接字面量构造 `IndicatorSnapshot` 的测试文件

## 7. 文件改造清单（实施阶段）

### 7.1 生产代码

1. `src/services/indicators/adx.ts`（新增）
2. `src/services/indicators/snapshotBuilder.ts`
3. `src/types/quote.ts`
4. `src/types/data.ts`
5. `src/utils/objectPool/types.ts`
6. `src/utils/objectPool/index.ts`
7. `src/main/asyncProgram/indicatorCache/utils.ts`
8. `src/constants/index.ts`
9. `src/config/utils.ts`
10. `src/utils/indicatorHelpers/types.ts`
11. `src/utils/indicatorHelpers/index.ts`
12. `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
13. `src/services/marketMonitor/index.ts`
14. `README.md`

### 7.2 测试代码

1. `tests/services/indicators/business.test.ts`
2. `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
3. `tests/services/marketMonitor/business.test.ts`
4. 其余受 `IndicatorSnapshot` 新字段影响的测试文件

## 8. 风险与控制

### 8.1 主要风险

1. 把 ADX 误当方向指标，导致 `BUYCALL/SELLPUT` 判定相反。
2. 实时显示误用负值，造成运营侧解读混乱。
3. 类型字段新增后漏改测试替身，导致大量编译失败。
4. 延迟验证日志符号显示与实际比较值不一致，影响排障。

### 8.2 控制措施

1. 在 `delayedSignalVerifier` 中将“ADX 负值映射”封装为明确分支，避免散落逻辑。
2. 显示层严格只读 `snapshot.adx` 原值，不参与符号变换。
3. 以 `rg "IndicatorSnapshot"` 全量排查并补齐测试字面量。
4. 增加四动作 ADX 专项测试，形成回归护栏。

## 9. 验收标准

1. 配置支持 `VERIFICATION_INDICATORS_*` 中使用 `ADX`。
2. 实时日志可见 `ADX=xxx`，且为正数显示。
3. 延迟验证中：
   - `SELLCALL`、`BUYPUT`：按正值 `<` 判定
   - `BUYCALL`、`SELLPUT`：按负值 `>` 判定
4. 四类动作最终业务效果均为 ADX 三时点小于初始值。
5. 全量通过：
   - `bun lint`
   - `bun type-check`
   - 受影响测试集

## 10. 实施顺序建议

1. 先加类型与快照字段（确保编译面可控）。
2. 接入 ADX 计算到快照。
3. 接入配置解析与指标读取。
4. 实现延迟验证 ADX 专项比较逻辑。
5. 实时显示与变化检测接入。
6. 最后统一补测试并跑 `lint`/`type-check`。

---

本方案保证：

1. ADX 的业务语义统一且正确（本质都判断下降）。
2. 与现有延迟验证框架兼容，不引入补丁式旁路。
3. 实时显示与验证内部判断职责分离，降低运营误解风险。
