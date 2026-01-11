# Git Filter for Environment Files

这个功能允许 Git 跟踪环境配置文件，但在提交时自动将敏感属性的值替换为占位符。

## 支持的文件

### .env.sonar

在提交时自动将敏感属性（`SONAR_TOKEN` 和 `SONAR_SCANNER_PATH`）的值替换为占位符。

### .env.local

在提交时自动将以下敏感属性的值替换为占位符：
- `LONGPORT_APP_KEY`
- `LONGPORT_APP_SECRET`
- `LONGPORT_ACCESS_TOKEN`
- 所有标的属性：`MONITOR_SYMBOL_*`、`LONG_SYMBOL_*`、`SHORT_SYMBOL_*`（* 为任意数字）

## 工作原理

使用 Git 的 clean/smudge 过滤器：
- **clean filter**: 在 `git add` 时将文件加入暂存区时自动运行，将敏感属性的值替换为占位符（键名本身）
  - **重要**：clean filter **不会修改工作区的文件**，只处理暂存区的内容
  - 工作区的文件保持原始内容，可以随时编辑
- **smudge filter**: 在 `git checkout` 时将文件从 Git 检出到工作区时运行（保留本地文件中的值）

### 工作流程说明

1. **工作区文件**：你可以自由编辑，包含真实的敏感值
2. **执行 `git add`**：clean filter 自动运行，将敏感值替换为占位符，存储在暂存区
3. **工作区文件**：**仍然保持原始内容**（包含真实敏感值），可以继续编辑
4. **执行 `git commit`**：提交的是暂存区的内容（占位符版本）

**关键点**：Git filter **不会锁定或阻止文件修改**，工作区的文件可以随时编辑。修改后需要再次 `git add` 来更新暂存区。

## 设置步骤

### Windows (PowerShell)

```powershell
.\scripts\setup-git-filter.ps1
```

### Linux/macOS/Git Bash

```bash
bash scripts/setup-git-filter.sh
```

### 手动配置

如果需要手动配置，运行以下命令（Windows 请使用 PowerShell 或 Git Bash，根据你的项目路径调整）：

```bash
# 获取项目根目录的绝对路径（根据你的实际情况调整）
# 配置 .env.sonar 的 filter
git config filter.clean-env-sonar.clean "node \"D:/code/Longbridge_Quantitative_Trading/scripts/git-filter-clean-env.js\""
git config filter.clean-env-sonar.smudge "node \"D:/code/Longbridge_Quantitative_Trading/scripts/git-filter-smudge-env.js\""

# 配置 .env.local 的 filter
git config filter.clean-env-local.clean "node \"D:/code/Longbridge_Quantitative_Trading/scripts/git-filter-clean-env-local.js\""
git config filter.clean-env-local.smudge "node \"D:/code/Longbridge_Quantitative_Trading/scripts/git-filter-smudge-env-local.js\""
```

## 验证配置

运行以下命令验证配置是否正确：

```bash
# 验证 .env.sonar 的配置
git config --get filter.clean-env-sonar.clean
git config --get filter.clean-env-sonar.smudge

# 验证 .env.local 的配置
git config --get filter.clean-env-local.clean
git config --get filter.clean-env-local.smudge
```

应该看到脚本的完整路径。

## 使用方法

1. **首次使用**：
   - 如果环境文件之前被忽略，需要先添加：
     ```bash
     git add -f .env.sonar
     git add -f .env.local
     ```
   - 如果文件已存在但不在 Git 中，先运行设置脚本，然后添加文件

2. **正常使用**：
   - 编辑环境文件，设置你的本地值（工作区的文件可以随时编辑，不会被锁定）
   - 执行 `git add` 时，敏感属性的值会被自动替换为占位符存储在暂存区（工作区文件不受影响）
   - 修改文件后，需要再次 `git add` 来更新暂存区
   - 其他属性会正常提交

3. **查看效果**：
   ```bash
   # 查看暂存区的文件（应该看到敏感属性值为占位符）
   git show :.env.sonar
   git show :.env.local
   ```

## 示例

### .env.sonar 示例

**本地文件**:
```
SONAR_TOKEN=my_secret_token_12345
SONAR_HOST_URL=http://localhost:9000
SONAR_PROJECT_KEY=longbridge-option-quant
SONAR_SCANNER_PATH=D:/sonar-scanner-5.0.1.3006
```

