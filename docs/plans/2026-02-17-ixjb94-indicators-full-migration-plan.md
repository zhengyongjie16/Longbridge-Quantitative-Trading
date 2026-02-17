# 指标引擎重构方案：以 @ixjb94/indicators 源码完全替代 technicalindicators

**日期**: 2026-02-17  
**作者**: Codex  
**目标仓库**: `D:/code/Longbridge-Quantitative-Trading`

## 0. 实施落地说明（2026-02-18 更新）

1. 本次迁移采用“源码直接整合到现有指标文件”的方式落地，未新增独立 `engine/ixjb` 目录。
2. ixjb 相关算法已整合进以下生产文件：
   - `src/services/indicators/ema.ts`
   - `src/services/indicators/rsi.ts`
   - `src/services/indicators/macd.ts`
   - `src/services/indicators/mfi.ts`
   - `src/services/indicators/kdj.ts`
3. 第三方许可证声明位于：
   - `THIRD_PARTY_NOTICES.md`
4. parity baseline fixture 已固化为 `tests/fixtures/indicators/parityBaseline.json`；一次性生成脚本不作为当前仓库常驻内容。

## 1. 目标与硬性约束

1. 将当前项目中的技术指标计算实现，完整替换为来自 `@ixjb94/indicators` 的源码实现（不安装 npm 包）。
2. 完全弃用并移除 `technicalindicators` 依赖与代码引用。
3. 迁移必须是系统性重构，不允许“兼容补丁式”双轨长期共存。
4. 必须保证业务逻辑不变，指标结果与迁移前保持一致（以迁移前行为为基准）。
5. 必须补充充分测试，覆盖指标函数级、快照级、策略链路级等价性。
6. 对外指标 API 保持同步语义，不允许把现有同步调用链改为 Promise 链。

## 2. 当前现状盘点（仓库实测）

### 2.1 直接依赖 technicalindicators 的生产代码

1. `src/services/indicators/ema.ts`
2. `src/services/indicators/rsi.ts`
3. `src/services/indicators/macd.ts`
4. `src/services/indicators/mfi.ts`
5. `src/services/indicators/kdj.ts`

### 2.2 依赖声明与锁文件

1. `package.json` 依赖包含 `technicalindicators: ^3.1.0`
2. `bun.lock` 包含 `technicalindicators` 解析记录

### 2.3 现有测试覆盖情况

1. 现有 `tests/services/indicators/business.test.ts` 主要是可用性与边界保护测试。
2. 当前缺少“迁移前后数值逐点等价”的系统性回归测试。
3. 需要新增可复现的指标金标数据（golden fixtures）与多层级一致性测试。

## 3. @ixjb94/indicators 源码审计结果（已读取源码）

### 3.1 上游版本与许可

1. 上游仓库：`https://github.com/ixjb94/indicators`
2. 当前 HEAD（读取时）：`da710cfa77a9704e20cf9c5d551039b5026c30d5`
3. 许可：MIT（`LICENCE.md`）
4. 结论：允许复制并改造，但必须保留版权与许可声明。

### 3.2 本项目所需指标对应源码文件

1. `src/core/extract/ema.ts`
2. `src/core/extract/rsi.ts`
3. `src/core/extract/macd.ts`
4. `src/core/extract/mfi.ts`
5. `src/core/extract/stoch.ts`（仅用于 KDJ 对齐分析，非直接等价替换）
6. `src/types/indicators.ts`（Buffer 类型定义）

### 3.3 与当前行为的关键差异（必须在方案中处理）

1. EMA 初始化差异：`technicalindicators` EMA 先以 SMA 预热，`ixjb` EMA 从首个值直接递推。
2. RSI 输出精度差异：`technicalindicators` RSI 输出存在精度收敛特征，`ixjb` 为高精度浮点。
3. MACD 微差异：由 EMA 初始化路径不同导致。
4. MFI 对齐差异：输出窗口起点与 `technicalindicators` 有偏移特征（需对齐窗口定义）。
5. KDJ 当前实现依赖 `technicalindicators` 的 `EMA.nextValue` 行为；`ixjb` 的 `stoch` 是 SMA 平滑，不可直接替代当前 KDJ 行为。

