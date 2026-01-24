import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { assertSafePathEnv } from './pathEnvSafety.js';

const dangerousShellChars = /[;&|`$(){}[\]<>!#*?'"\r\n^%]/;

/**
 * 验证 URL 格式，防止命令注入
 * @param {string} url
 * @returns {boolean}
 */
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    if (parsed.search || parsed.hash) {
      return false;
    }
    return !dangerousShellChars.test(url);
  } catch {
    return false;
  }
}

/**
 * 验证文件路径格式，防止命令注入
 * 注意：不检查路径是否存在，由后续代码检查具体文件
 * @param {string} filePath
 * @returns {boolean}
 */
function isValidPath(filePath) {
  // 禁止包含 shell 特殊字符（允许 Windows 路径分隔符 \ 和正斜杠 /）
  return !dangerousShellChars.test(filePath);
}

/**
 * 验证项目 key 格式
 * @param {string} key
 * @returns {boolean}
 */
function isValidProjectKey(key) {
  // 只允许字母、数字、下划线、连字符、冒号、点
  return /^[\w\-.:]+$/.test(key);
}

/**
 * 验证 token 格式
 * @param {string} token
 * @returns {boolean}
 */
function isValidToken(token) {
  // Token 通常是字母数字字符
  return /^[\w\-]+$/.test(token);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 读取 .env.sonar 文件
const envPath = join(projectRoot, '.env.sonar');
const config = {};

try {
  const envContent = readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        config[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
} catch (error) {
  console.error('❌ 无法读取 .env.sonar 文件:', error.message);
  console.log('\n请确保 .env.sonar 文件存在并包含必要配置：');
  console.log('  SONAR_TOKEN=your_token');
  console.log('  SONAR_HOST_URL=http://localhost:9000');
  console.log('  SONAR_PROJECT_KEY=longbridge-option-quant');
  console.log('  SONAR_SCANNER_PATH=D:/sonar-scanner-5.0.1.3006');
  process.exit(1);
}

// 验证必需的配置
const required = ['SONAR_TOKEN', 'SONAR_HOST_URL', 'SONAR_PROJECT_KEY', 'SONAR_SCANNER_PATH'];
const missingKey = required.find(key => !config[key]);
if (missingKey) {
  console.error(`❌ 配置文件中缺少 ${missingKey}`);
  process.exit(1);
}

// 验证配置值的安全性，防止命令注入
if (!isValidUrl(config.SONAR_HOST_URL)) {
  console.error('❌ SONAR_HOST_URL 格式无效，必须是安全的 http/https URL（不含查询参数和 shell 特殊字符）');
  process.exit(1);
}

if (!isValidPath(config.SONAR_SCANNER_PATH)) {
  console.error('❌ SONAR_SCANNER_PATH 路径格式无效，包含不安全字符');
  process.exit(1);
}

if (!isValidProjectKey(config.SONAR_PROJECT_KEY)) {
  console.error('❌ SONAR_PROJECT_KEY 格式无效，只允许字母、数字、下划线、连字符、冒号、点');
  process.exit(1);
}

if (!isValidToken(config.SONAR_TOKEN)) {
  console.error('❌ SONAR_TOKEN 格式无效');
  process.exit(1);
}

// 检查 SonarQube 服务状态（使用 fetch 替代 curl，更安全）
console.log('🔍 检查 SonarQube 服务状态...');

async function checkSonarQubeStatus() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${config.SONAR_HOST_URL}/api/system/status`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.status === 'UP') {
      console.log('✅ SonarQube 服务运行正常');
      return true;
    }
    throw new Error('服务未就绪');
  } catch (error) {
    console.log('⚠️  SonarQube 未运行，正在尝试启动...', error.message);
    return false;
  }
}

async function startSonarQube() {
  const dockerComposePath = join(projectRoot, 'docker-compose.yml');
  try {
    if (!existsSync(dockerComposePath)) {
      throw new Error('docker-compose.yml 不存在');
    }
    try {
      assertSafePathEnv(process.env.PATH ?? '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ PATH 环境变量不安全，无法安全执行 docker-compose: ${message}`);
      process.exit(1);
    }
    console.log('📦 启动 Docker 容器...');
    // docker-compose 是固定命令，安全
    execSync('docker-compose up -d', {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    console.log('⏳ 等待 SonarQube 启动（大约 30 秒）...');
    // 使用 Node.js 原生方式等待，避免 shell 命令
    await new Promise(resolve => setTimeout(resolve, 30000));
  } catch (dockerError) {
    console.error('❌ 无法启动 SonarQube，请手动运行: docker-compose up -d', dockerError.message);
    process.exit(1);
  }
}

const isRunning = await checkSonarQubeStatus();
if (!isRunning) {
  await startSonarQube();
}

console.log('\n🚀 开始 SonarQube 扫描...');
console.log(`   项目: ${config.SONAR_PROJECT_KEY}`);
console.log(`   服务器: ${config.SONAR_HOST_URL}`);
// 构建扫描命令
const scannerCmd = join(
  config.SONAR_SCANNER_PATH,
  'bin',
  process.platform === 'win32' ? 'sonar-scanner.bat' : 'sonar-scanner'
);

// 验证 scanner 可执行文件存在
if (!existsSync(scannerCmd)) {
  console.error(`❌ SonarQube Scanner 不存在: ${scannerCmd}`);
  process.exit(1);
}

const scannerArgs = [
  `-Dsonar.login=${config.SONAR_TOKEN}`,
  `-Dsonar.host.url=${config.SONAR_HOST_URL}`,
  `-Dsonar.projectKey=${config.SONAR_PROJECT_KEY}`
];

// 运行 sonar-scanner
// 由于已验证所有配置值的安全性（不包含 shell 特殊字符），使用 execSync 是安全的
try {
  execSync(`"${scannerCmd}" ${scannerArgs.join(' ')}`, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true
  });

  console.log('\n✅ 扫描完成！');
  console.log(`\n📊 查看结果: ${config.SONAR_HOST_URL}/dashboard?id=${config.SONAR_PROJECT_KEY}`);
} catch (error) {
  console.error('\n❌ SonarQube Scanner 执行失败', error.message);
  console.error('请检查:');
  console.error('  1. Token 是否正确');
  console.error('  2. SonarQube 服务是否运行');
  console.error('  3. 网络连接是否正常');
  process.exit(1);
}

