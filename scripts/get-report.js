import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 读取配置
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
  process.exit(1);
}

const { SONAR_HOST_URL, SONAR_TOKEN, SONAR_PROJECT_KEY } = config;

// API 请求函数
async function apiRequest(path) {
  const url = `${SONAR_HOST_URL}${path}`;
  const auth = Buffer.from(`${SONAR_TOKEN}:`).toString('base64');

  const response = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// 获取所有数据
async function getAllData() {
  const metrics = 'bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,security_rating,reliability_rating,sqale_rating';

  const [measuresData, issuesData, qualityGateData] = await Promise.all([
    apiRequest(`/api/measures/component?component=${SONAR_PROJECT_KEY}&metricKeys=${metrics}`),
    apiRequest(`/api/issues/search?componentKeys=${SONAR_PROJECT_KEY}&ps=500`),
    apiRequest(`/api/qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}`)
  ]);

  return {
    measures: measuresData.component.measures,
    issues: issuesData.issues,
    qualityGate: qualityGateData.projectStatus.status
  };
}

// 格式化输出 - 简洁版本，适合 AI 阅读
function formatReport(data) {
  const { measures, issues, qualityGate } = data;

  // 转换指标为对象
  const m = {};
  measures.forEach(measure => m[measure.metric] = measure.value);

  // 统计问题
  const stats = {
    bySeverity: { CRITICAL: 0, MAJOR: 0, MINOR: 0, INFO: 0 },
    byType: {}
  };

  issues.forEach(issue => {
    stats.bySeverity[issue.severity] = (stats.bySeverity[issue.severity] || 0) + 1;
    stats.byType[issue.type] = (stats.byType[issue.type] || 0) + 1;
  });

  // 按文件分组
  const byFile = {};
  issues.forEach(issue => {
    const file = issue.component.replace(`${SONAR_PROJECT_KEY}:`, '');
    if (!byFile[file]) byFile[file] = [];
    byFile[file].push(issue);
  });

  // 输出报告
  console.log('\n=== SonarQube 代码质量报告 ===\n');
  console.log(`状态: ${qualityGate === 'OK' ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`时间: ${new Date().toLocaleString('zh-CN')}\n`);

  // 指标
  console.log('## 指标');
  console.log(`- Bugs: ${m.bugs || 0}`);
  console.log(`- Vulnerabilities: ${m.vulnerabilities || 0}`);
  console.log(`- Code Smells: ${m.code_smells || 0}`);
  console.log(`- Coverage: ${m.coverage || 0}%`);
  console.log(`- Duplicated Lines: ${m.duplicated_lines_density || 0}%`);
  console.log(`- Lines of Code: ${m.ncloc || 0}`);
  console.log(`- Security Rating: ${m.security_rating || 'N/A'}/5`);
  console.log(`- Reliability Rating: ${m.reliability_rating || 'N/A'}/5`);
  console.log(`- Maintainability Rating: ${m.sqale_rating || 'N/A'}/5\n`);

  // 问题统计
  console.log('## 问题统计');
  console.log(`总计: ${issues.length} 个问题\n`);

  console.log('按严重级别:');
  Object.entries(stats.bySeverity).forEach(([severity, count]) => {
    if (count > 0) console.log(`  - ${severity}: ${count}`);
  });

  console.log('\n按类型:');
  Object.entries(stats.byType).forEach(([type, count]) => {
    console.log(`  - ${type}: ${count}`);
  });

  // 详细问题列表
  if (issues.length > 0) {
    console.log('\n## 问题详情\n');

    // 按严重级别排序
    const severityOrder = { 'CRITICAL': 1, 'MAJOR': 2, 'MINOR': 3, 'INFO': 4 };
    const sortedFiles = Object.keys(byFile).sort((a, b) => {
      const maxSevA = Math.min(...byFile[a].map(i => severityOrder[i.severity] || 99));
      const maxSevB = Math.min(...byFile[b].map(i => severityOrder[i.severity] || 99));
      return maxSevA - maxSevB;
    });

    sortedFiles.forEach(file => {
      const fileIssues = byFile[file].sort((a, b) =>
        (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99)
      );

      console.log(`### ${file} (${fileIssues.length} 个问题)\n`);

      fileIssues.forEach(issue => {
        const line = issue.line || 'N/A';
        const range = issue.textRange
          ? `${issue.textRange.startLine}-${issue.textRange.endLine}:${issue.textRange.startOffset}-${issue.textRange.endOffset}`
          : 'N/A';

        console.log(`[${issue.severity}] ${issue.type}`);
        console.log(`  消息: ${issue.message}`);
        console.log(`  位置: 行 ${line}, 范围 ${range}`);
        console.log(`  规则: ${issue.rule}`);
        console.log('');
      });
    });
  }

  // 链接
  console.log('## 链接');
  console.log(`- Dashboard: ${SONAR_HOST_URL}/dashboard?id=${SONAR_PROJECT_KEY}`);
  console.log(`- Issues: ${SONAR_HOST_URL}/project/issues?id=${SONAR_PROJECT_KEY}\n`);
}

// 主函数
async function main() {
  try {
    console.log('正在获取 SonarQube 报告...');
    const data = await getAllData();
    formatReport(data);
  } catch (error) {
    console.error('\n❌ 错误:', error.message);
    console.error('\n请检查:');
    console.error('  1. SonarQube 服务是否运行 (http://localhost:9000)');
    console.error('  2. .env.sonar 配置是否正确');
    console.error('  3. 项目是否已扫描\n');
    process.exit(1);
  }
}

main();
