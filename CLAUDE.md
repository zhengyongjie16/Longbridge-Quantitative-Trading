# CLAUDE.md

## 项目概述
**LongBridge 量化交易系统** - 港股双向轮证自动交易系统，基于受监控标的的技术指标。

- **技术栈**: Node.js, TypeScript, LongPort OpenAPI SDK
- **交易策略**: 技术指标(RSI/KDJ/MACD/MFI/EMA) → 延迟验证(60-90s) → 执行牛熊证交易
- **系统架构**: 1秒事件循环，工厂模式，对象池优化

## 配置说明
配置文件: `.env.local` (从 `.env.example` 复制)
关键配置: API凭证、监控标的(MONITOR_SYMBOL)、交易标的(LONG/SHORT_SYMBOL)、信号配置、风险限额

## 系统架构

### 执行流程 (`src/index.ts` 1秒循环)
检查交易时段 → 获取K线 → 计算指标 → 生成信号 → 记录指标历史 → 延迟验证 → 风险检查(6项固定顺序) → 处理卖出信号 → 执行订单 → 监控未成交/浮亏

### 模块结构
- `src/core/`: 策略、信号验证、信号处理、交易员、订单记录、风险、市场监控、末日保护、浮亏监控
- `src/services/`: 指标计算、行情客户端
- `src/utils/`: 对象池、信号配置解析、指标辅助、交易时间、日志、工具函数
- `src/config/`: API配置、交易配置、配置验证器

### 设计模式
1. **工厂模式**: 使用工厂函数，禁用类
2. **依赖注入**: 依赖作为参数传入，禁止内部创建
3. **对象池**: 复用 Signal/Position/KDJ/MACD 对象
4. **类型组织**: 模块级 `type.ts` + 共享 `src/types/index.ts`，优先使用 `readonly`

### 风险检查顺序 (固定顺序，不可调整)
1. 买入间隔限制(60s)
2. 买入价格验证(ask > 最新成交价则拒绝)
3. 末日保护(收盘前15分钟禁买)
4. 牛熊证风险检查(距行权价距离)
5. 每日亏损限额(MAX_DAILY_LOSS)
6. 持仓限额(MAX_POSITION_NOTIONAL)

### 订单过滤算法 (订单记录器)
**关键**: 必须按时间顺序处理(从旧到新)
算法: M0(最新卖出后的买单) + 历史高价未完全卖出的买单
实现智能平仓: 当前价>成本价则全卖，当前价≤成本价则只卖买价<当前价的订单

## skills模块
- `/business-logic`: 业务逻辑知识库(信号生成、买卖策略、风险检查等)
- `/longbridge-openapi-documentation`: LongPort API文档
- `/typescript-project-specifications`: TypeScript编码规范(写代码时必须使用)

## TypeScript 规范
- **严格模式**: 编写代码时必须严格遵循typescript-project-specifications skill

## 信号配置 DSL
格式: `(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M`
- `/N`: 组内需满足N个条件
- `|`: 组间或运算 (最多3组)
- 支持指标: `RSI:n`, `MFI`, `K`, `D`, `J`, `MACD`, `DIF`, `DEA`, `EMA:n`
- 操作符: `<`, `>`
示例: `(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)` → 组1满足3/4个条件 或 组2满足J<-20

## 延迟验证
买入信号: T0+90s, 卖出信号: T0+75s
验证机制: 记录T0指标值 → T0+5s/T0+10s/T0+delay再检查
- BUYCALL/SELLPUT: 需上升趋势(T0+5s/T0+10s > T0)
- BUYPUT/SELLCALL: 需下降趋势(T0+5s/T0+10s < T0)
配置: `VERIFICATION_INDICATORS_BUY/SELL` (默认: `D,DIF`)

## 末日保护
- 收盘前15分钟: 拒绝所有买单
- 收盘前5分钟: 强制市价平仓
- 支持半日市(12:00收盘)

## 核心概念
- **监控标的** vs **交易标的**: 监控标的(HSI.HK)生成信号，交易标的(LONG/SHORT_SYMBOL)执行订单
- **信号类型**: BUYCALL(买牛证), SELLCALL(卖牛证), BUYPUT(买熊证), SELLPUT(卖熊证)
- **成本价**: 平摊成本价(卖出决策) vs 开仓成本(浮亏计算R1/N1算法)
- **订单类型**: ELO(限价单) vs MO(市价单，紧急清仓用)

