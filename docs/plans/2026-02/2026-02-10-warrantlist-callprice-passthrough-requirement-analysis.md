# warrantList callPrice 透传方案与「无兜底」要求符合性分析

## 用户要求归纳

1. **寻标筛选**：在寻标筛选过程中直接包含「回收价有效」条件，回收价无效的标的不会被寻标选中，因此无需在后续逻辑中再考虑回收价无效的情况。
2. **换标过程**：换标过程不再使用 warrantQuote API，不得在换标/刷新链路上回退到 `refreshWarrantInfoForSymbol`（warrantQuote）调用。

---

## 结论：当前方案**不符合**上述要求

- **寻标阶段**：未在筛选中加入「回收价有效」条件，仍可能选出 callPrice 无效的标的。
- **换标/刷新阶段**：显式保留了 warrantQuote 兜底，与「换标过程不再使用 warrantQuote」冲突。

下面分点说明并给出修改建议。

---

## 一、寻标阶段：筛选时直接包含「回收价有效」条件

### 1.1 当前方案描述（文档第 8 点）

- `selectBestWarrant`：在选出最优标的时，从当前 `warrant` 取 `callPrice`（`decimalToNumber(warrant.callPrice)`，**无则 `null`**），写入返回的 `WarrantCandidate.callPrice`。
- 没有把「回收价有效」作为筛选条件，callPrice 无效的 warrant 仍可参与比较并被选为 best。

### 1.2 建议修改

在 **selectBestWarrant** 的循环内，将**回收价有效**作为与 toCallPrice、turnover 等并列的筛选条件：

- 对每个 `warrant` 先计算 `callPriceNum = decimalToNumber(warrant.callPrice)`。
- 若 `callPriceNum == null || !Number.isFinite(callPriceNum) || callPriceNum <= 0`，则 **continue**，该条不参与「最优」比较。
- 只有通过该条件的 warrant 才会进入后续的距离、成交额等比较；当选出 best 时，其 callPrice 必然有效，直接写入 `WarrantCandidate.callPrice` 即可。

这样**无需在返回阶段再判断「回收价无效则 return null」**：无效的已在筛选中排除，被选中的标的一定带有效 callPrice。

---

## 二、换标/刷新阶段：「换标过程不再使用 warrantQuote」

### 2.1 当前方案描述（文档第 14 点、关键设计决策 2）

- **seatRefresh**：
  - 若 `data.callPrice != null && Number.isFinite(data.callPrice) && data.callPrice > 0`，则调用  
    `setWarrantInfoFromCallPrice(...)`，然后**跳过** `refreshWarrantInfoForSymbol`。
  - **否则（无 callPrice 或无效）：保持原有 `refreshWarrantInfoForSymbol` 调用（兜底）**。
- 关键设计决策第 2 条：**保留 warrantQuote 兜底路径**，确保静态模式和恢复场景不受影响。

即：换标流程中的席位刷新，在「无/无效 callPrice」时仍会调用 warrantQuote（`refreshWarrantInfoForSymbol`），与用户要求「换标过程不会再使用 warrantQuote API」**直接冲突**。

### 2.2 为何会出现「无 callPrice」的 SEAT_REFRESH

在寻标筛选中已包含「回收价有效」条件后，**正常**的自动寻标/换标链路上：

- 寻标：只有带有效 callPrice 的候选才会被选出 → `SeatState.callPrice` 有值。
- 换标：`findSwitchCandidate` 返回的 best 也带有效 callPrice → `nextCallPrice` → COMPLETE 时写入 `SeatState.callPrice`。
- seatSync 从 `SeatState` 取 `callPrice` 写入 task data → `data.callPrice` 应有值。

因此，换标流程中的 SEAT_REFRESH 理论上不应出现「无/无效 callPrice」。若出现，应视为异常（例如状态不一致），走**错误处理**而非再调 warrantQuote API。

### 2.3 建议修改（满足「不再使用 warrantQuote」）

- **seatRefresh**：
  - 若 `data.callPrice != null && Number.isFinite(data.callPrice) && data.callPrice > 0`：  
    调用 `setWarrantInfoFromCallPrice(...)`，按现有逻辑处理返回 status，**不再调用** `refreshWarrantInfoForSymbol`。
  - **否则（无 callPrice 或无效）**：  
    **不调用** `refreshWarrantInfoForSymbol`；  
    视为换标/刷新失败，与当前「获取牛熊证信息失败」一致：  
    `markSeatAsEmpty(..., '... 未提供有效回收价(callPrice)，无法刷新牛熊证信息', context)`，然后 return。

这样换标过程（含 seatSync → SEAT_REFRESH → seatRefresh）**完全不再使用 warrantQuote API**，与用户要求一致。

---

## 三、启动路径与「兜底」范围

用户要求重点在「换标过程」不再使用 warrantQuote。启动路径有两类：

1. **启动时通过 warrantList 寻标**（如 `searchSeatSymbol` 中 `findBestWarrant`）
   - 寻标筛选已含「回收价有效」条件，寻标成功则必有有效 callPrice，`refreshSeatWarrantInfo(symbol, isLong, callPrice)` 可只走 `setWarrantInfoFromCallPrice`，无需 warrantQuote。
2. **启动时恢复席位 / 静态配置**（无 warrantList，SeatState 无 callPrice）
   - 当前方案：`refreshSeatWarrantInfo(..., null)` 时保留 `refreshWarrantInfoForSymbol` 兜底。

若用户希望「**任何**场景都不再使用 warrantQuote」，则启动恢复/静态也应去掉兜底：  
无 callPrice 时仅打日志或视为该席位不刷新牛熊证信息（或同样视为失败，取决于产品预期）。  
若用户仅要求「**换标过程**」不用 warrantQuote，则启动恢复/静态可单独保留 warrantQuote 兜底（与当前方案一致），需产品确认。

---

## 四、修改点汇总（使方案符合用户要求）

| 位置                                       | 当前方案                                                       | 建议修改                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **selectBestWarrant**（utils.ts）          | 从 best warrant 取 callPrice，无则 null                        | 在筛选循环中增加「回收价有效」条件：callPrice 无效的 warrant 直接 continue，不参与最优比较；选中者必带有效 callPrice                    |
| **seatRefresh**（handlers/seatRefresh.ts） | 无/无效 callPrice 时调用 `refreshWarrantInfoForSymbol`（兜底） | 换标过程不再使用 warrantQuote：无/无效 callPrice 时不调用 `refreshWarrantInfoForSymbol`，改为 `markSeatAsEmpty`（未提供有效 callPrice） |
| **方案文档**                               | 关键设计决策 2：「保留 warrantQuote 兜底路径」                 | 改为：换标/刷新链路不再使用 warrantQuote API；启动恢复/静态是否保留兜底单独说明                                                         |

按上表修改后，方案可同时满足：

- 寻标筛选直接包含「回收价有效」条件，无效标的不会被选中，无需在后续再考虑回收价无效；
- 换标过程不再使用 warrantQuote API。
