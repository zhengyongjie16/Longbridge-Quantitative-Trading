/**
 * 获取 SonarQube 重复代码（Duplications）报告
 *
 * 功能：先拉取项目级重复行指标；若有权限则通过 component_tree 或 components/tree 找出有重复的文件，
 * 再对每个文件请求 api/duplications/show，汇总去重后输出重复块详情。若 Token 仅有项目 Browse 权限，
 * 则仅输出项目级重复行数与占比，并提示前往 Duplications 页面或为 Token 授予「查看源代码」权限。
 *
 * 使用方式: bun sonarqube:duplications
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
 * 通过 api/measures/component_tree 获取存在重复行的组件 key。
 * 使用 strategy=all 拉取所有层级，只保留 duplicated_lines > 0 且为文件（qualifier===FIL）的组件。
 * 若接口 403/404 或无数据则返回空数组。
 * @returns {Promise<string[]>}
 */
async function getFileKeysWithDuplicationFromTree() {
  try {
    const components = await paginatedRequest(
      (page, pageSize) =>
        `/api/measures/component_tree?component=${encodeURIComponent(SONAR_PROJECT_KEY)}&metricKeys=duplicated_lines&strategy=all&ps=${pageSize}&p=${page}`,
      config,
      { responseArrayKey: 'components' },
    );
    const keys = [];
    for (const comp of components) {
      const dupMeasure = comp.measures?.find((m) => m.metric === 'duplicated_lines');
      const value = dupMeasure?.value ? Number.parseInt(dupMeasure.value, 10) : 0;
      if (value <= 0) continue;
      const qualifier = comp.qualifier ?? comp.q;
      if (qualifier && qualifier !== 'FIL' && qualifier !== 'UTS') continue;
      keys.push(comp.key);
    }
    return keys;
  } catch (err) {
    if (err.message?.includes('403') || err.message?.includes('404')) {
      return [];
    }
    throw err;
  }
}

/**
 * 通过 api/components/tree 列出所有文件，再逐文件查询 duplicated_lines，筛出有重复的文件 key。
 * 在 component_tree 不可用或未返回有重复的文件时作为兜底。
 * @returns {Promise<string[]>}
 */
async function getFileKeysWithDuplicationViaComponentsTree() {
  let components;
  try {
    components = await paginatedRequest(
      (page, pageSize) =>
        `/api/components/tree?component=${encodeURIComponent(SONAR_PROJECT_KEY)}&strategy=all&ps=${pageSize}&p=${page}`,
      config,
      { responseArrayKey: 'components' },
    );
  } catch {
    return [];
  }
  const fileKeys = [];
  for (const comp of components) {
    const qualifier = comp.qualifier ?? comp.q;
    if (qualifier && qualifier !== 'FIL' && qualifier !== 'UTS') continue;
    fileKeys.push(comp.key);
  }

  const withDup = [];
  for (const key of fileKeys) {
    try {
      const data = await apiRequest(
        `/api/measures/component?component=${encodeURIComponent(key)}&metricKeys=duplicated_lines`,
        config,
      );
      const measures = data.component?.measures ?? [];
      const m = measures.find((x) => x.metric === 'duplicated_lines');
      const value = m?.value ? Number.parseInt(m.value, 10) : 0;
      if (value > 0) withDup.push(key);
    } catch {
      // 单文件查询失败则跳过
    }
  }
  return withDup;
}

/**
 * 获取存在重复行的文件组件 key 列表。先试 component_tree，再试 components/tree + 单文件 measures。
 * 若均无结果则返回空数组，主流程会再尝试项目级 duplications/show。
 */
async function getFileKeysWithDuplication() {
  let keys = await getFileKeysWithDuplicationFromTree();
  if (keys.length > 0) return keys;
  keys = await getFileKeysWithDuplicationViaComponentsTree();
  return keys;
}

/**
 * 获取项目级重复行指标（仅需项目 Browse 权限，与 get-report 一致）。
 * @returns {{ duplicatedLines: number, duplicatedLinesDensity: number } | null}
 */
async function getProjectDuplicationMeasures() {
  try {
    const data = await apiRequest(
      `/api/measures/component?component=${encodeURIComponent(SONAR_PROJECT_KEY)}&metricKeys=duplicated_lines,duplicated_lines_density`,
      config,
    );
    const measures = data.component?.measures ?? [];
    const lines = measures.find((m) => m.metric === 'duplicated_lines')?.value;
    const density = measures.find((m) => m.metric === 'duplicated_lines_density')?.value;
    return {
      duplicatedLines: lines == null ? 0 : Number.parseInt(String(lines), 10),
      duplicatedLinesDensity: density == null ? 0 : Number.parseFloat(String(density)),
    };
  } catch {
    return null;
  }
}

/**
 * 获取单个组件的重复块详情
 * @returns {{ duplications: Array<{ blocks: Array<{ from: number, size: number, _ref: string }> }>, files: Record<string, { key: string, name: string }> } | null }
 */