**Git 中存储的内容**:
```
SONAR_TOKEN=SONAR_TOKEN
SONAR_HOST_URL=http://localhost:9000
SONAR_PROJECT_KEY=longbridge-option-quant
SONAR_SCANNER_PATH=SONAR_SCANNER_PATH
```

### .env.local 示例

**本地文件**:
```
LONGPORT_APP_KEY=my_app_key_12345
LONGPORT_APP_SECRET=my_secret_67890
LONGPORT_ACCESS_TOKEN=my_token_abcdef
MONITOR_COUNT=2
MONITOR_SYMBOL_1=HSI.HK
LONG_SYMBOL_1=54806
SHORT_SYMBOL_1=63372
MONITOR_SYMBOL_2=HSI.HK
LONG_SYMBOL_2=54807
SHORT_SYMBOL_2=63373
```

**Git 中存储的内容**:
```
LONGPORT_APP_KEY=LONGPORT_APP_KEY
LONGPORT_APP_SECRET=LONGPORT_APP_SECRET
LONGPORT_ACCESS_TOKEN=LONGPORT_ACCESS_TOKEN
MONITOR_COUNT=2
MONITOR_SYMBOL_1=MONITOR_SYMBOL_1
LONG_SYMBOL_1=LONG_SYMBOL_1
SHORT_SYMBOL_1=SHORT_SYMBOL_1
MONITOR_SYMBOL_2=MONITOR_SYMBOL_2
LONG_SYMBOL_2=LONG_SYMBOL_2
SHORT_SYMBOL_2=SHORT_SYMBOL_2
```

## 注意事项

1. **首次克隆仓库后**：如果仓库中已有环境文件，检出时敏感属性会是占位符值（如 `SONAR_TOKEN=SONAR_TOKEN`、`LONGPORT_APP_KEY=LONGPORT_APP_KEY`），需要手动替换为真实值。

2. **团队成员协作**：
   - 每个团队成员需要运行一次设置脚本（或手动配置）
   - 每个团队成员需要在自己的环境文件中填写自己的敏感值

3. **配置位置**：Git filter 配置存储在本地 Git 配置中（`.git/config` 或 `~/.gitconfig`），不会提交到仓库。

4. **路径问题**：如果移动了项目位置，可能需要重新运行设置脚本。

## 常见问题

### 文件是否可以修改？

**可以！** Git filter **不会阻止文件修改**。

- **工作区的文件可以随时编辑**，不会被锁定
- clean filter 只在 `git add` 时运行，**只处理暂存区的内容**
- **工作区的文件保持原始内容**（包含真实敏感值），不受 filter 影响
- 修改文件后，需要再次 `git add` 来更新暂存区

**工作流程示例**：
1. 编辑 `.env.local` 文件（工作区包含真实值）✅
2. 执行 `git add .env.local`（暂存区存储占位符版本）✅
3. 继续编辑 `.env.local` 文件（工作区仍然可以编辑）✅
4. 再次执行 `git add .env.local` 更新暂存区 ✅

如果你遇到文件无法修改的情况，可能是：
1. 文件权限问题：检查文件是否为只读属性
2. 编辑器问题：某些编辑器可能会锁定文件
3. 其他进程占用：确保没有其他程序正在使用该文件

## 故障排除

### Filter 不工作

1. 检查 filter 是否配置：
   ```bash
   git config --list | grep clean-env
   ```

2. 检查脚本路径是否正确（特别是 Windows 上的路径分隔符）

3. 检查 Node.js 是否在 PATH 中：
   ```bash
   node --version
   ```

### 撤销配置

如果需要移除 filter 配置：

```bash
# 移除 .env.sonar 的配置
git config --unset filter.clean-env-sonar.clean
git config --unset filter.clean-env-sonar.smudge

# 移除 .env.local 的配置
git config --unset filter.clean-env-local.clean
git config --unset filter.clean-env-local.smudge
```

### 重新应用 Filter

如果修改了环境文件但 filter 没有生效，可以手动触发：

```bash
# 对于 .env.sonar
git checkout HEAD -- .env.sonar  # 重置文件
git add .env.sonar                # 重新添加（会触发 clean filter）

# 对于 .env.local
git checkout HEAD -- .env.local  # 重置文件
git add .env.local                # 重新添加（会触发 clean filter）
```
