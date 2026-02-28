/**
 * SonarQube 脚本公共模块：项目根路径、.env.sonar 解析、API 请求
 * 供 get-report.js、get-duplications.js、run-sonar.js 复用，避免重复代码。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 获取项目根路径（scripts 的上一级）
 * @returns {string}
 */
export function getProjectRoot() {
  return join(__dirname, '..');
}

/**
 * 从 .env.sonar 加载配置（KEY=VALUE，支持 # 注释，value 中可含 =）
 * @param {string} [projectRoot] - 项目根路径，默认 getProjectRoot()
 * @returns {{ SONAR_HOST_URL: string, SONAR_TOKEN: string, SONAR_PROJECT_KEY: string, [key: string]: string }}
 * @throws {Error} 文件读取失败时抛出
 */
export function loadConfig(projectRoot = getProjectRoot()) {
  const envPath = join(projectRoot, '.env.sonar');
  const config = {};
  const content = readFileSync(envPath, 'utf-8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        config[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
  return config;
}

/**
 * 调用 SonarQube REST API（Basic 认证，带时间戳防缓存）
 * @param {string} path - API 路径
 * @param {{ SONAR_HOST_URL: string, SONAR_TOKEN: string }} config
 * @returns {Promise<object>}
 */
export async function apiRequest(path, config) {
  const { SONAR_HOST_URL, SONAR_TOKEN } = config;
  const separator = path.includes('?') ? '&' : '?';
  const url = `${SONAR_HOST_URL}${path}${separator}_=${Date.now()}`;
  const auth = Buffer.from(`${SONAR_TOKEN}:`).toString('base64');

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * 分页请求 SonarQube API，直到某页返回数量不足 pageSize（或达到 total）。
 * 供 component_tree、components/tree、issues/search 等分页接口复用。
 * @param {(page: number, pageSize: number) => string} pathBuilder - 接收 (page, pageSize)，返回 API 路径（含查询参数，不含 host）
 * @param {{ SONAR_HOST_URL: string, SONAR_TOKEN: string }} config - loadConfig() 返回值
 * @param {{ pageSize?: number, responseArrayKey?: string, totalKey?: string }} [options]
 *   - pageSize 默认 500
 *   - responseArrayKey 响应中列表字段名，如 'components' 或 'issues'，默认 'components'
 *   - totalKey 响应中总数字段名（如 'total'），若提供则用 total 做提前结束判断
 * @returns {Promise<object[]>}
 */
export async function paginatedRequest(pathBuilder, config, options = {}) {
  const pageSize = options.pageSize ?? 500;
  const responseArrayKey = options.responseArrayKey ?? 'components';
  const totalKey = options.totalKey;
  const items = [];
  let page = 1;
  let totalSoFar = 0;

  while (true) {
    const path = pathBuilder(page, pageSize);
    const data = await apiRequest(path, config);
    const chunk = data[responseArrayKey] ?? [];
    items.push(...chunk);
    totalSoFar += chunk.length;
    if (chunk.length < pageSize) break;
    if (totalKey != null && data[totalKey] != null && totalSoFar >= Number(data[totalKey])) break;
    page++;
  }
  return items;
}
