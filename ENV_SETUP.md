# 环境变量配置说明

## ⚠️ 重要提示

**所有配置项都是必需的，没有默认值！**

程序启动时会自动验证所有配置项。如果任何必需的配置项缺失或无效，程序将**不会启动**，并会显示详细的错误信息。

## 快速开始

1. **复制环境变量模板文件**
   ```bash
   # Windows PowerShell
   Copy-Item .env.example .env
   
   # Linux/Mac
   cp .env.example .env
   ```

2. **编辑 `.env` 文件**，填入您的实际配置值
   - ⚠️ **必须**填写所有配置项，不能留空或使用默认占位符
   - ⚠️ 数值配置必须是有效的正数（MAX_DAILY_LOSS 可以为 0）

3. **启动程序验证配置**
   ```bash
   npm start
   ```
   如果配置不正确，程序会显示详细的错误信息并退出。

4. **重要**：`.env` 文件已添加到 `.gitignore`，不会被提交到版本控制系统

## 配置项说明

### LongPort OpenAPI 配置（必需）

这些配置从 LongPort 开放平台获取：https://open.longbridge.com

```env
LONGPORT_APP_KEY=your_app_key_here          # 应用 Key
LONGPORT_APP_SECRET=your_app_secret_here     # 应用 Secret
LONGPORT_ACCESS_TOKEN=your_access_token_here # 访问令牌
```

**获取方式**：
1. 访问 https://open.longbridge.com
2. 注册/登录账号
3. 创建应用并获取 App Key 和 App Secret
4. 生成 Access Token

### 交易标的配置

```env
# 监控标的（用于计算指标和生成交易信号）
MONITOR_SYMBOL=HSI.HK        # 必需：例如 HSI.HK（恒生指数）

# 做多标的（当监控标的产生 BUY 信号时买入）
LONG_SYMBOL=68547            # 必需：例如 68547（恒指牛证）

# 做空标的（当监控标的产生 SELL 信号时买入）
SHORT_SYMBOL=63372           # 必需：例如 63372（恒指熊证）
```

**说明**：
- 标的代码可以不带 `.HK` 后缀，程序会自动添加
- 请根据您的实际交易需求修改标的代码

### 交易金额和仓位配置

```env
# 目标买入金额（HKD）
TARGET_NOTIONAL=5000         # 必需：例如 5000 HKD（必须为正数）

# 做多标的的最小买卖单位（每手股数）
LONG_LOT_SIZE=100           # 必需：例如 100（必须为正数）

# 做空标的的最小买卖单位（每手股数）
SHORT_LOT_SIZE=100          # 必需：例如 100（必须为正数）
```

**说明**：
- `TARGET_NOTIONAL`：每次买入的目标金额，程序会按此金额计算股数
- `LONG_LOT_SIZE` 和 `SHORT_LOT_SIZE`：作为后备值，优先使用从 API 获取的实际值

### 风险管理配置

```env
# 单标的最大持仓市值（HKD）
MAX_POSITION_NOTIONAL=100000  # 必需：例如 100000 HKD（必须为正数）

# 单日最大亏损（HKD），超过后禁止继续开新仓
MAX_DAILY_LOSS=30000         # 必需：例如 30000 HKD（必须为非负数，可以为 0）

# 是否在收盘前5分钟清空所有持仓
CLEAR_POSITIONS_BEFORE_CLOSE=true  # 可选：默认值为 true（收盘前5分钟：15:55-16:00），设置为 "false" 禁用
```

**说明**：
- `MAX_POSITION_NOTIONAL`：单个标的的最大持仓市值限制
- `MAX_DAILY_LOSS`：当日浮亏超过此值时，禁止继续开新仓
- `CLEAR_POSITIONS_BEFORE_CLOSE`：默认值为 `true`（在 .env 文件中设置），收盘前5分钟（15:55-16:00）自动清空所有持仓；设置为 `"false"` 可禁用此功能

### 调试配置

