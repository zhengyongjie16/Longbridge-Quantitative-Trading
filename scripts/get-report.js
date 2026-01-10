import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 读取配置
function loadConfig() {
  const envPath = join(projectRoot, '.env.sonar');
  const config = {};

  try {
    const content = readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
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

  return config;
}

const { SONAR_HOST_URL, SONAR_TOKEN, SONAR_PROJECT_KEY } = loadConfig();

// API 请求函数
async function apiRequest(path) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${SONAR_HOST_URL}${path}${separator}_=${Date.now()}`;
  const auth = Buffer.from(`${SONAR_TOKEN}:`).toString('base64');

  const response = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// 获取项目分析时间
async function getAnalysisTime() {
  try {
    const data = await apiRequest(`/api/measures/component?component=${SONAR_PROJECT_KEY}&metricKeys=analysis_date`);
    const value = data.component?.measures?.[0]?.value;
    if (value) {
      return new Date(Number.parseInt(value, 10) * 1000);
    }
  } catch {
    // 权限不足时静默失败
  }
  return null;
}

// 获取所有问题（处理分页）
async function getAllIssues() {
  const issues = [];
  const pageSize = 500;
  let page = 1;

  while (true) {
    const response = await apiRequest(
      `/api/issues/search?componentKeys=${SONAR_PROJECT_KEY}&ps=${pageSize}&p=${page}&statuses=OPEN`
    );
    
    const pageIssues = response.issues || [];
    issues.push(...pageIssues);
    
    if (pageIssues.length < pageSize || issues.length >= (response.total || 0)) {
      break;
    }
    page++;
  }

  return issues;
}

// 获取所有数据
async function fetchAllData() {
  const metrics = 'bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,security_rating,reliability_rating,sqale_rating';

  const [measuresData, qualityGateData] = await Promise.all([
    apiRequest(`/api/measures/component?component=${SONAR_PROJECT_KEY}&metricKeys=${metrics}`),
    apiRequest(`/api/qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}`)
  ]);

  const issues = await getAllIssues();

  // 转换指标为对象
  const metricsMap = {};
  measuresData.component.measures.forEach(measure => {
    metricsMap[measure.metric] = measure.value;
  });

  return {
    metrics: metricsMap,
    issues,
    qualityGate: qualityGateData.projectStatus.status
  };
}

// 统计问题
function calculateStats(issues) {
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

  return { stats, byFile };
}

// 格式化分析时间信息
function formatAnalysisTime(analysisTime) {
  if (!analysisTime) {
    console.log(`获取时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log(`💡 提示: 如需获取最新分析结果，请先运行: npm run sonarqube\n`);
    return;
  }

  const timeStr = analysisTime.toLocaleString('zh-CN');
  const diffMinutes = Math.floor((Date.now() - analysisTime.getTime()) / 60000);
  const diffHours = Math.floor(diffMinutes / 60);

  console.log(`分析时间: ${timeStr}`);
  if (diffMinutes < 1) {
    console.log(`✅ 数据是最新的（刚刚分析）\n`);
  } else if (diffMinutes < 60) {
    console.log(`✅ 数据较新（${diffMinutes} 分钟前）\n`);
  } else {
    console.log(`⚠️  数据较旧（${diffHours} 小时前）`);
    console.log(`💡 如需获取最新报告，请先运行: npm run sonarqube\n`);
  }
}

// 输出问题详情
function printIssueDetails(byFile) {
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

// 格式化输出报告
function formatReport(data, analysisTime) {
  const { metrics, issues, qualityGate } = data;
  const { stats, byFile } = calculateStats(issues);

  console.log('\n=== SonarQube 代码质量报告 ===\n');
  console.log(`状态: ${qualityGate === 'OK' ? '✅ PASS' : '❌ FAIL'}`);
  formatAnalysisTime(analysisTime);

  // 指标
  console.log('## 指标');
  console.log(`- Bugs: ${metrics.bugs || 0}`);
  console.log(`- Vulnerabilities: ${metrics.vulnerabilities || 0}`);
  console.log(`- Code Smells: ${metrics.code_smells || 0}`);
  console.log(`- Coverage: ${metrics.coverage || 0}%`);
  console.log(`- Duplicated Lines: ${metrics.duplicated_lines_density || 0}%`);
  console.log(`- Lines of Code: ${metrics.ncloc || 0}`);
  console.log(`- Security Rating: ${metrics.security_rating || 'N/A'}/5`);
  console.log(`- Reliability Rating: ${metrics.reliability_rating || 'N/A'}/5`);
  console.log(`- Maintainability Rating: ${metrics.sqale_rating || 'N/A'}/5\n`);

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
    printIssueDetails(byFile);
  }

  // 链接
  console.log('## 链接');
  console.log(`- Dashboard: ${SONAR_HOST_URL}/dashboard?id=${SONAR_PROJECT_KEY}`);
  console.log(`- Issues: ${SONAR_HOST_URL}/project/issues?id=${SONAR_PROJECT_KEY}\n`);
}

// 主程序
try {
  console.log('正在获取 SonarQube 报告...');
  
  const analysisTime = await getAnalysisTime();
  const data = await fetchAllData();
  formatReport(data, analysisTime);
} catch (error) {
  console.error('\n❌ 错误:', error.message);
  console.error('\n请检查:');
  console.error('  1. SonarQube 服务是否运行 (http://localhost:9000)');
  console.error('  2. .env.sonar 配置是否正确');
  console.error('  3. 项目是否已扫描');
  console.error('  4. 如果数据较旧，请运行: npm run sonarqube');
  console.error('  5. 扫描完成后请等待几秒钟再查看报告\n');
  process.exit(1);
}