async function getDuplicationsForComponent(componentKey) {
  try {
    const data = await apiRequest(
      `/api/duplications/show?key=${encodeURIComponent(componentKey)}`,
      config,
    );
    if (!data.duplications?.length) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 将 Sonar 组件 key（如 projectKey:src/foo.ts）转为项目内相对路径
 * @param {string} key
 * @returns {string}
 */
function keyToPath(key) {
  const prefix = `${SONAR_PROJECT_KEY}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * 从 duplications/show 的响应中解析重复块组，按“路径:起始行:行数”生成指纹去重后加入 allGroups
 * @param {object|null} data - { duplications, files } 或 null
 * @param {Set<string>} seenFingerprints
 * @param {Array<Array<{ path: string, from: number, to: number, size: number, _ref: string }>>} allGroups
 */
function addGroupsFromResponse(data, seenFingerprints, allGroups) {
  if (!data?.duplications?.length) return;
  const { duplications, files } = data;
  for (const group of duplications) {
    const blocks = group.blocks || [];
    const resolved = blocks.map((b) => {
      const fileInfo = files[b._ref];
      const path = fileInfo ? keyToPath(fileInfo.key) : '?';
      const to = b.from + (b.size || 0) - 1;
      return { path, from: b.from, to, size: b.size, _ref: b._ref };
    });
    const fingerprint = resolved
      .map((b) => `${b.path}:${b.from}:${b.size}`)
      .sort()
      .join('|');
    if (seenFingerprints.has(fingerprint)) continue;
    seenFingerprints.add(fingerprint);
    allGroups.push(resolved);
  }
}

/**
 * 打印重复块组详情
 * @param {Array<Array<{ path: string, from: number, to: number, size: number }>>} allGroups
 */
function printGroupDetails(allGroups) {
  if (allGroups.length === 0) return;
  console.log('## 重复块详情\n');
  for (let index = 0; index < allGroups.length; index++) {
    const blocks = allGroups[index];
    const lines = blocks
      .map((b) => `${b.path} 行 ${b.from}-${b.to} (${b.size} 行)`)
      .join('\n       ');
    console.log(`### 组 ${index + 1}`);
    console.log(`  ${lines}\n`);
  }
}

/**
 * 主流程：拉取有重复的文件列表或项目级数据 → 汇总重复块 → 去重 → 输出报告
 * @returns {Promise<void>}
 */
async function run() {
  console.log('正在获取 SonarQube 重复项报告...\n');

  const projectMeasures = getProjectDuplicationMeasures();
  let fileKeys = await getFileKeysWithDuplication();
  let projectLevelData = null;

  if (fileKeys.length === 0) {
    projectLevelData = getDuplicationsForComponent(SONAR_PROJECT_KEY);
    if (!projectLevelData?.duplications?.length) {
      const hasDup = projectMeasures && projectMeasures.duplicatedLines > 0;
      console.log('=== SonarQube 重复项报告 ===\n');
      if (hasDup) {
        console.log(
          `项目存在重复代码：${projectMeasures.duplicatedLines} 行（${projectMeasures.duplicatedLinesDensity}%）。\n`,
        );
        console.log('当前 Token 无权限拉取具体重复块列表（需「查看源代码」或更高权限）。\n');
        console.log(
          '若使用的是 Project/Global Analysis Token，请改用 User Token（My Account → Security 中创建）。\n',
        );
        console.log('详见：docs/others/sonarqube-token-permissions.md\n');
      } else {
        console.log('未发现包含重复代码的文件。\n');
      }
      console.log(`Dashboard: ${SONAR_HOST_URL}/dashboard?id=${SONAR_PROJECT_KEY}`);
      console.log(`Duplications: ${SONAR_HOST_URL}/project/duplications?id=${SONAR_PROJECT_KEY}\n`);
      return;
    }
  }

  const seenFingerprints = new Set();
  const allGroups = [];

  if (projectLevelData) {
    addGroupsFromResponse(projectLevelData, seenFingerprints, allGroups);
  } else {
    for (const key of fileKeys) {
      const data = getDuplicationsForComponent(key);
      addGroupsFromResponse(data, seenFingerprints, allGroups);
    }
  }

  const fileCount =
    fileKeys.length > 0
      ? fileKeys.length
      : new Set(allGroups.flatMap((g) => g.map((b) => b.path))).size;
  console.log('=== SonarQube 重复项报告 ===\n');
  console.log(`涉及文件数: ${fileCount}`);
  console.log(`重复块组数: ${allGroups.length}\n`);

  printGroupDetails(allGroups);

  console.log('## 链接');
  console.log(`- Dashboard: ${SONAR_HOST_URL}/dashboard?id=${SONAR_PROJECT_KEY}`);
  console.log(`- Duplications: ${SONAR_HOST_URL}/project/duplications?id=${SONAR_PROJECT_KEY}\n`);
}

try {
  await run();
} catch (error) {
  console.error('\n❌ 错误:', error.message);
  console.error('\n请检查:');
  console.error('  1. SonarQube 服务是否运行');
  console.error('  2. 是否已先配置 .env.sonar，再运行 bun sonarqube 并完成扫描');
  console.error('  3. .env.sonar 配置是否正确');
  process.exit(1);
}