本节结论：迁移不是“直接替换函数名”，而是“以 ixjb 源码为基础重建等价计算语义”。

## 4. 目标架构（迁移后）

### 4.1 本地指标内核落地方式（源码整合到原文件结构）

1. 不新增独立引擎子目录，直接在现有指标模块内整合 ixjb 对应算法。
2. 落地文件：
   - `src/services/indicators/ema.ts`
   - `src/services/indicators/rsi.ts`
   - `src/services/indicators/macd.ts`
   - `src/services/indicators/mfi.ts`
   - `src/services/indicators/kdj.ts`
3. 第三方许可证声明统一放置在 `THIRD_PARTY_NOTICES.md`。
4. 仅做必要工程化改造（导入路径、类型适配、同步语义保持），不引入新 npm 依赖。

### 4.2 生产指标模块保持原入口不变

1. 保持 `src/services/indicators/*.ts` 的导出函数签名不变。
2. 内部直接使用整合后的 ixjb 算法实现（位于原指标文件中）。
3. `buildIndicatorSnapshot` 的输入输出结构与对象池策略不变。
4. 删除所有 `from 'technicalindicators'` 的 import。

### 4.3 依赖与文档

1. 从 `package.json` 删除 `technicalindicators`。
2. 重新生成 `bun.lock`。
3. 更新文档中“项目实际依赖 technicalindicators”的描述（至少更新 `docs/bun-vs-node-benchmark.md` 与 `docs/TECHNICAL_INDICATORS.md` 的定位说明）。

## 5. 系统性实施步骤（分阶段）

### 阶段 A：基线冻结（迁移前结果固化）

1. 新增基线生成脚本：`tools/generateIndicatorBaseline.ts`。
2. 新增 `package.json` 脚本：`test:generate-indicator-baseline`。
3. 使用当前生产实现（technicalindicators）生成多组数据基线，写入 `tests/fixtures/indicators/*.json`。
4. 基线至少覆盖：EMA/RSI/MACD/MFI/KDJ/整包 `IndicatorSnapshot`。
5. 数据集来源：
   - 合成趋势数据（单边上涨、单边下跌、震荡、跳空）。
   - 含噪声随机数据（固定 seed，保证可重放）。
   - 边界数据（最小长度、含无效 candle 值、极端值）。
6. 固定随机种子清单：`[7, 17, 29, 97, 233, 997]`，每个 seed 至少生成 50 组样本。
7. 每个 fixture 必须包含元信息：
   - `generatorVersion`
   - `baselineDate`（ISO 8601）
   - `sourceLibraryVersion`（technicalindicators 版本）
   - `seed`
   - `datasetType`
8. `test:generate-indicator-baseline` 仅用于阶段 A 冻结基线，不纳入 CI；阶段 D 删除 `technicalindicators` 后不再执行该脚本。

### 阶段 B：引入 ixjb 源码内核（按原文件结构整合）

1. 将上游对应源码逻辑整合进既有 `src/services/indicators/*.ts` 指标模块。
2. 保留上游版权与 MIT 声明（集中记录在 `THIRD_PARTY_NOTICES.md`）。
3. 仅做必要工程化改造：
   - 导入路径修正。
   - `Array<number>` 与 `ReadonlyArray<number>` 适配。
   - 移除项目不需要的异步封装，统一为同步纯函数。
4. 不引入任何 npm 新依赖。

### 阶段 C：构建“等价输出适配层”（一次性系统设计，不保留双轨）

1. 在本地引擎层实现统一 adapter，使最终输出对齐迁移前行为。
2. EMA：对齐现有输出窗口与初始化策略，确保最终 `calculateEMA` 返回值一致：
   - 使用 `SMA(period)` 作为首个 EMA 种子值。
   - 后续使用 `ema = ((price - ema) * 2 / (period + 1)) + ema`。
   - 输出窗口与旧实现一致（首个有效输出出现时机一致）。
3. RSI：对齐精度策略（与迁移前行为一致）：
   - 使用 Wilder 平滑增益/损失算法。
   - RSI 输出值按旧实现行为进行同精度收敛（与 baseline 一致）。
