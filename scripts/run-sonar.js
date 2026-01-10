import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
for (const key of required) {
  if (!config[key]) {
    console.error(`❌ 配置文件中缺少 ${key}`);
    process.exit(1);
  }
}

// 检查 SonarQube 服务状态
console.log('🔍 检查 SonarQube 服务状态...');
try {
  const curlResult = execSync(`curl -s ${config.SONAR_HOST_URL}/api/system/status`, {
    encoding: 'utf-8',
    timeout: 5000
  });

  if (curlResult.includes('"status":"UP"')) {
    console.log('✅ SonarQube 服务运行正常');
  } else {
    throw new Error('服务未就绪');
  }
} catch (error) {
  console.log('⚠️  SonarQube 未运行，正在尝试启动...', error);

  // 检查 docker-compose.yml 是否存在
  const dockerComposePath = join(projectRoot, 'docker-compose.yml');
  try {
    readFileSync(dockerComposePath, 'utf-8');
    console.log('📦 启动 Docker 容器...');
    execSync('docker-compose up -d', {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    console.log('⏳ 等待 SonarQube 启动（大约 30 秒）...');
    execSync('timeout 30 node -e "require(\'child_process\').execSync(\'sleep 3\')"');
  } catch (dockerError) {
    console.error('❌ 无法启动 SonarQube，请手动运行: docker-compose up -d', dockerError);
    process.exit(1);
  }
}

console.log('\n🚀 开始 SonarQube 扫描...');
console.log(`   项目: ${config.SONAR_PROJECT_KEY}`);
console.log(`   服务器: ${config.SONAR_HOST_URL}`);
console.log('');

// 构建扫描命令
const scannerPath = join(config.SONAR_SCANNER_PATH, 'bin', 'sonar-scanner.bat');
const scannerCmd = process.platform === 'win32' ? scannerPath : config.SONAR_SCANNER_PATH + '/bin/sonar-scanner';

const scannerArgs = [
  '-Dsonar.login=' + config.SONAR_TOKEN,
  '-Dsonar.host.url=' + config.SONAR_HOST_URL,
  '-Dsonar.projectKey=' + config.SONAR_PROJECT_KEY
];

// 运行 sonar-scanner
try {
  execSync(`"${scannerCmd}" ${scannerArgs.join(' ')}`, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true
  });

  console.log('\n✅ 扫描完成！');
  console.log(`\n📊 查看结果: ${config.SONAR_HOST_URL}/dashboard?id=${config.SONAR_PROJECT_KEY}`);
} catch (error) {
  console.error('\n❌ SonarQube Scanner 执行失败', error);
  console.error('请检查:');
  console.error('  1. Token 是否正确');
  console.error('  2. SonarQube 服务是否运行');
  console.error('  3. 网络连接是否正常');
  process.exit(1);
}

