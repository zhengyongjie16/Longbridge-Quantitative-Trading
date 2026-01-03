import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 读取 .env 文件
const envPath = join(projectRoot, '.env');
let sonarToken = '';
let sonarOrganization = '';

try {
  const envContent = readFileSync(envPath, 'utf-8');
  const tokenMatch = envContent.match(/^SONAR_TOKEN=(.+)$/m);
  const orgMatch = envContent.match(/^SONAR_ORGANIZATION=(.+)$/m);
  
  if (tokenMatch) {
    sonarToken = tokenMatch[1].trim();
  }
  if (orgMatch) {
    sonarOrganization = orgMatch[1].trim();
  }
} catch (error) {
  console.error('无法读取 .env 文件:', error.message);
  process.exit(1);
}

if (!sonarToken) {
  console.error('在 .env 文件中未找到 SONAR_TOKEN');
  process.exit(1);
}

if (!sonarOrganization) {
  console.error('在 .env 文件中未找到 SONAR_ORGANIZATION');
  process.exit(1);
}

// 运行 sonar-scanner，通过 -D 参数传递 token 和 organization
try {
  console.log('正在运行 SonarQube Scanner...');
  execSync(`npx sonar-scanner -Dsonar.token=${sonarToken} -Dsonar.organization=${sonarOrganization}`, {
    stdio: 'inherit',
    cwd: projectRoot
  });
} catch (error) {
  console.error('SonarQube Scanner 执行失败', error);
  process.exit(1);
}