4. MACD：对齐 DIF/DEA/MACD 柱值（含 `histogram * 2` 约定）：
   - DIF = EMA(fast) - EMA(slow)。
   - DEA 使用与旧实现一致的 EMA 信号线窗口。
   - 对外 `macd` 字段固定为 `2 * histogram`。
5. MFI：对齐输出窗口起点与尾值：
   - 资金流方向与典型价格计算保持旧实现一致。
   - 序列起始索引对齐旧实现，禁止出现一位偏移。
   - 输出数值精度与 baseline 保持一致。
6. KDJ：以 ixjb 源码组件重建当前 KDJ 计算流程，不改变现有 K/D/J 业务语义，必须严格复刻当前逻辑细节：
   - RSV 窗口周期 `period=9`，仅在窗口高低价和收盘价均有效时计算。
   - `range = highestHigh - lowestLow`，`range===0` 时跳过该点。
   - K 平滑：EMA(period=5)，先注入 `nextValue(50)` 预热。
   - D 平滑：EMA(period=5)，先注入 `nextValue(50)` 预热。
   - 当 `nextValue` 返回 `undefined` 时，沿用上一值；若无上一值则回退到 `50`。
   - `J = 3*K - 2*D`。
7. 该适配层属于重构目标架构内的一部分，不作为临时兼容代码保留。

### 阶段 D：替换生产调用并清理旧依赖

1. 修改：`src/services/indicators/ema.ts`
2. 修改：`src/services/indicators/rsi.ts`
3. 修改：`src/services/indicators/macd.ts`
4. 修改：`src/services/indicators/mfi.ts`
5. 修改：`src/services/indicators/kdj.ts`
6. 修改：`src/services/indicators/index.ts` 模块注释（移除 technicalindicators 描述）
7. 删除 `technicalindicators` 依赖并更新锁文件。
8. 删除依赖动作必须在 parity 测试全通过之后执行；若 parity 未通过，禁止进入依赖清理步骤。

### 阶段 E：测试体系重构与扩充

新增测试文件建议：

1. `tests/services/indicators/engineParity.business.test.ts`
2. `tests/services/indicators/snapshotParity.business.test.ts`
3. `tests/services/indicators/kdjParity.business.test.ts`
4. `tests/core/strategy/signalParity.business.test.ts`
5. `tests/main/processMonitor/indicatorPipeline.parity.business.test.ts`
6. `tests/main/asyncProgram/delayedSignalVerifier.parity.business.test.ts`

测试设计要求：

