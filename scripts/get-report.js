/**
 * 获取 SonarQube 代码质量报告（问题列表等）
 *
 * 功能：拉取项目指标（Bugs、Code Smells、覆盖率、重复行等）、质量门禁状态、
 * 以及所有 OPEN 状态的问题，按文件和严重级别汇总后输出到控制台。
 *
 * 使用方式: bun sonarqube:report
 * 注意: 请先配置 .env.sonar，再运行 bun sonarqube 完成扫描，然后执行本命令。
 */
import { loadConfig, apiRequest, paginatedRequest } from './common.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error('❌ 无法读取 .env.sonar 文件:', error.message);
  process.exit(1);
}

const { SONAR_HOST_URL, SONAR_PROJECT_KEY } = config;

/**
 * 获取最近一次分析的时间（用于提示数据新旧）
 * @returns {Promise<Date|null>} 分析时间，无权限或失败时返回 null
 */
async function getAnalysisTime() {
  try {
    const data = await apiRequest(
      `/api/measures/component?component=${SONAR_PROJECT_KEY}&metricKeys=analysis_date`,
      config,
    );
    const value = data.component?.measures?.[0]?.value;
    if (value) {
      return new Date(Number.parseInt(value, 10) * 1000);
    }
  } catch {
    // 权限不足时静默失败
  }
  return null;
}

/**
 * 分页拉取项目下所有 OPEN 状态的问题（issues）
 * @returns {Promise<Array<object>>} 问题列表，每项含 component、line、message、rule、severity、type 等
 */
async function getAllIssues() {
  return paginatedRequest(
    (page, pageSize) =>
      `/api/issues/search?componentKeys=${SONAR_PROJECT_KEY}&ps=${pageSize}&p=${page}&statuses=OPEN`,
    config,
    { responseArrayKey: 'issues', totalKey: 'total' },
  );
}

/**
 * 一次性拉取：项目指标、质量门禁状态、全部问题
 * @returns {Promise<{ metrics: object, issues: object[], qualityGate: string }>}
 */
async function fetchAllData() {
  const metrics =
    'bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,security_rating,reliability_rating,sqale_rating';

  const [measuresData, qualityGateData] = await Promise.all([
    apiRequest(
      `/api/measures/component?component=${SONAR_PROJECT_KEY}&metricKeys=${metrics}`,
      config,
    ),
    apiRequest(
      `/api/qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}`,
      config,
    ),
  ]);

  const issues = await getAllIssues();

  const metricsMap = {};
  measuresData.component.measures.forEach((measure) => {
    metricsMap[measure.metric] = measure.value;
  });

  return {
    metrics: metricsMap,
    issues,
    qualityGate: qualityGateData.projectStatus.status,
  };
}

/**
 * 按严重级别、类型统计问题，并按文件分组便于输出
 * @param {object[]} issues
 * @returns {{ stats: { bySeverity: object, byType: object }, byFile: object }}
 */
function calculateStats(issues) {
  const stats = {
    bySeverity: { CRITICAL: 0, MAJOR: 0, MINOR: 0, INFO: 0 },
    byType: {},
  };

  issues.forEach((issue) => {
    stats.bySeverity[issue.severity] = (stats.bySeverity[issue.severity] || 0) + 1;
    stats.byType[issue.type] = (stats.byType[issue.type] || 0) + 1;
  });

  const byFile = {};
  issues.forEach((issue) => {
    const file = issue.component.replace(`${SONAR_PROJECT_KEY}:`, '');
    if (!byFile[file]) byFile[file] = [];
    byFile[file].push(issue);
  });

  return { stats, byFile };
}

/**
 * 在控制台输出分析时间及数据新旧提示
 * @param {Date|null} analysisTime - 最近一次分析时间
 */
function formatAnalysisTime(analysisTime) {
  if (!analysisTime) {
    console.log(`获取时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log(`💡 提示: 先配置 .env.sonar 后，运行 bun sonarqube 可获取最新分析结果\n`);
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
    console.log(`💡 先配置 .env.sonar 后运行 bun sonarqube，可获取最新报告\n`);
  }
}

/**
 * 按文件输出问题详情：文件按“最严重问题”排序，同一文件内问题按严重级别排序
 * @param {object} byFile - 文件路径 -> 问题数组 的映射
 */
function printIssueDetails(byFile) {
  const severityOrder = { CRITICAL: 1, MAJOR: 2, MINOR: 3, INFO: 4 };

  const sortedFiles = Object.keys(byFile).sort((a, b) => {
    const maxSevA = Math.min(...byFile[a].map((i) => severityOrder[i.severity] || 99));
    const maxSevB = Math.min(...byFile[b].map((i) => severityOrder[i.severity] || 99));
    return maxSevA - maxSevB;
  });

  sortedFiles.forEach((file) => {
    const fileIssues = byFile[file].sort(
      (a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99),
    );

    console.log(`### ${file} (${fileIssues.length} 个问题)\n`);

    fileIssues.forEach((issue) => {
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

/**
 * 将拉取到的指标、问题、门禁状态格式化为完整报告并打印到控制台
 * @param {object} data - fetchAllData() 的返回值
 * @param {Date|null} analysisTime - getAnalysisTime() 的返回值
 */
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

// --- 主程序：拉取数据并输出报告 ---
try {
  console.log('正在获取 SonarQube 报告...');

  const analysisTime = await getAnalysisTime();
  const data = await fetchAllData();
  formatReport(data, analysisTime);
} catch (error) {
  console.error('\n❌ 错误:', error.message);
  console.error('\n请检查:');
  console.error('  1. 是否已先配置 .env.sonar，再运行 bun sonarqube');
  console.error('  2. SonarQube 服务是否运行 (http://localhost:9000)');
  console.error('  3. .env.sonar 配置是否正确');
  console.error('  4. 如果数据较旧，请重新运行: bun sonarqube');
  console.error('  5. 扫描完成后请等待几秒钟再查看报告\n');
  process.exit(1);
}