```env
# 是否启用 DEBUG 日志
DEBUG=false  # 设置为 "true" 启用详细日志
```

## 配置验证

程序启动时会**自动验证所有配置项**：

### 验证规则

1. **LongPort API 配置**（必需）
   - `LONGPORT_APP_KEY`、`LONGPORT_APP_SECRET`、`LONGPORT_ACCESS_TOKEN` 必须配置
   - 不能使用默认占位符（如 `your_app_key_here`）
   - 配置对象必须能够成功创建

2. **交易标的配置**（必需）
   - `MONITOR_SYMBOL`、`LONG_SYMBOL`、`SHORT_SYMBOL` 必须配置
   - 不能为空字符串

3. **数值配置**（必需）
   - `TARGET_NOTIONAL`、`LONG_LOT_SIZE`、`SHORT_LOT_SIZE`、`MAX_POSITION_NOTIONAL` 必须为正数
   - `MAX_DAILY_LOSS` 必须为非负数（可以为 0）

4. **布尔配置**（可选）
   - `CLEAR_POSITIONS_BEFORE_CLOSE` 默认值为 `true`（在 .env 文件中设置）
   - `DEBUG` 如果不设置，默认为 `false`

### 验证失败处理

如果配置验证失败：
- 程序会显示详细的错误信息，列出所有问题
- 程序会**立即退出**，不会启动监控
- 请根据错误信息修复 `.env` 文件后重新启动

### 验证成功

如果配置验证通过：
- 程序会显示配置摘要
- 然后正常启动监控程序

## 安全提示

⚠️ **重要安全提示**：
1. **永远不要**将 `.env` 文件提交到版本控制系统
2. `.env` 文件已添加到 `.gitignore`，确保不会被意外提交
3. 如果需要在团队中共享配置，请使用 `.env.example` 作为模板
4. 生产环境建议使用环境变量或密钥管理服务，而不是 `.env` 文件

## 示例配置

### 开发环境配置示例

```env
LONGPORT_APP_KEY=your_dev_app_key
LONGPORT_APP_SECRET=your_dev_app_secret
LONGPORT_ACCESS_TOKEN=your_dev_access_token
MONITOR_SYMBOL=HSI.HK
LONG_SYMBOL=68547
SHORT_SYMBOL=63372
TARGET_NOTIONAL=1000
MAX_POSITION_NOTIONAL=10000
MAX_DAILY_LOSS=5000
DEBUG=true
CLEAR_POSITIONS_BEFORE_CLOSE=false
```

### 生产环境配置示例

```env
LONGPORT_APP_KEY=your_prod_app_key
LONGPORT_APP_SECRET=your_prod_app_secret
LONGPORT_ACCESS_TOKEN=your_prod_access_token
MONITOR_SYMBOL=HSI.HK
LONG_SYMBOL=68547
SHORT_SYMBOL=63372
TARGET_NOTIONAL=5000
MAX_POSITION_NOTIONAL=100000
MAX_DAILY_LOSS=30000
DEBUG=false
CLEAR_POSITIONS_BEFORE_CLOSE=true
```

## 故障排查

### 问题：程序无法连接到 LongPort API

**可能原因**：
1. `LONGPORT_APP_KEY`、`LONGPORT_APP_SECRET` 或 `LONGPORT_ACCESS_TOKEN` 配置错误
2. Access Token 已过期（需要重新生成）
3. 网络连接问题

**解决方法**：
1. 检查 `.env` 文件中的配置是否正确
2. 访问 https://open.longbridge.com 重新生成 Access Token
3. 检查网络连接和防火墙设置

### 问题：配置值无效警告

**可能原因**：
- 数值配置项包含了非数字字符或无效值

**解决方法**：
- 检查 `.env` 文件中的数值配置，确保都是有效的数字
- 程序会自动使用默认值，但建议修复配置

## 相关文档

- LongPort OpenAPI 文档：https://open.longbridge.com/zh-CN/docs/getting-started
- 项目 README：查看项目根目录的 README 文件