1. 指标函数级：逐项断言与 baseline 完全一致（数值比较规则见 6.1）。
2. 快照级：`buildIndicatorSnapshot` 全字段断言一致（数值比较规则见 6.1）。
3. 策略级：同一 candle 序列下，生成信号类型、触发时机、延迟验证输入一致。
4. 随机回归：固定 seed 的 100+ 组序列自动回放。
5. 失败即阻断：任一指标出现不一致即测试失败。
6. 既有业务测试必须回归通过：
   - `tests/services/indicators/business.test.ts`
   - `tests/main/processMonitor/indicatorPipeline.business.test.ts`
   - `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
   - `tests/services/marketMonitor/business.test.ts`

### 阶段 F：验收与收尾

1. 执行 `bun run lint`
2. 执行 `bun run type-check`
3. 执行 `bun test`
4. 执行 `rg -n "technicalindicators" -S src tests package.json bun.lock` 必须无残留。
5. 执行 `rg -n "from 'technicalindicators'|technicalindicators\." -S src tests` 必须无残留。
6. 输出迁移报告：文件清单、测试结果、对比摘要。
7. 清理一次性基线工具：移除 `test:generate-indicator-baseline` 脚本与对应工具文件，避免依赖删除后留下不可执行脚本。

## 6. 等价性验证矩阵（必须全部通过）

| 维度 | 校验对象 | 校验方式 | 通过标准 |
|------|----------|----------|----------|
| 指标单值 | EMA/RSI/MFI | 与 baseline 对比（数值规则见 6.1） | 完全一致 |
| 指标结构 | MACD/KDJ | 字段逐项对比（数值规则见 6.1） | 完全一致 |
| 快照 | IndicatorSnapshot | 深比较（数值规则见 6.1） | 完全一致 |
| 策略行为 | buy/sell/delayed 分流 | 事件序列对比 | 完全一致 |
| 边界行为 | 无效输入、短序列 | 返回 null 与 guard 一致 | 完全一致 |

### 6.1 数值比较规则（强制）

1. `null` / `undefined` / 对象键集合 / 数组长度：必须全等。
2. 对所有数值字段统一使用绝对误差门限：`abs(a - b) <= 1e-10`。
3. 涨跌幅、MACD、KDJ、RSI、EMA、MFI 全部适用同一门限，不做指标特例放宽。
4. 只要任一字段超出门限即判定失败，不允许“人工解释通过”。
5. 测试报告必须输出首个失败样本的：指标名、周期、索引、baseline 值、actual 值、diff。

### 6.2 阶段门禁（强制）

1. 阶段 C 完成后必须先通过 `engineParity`、`snapshotParity`、`kdjParity`、`signalParity`，才允许进入阶段 D。
2. 阶段 D 删除依赖后，必须再次通过全量测试，确认不存在“删依赖引发的隐式行为变化”。
3. 任一门禁失败均回退到实现修复，不允许跳过测试继续后续阶段。

## 7. 风险与对应控制

| 风险 | 影响 | 控制措施 |
|------|------|---------|
| EMA 初始化差异导致信号漂移 | 高 | 基线驱动的输出对齐 + 策略级回归 |
| KDJ 平滑逻辑偏差 | 高 | 单独 KDJ parity 测试，覆盖多行情形态 |
| MFI 窗口偏移 | 中 | 对齐起始索引并做序列级断言 |
| 迁移后误删业务逻辑 | 高 | 保持对外函数签名与调用链不变 |
| 许可证遗漏 | 中 | 引入 LICENSE/NOTICE 并在复制文件头标注来源 |
| 同步接口被异步化 | 高 | 强制 adapter 输出同步函数，禁止改上层为 await |
| 基线不可复现 | 高 | 固定 seed、固定脚本、固定 schema，并纳入仓库 |
| 删除依赖时机过早 | 高 | 先过 parity 门禁，再删除依赖并重跑全量测试 |
| 残留失效脚本 | 中 | 在收尾阶段删除一次性基线脚本，避免留下不可执行命令 |

## 8. 并行协作拆分（可多子代理同时执行）

1. 子任务 1：上游源码落地与许可证文件整理。
2. 子任务 2：指标 adapter 与生产代码替换。
3. 子任务 3：baseline 生成脚本与 fixtures 建设。
4. 子任务 4：parity 测试、策略链路回归、CI 通过。
5. 子任务 5：依赖清理与文档更新。

## 9. 完成定义（Definition of Done）

1. `technicalindicators` 在生产代码、依赖、锁文件中彻底移除。
2. 指标计算完全由仓库内置的 ixjb 源码实现。
3. 指标与策略链路回归测试全部通过。
4. lint/type-check/test 全通过。
5. 迁移文档与许可信息完整。
6. 新增 parity 测试与 fixture 具备稳定重跑能力（同 seed 同输出）。
7. ixjb 源码能力按“原文件结构整合”方式落地，文档与实现一致。

## 10. 执行顺序建议（严格顺序）

1. 先做阶段 A（冻结基线），再做任何实现替换。
2. 完成阶段 B/C 后，先跑 parity 测试，再进入阶段 D 删除依赖。
3. 删除依赖后只允许修复迁移问题，不允许引入双轨回退。
4. 阶段 E 全通过后，才允许更新 benchmark/说明文档中的依赖描述。

## 11. 备注

1. 本方案遵循“系统性完整重构”原则，不设计临时开关、不保留旧引擎双写路径。
2. 若在阶段 C 发现任意指标无法达到基线一致，必须先定位并修正本地 ixjb 适配实现，再继续后续步骤。
3. 若某上游拷贝文件未被实际调用，必须在同一提交中删除，禁止保留“可能未来用到”的死代码。
