#!/usr/bin/env node

/**
 * PermissionRequest hook（Bash / Edit / Write）— 跨平台版本（Windows / macOS / Linux）
 *
 * 职责：
 * - Bash 工具：
 *   - 从 .claude/settings.json 读取 permissions.ask 中的 Bash 模式，作为"黑名单"（单一配置源）。
 *   - 黑名单命令：永远不自动放行，交给默认权限弹窗（保持 ask）。
 *   - 其余命令：按当前操作系统提取命令中的绝对路径，若所有路径均在项目根目录内
 *     （且无 ../ 越级访问、无 Windows UNC 网络路径），则自动 allow；否则保持 ask。
 * - Edit / Write 工具：
 *   - 若 file_path 在项目根目录内，则自动 allow；否则保持 ask。
 *
 * 跨平台路径检测策略（隔离在 extractAbsolutePaths 中）：
 * - Windows：检测 C:\path\...（原生路径）和 /d/path/...（Git Bash 驱动器路径）。
 * - macOS / Linux：先去除命令中的 URL（scheme://...），再检测 /path/...（Unix 绝对路径）。
 *   负向后瞻自然排除 SCP 风格的远程路径（user@host:/remote/path）。
 *
 * 黑名单匹配规则：
 * - 锚定到命令开头（^ 前缀），避免子串误匹配（如 echo "git push" 不应命中黑名单）。
 * - * 通配符匹配任意字符，适用于 "git push *" 等模式。
 *
 * 已知局限（string-based 命令解析的固有限制）：
 * - Shell 变量展开（$HOME/file）和波浪线展开（~/file）不可静态检测，不在保护范围内。
 */

import { readFileSync } from 'node:fs';
import { resolve as _resolve, sep, join as _join } from 'node:path';

/** 当前操作系统平台，模块级常量，避免重复调用 */
const PLATFORM = process.platform;

/**
 * 将 glob 模式（仅支持 *）转换为正则表达式片段，其余特殊字符全部转义。
 * @param {string} pattern
 * @returns {string} 正则源字符串（不含锚定符号）
 */
function globToRegexSource(pattern) {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') {
      out += '.*';
    } else if (String.raw`\^$+?.()|{}[]`.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 从 .claude/settings.json 读取 permissions.ask 中的 Bash 黑名单模式列表。
 * @param {string} projectRoot
 * @returns {string[]} 黑名单模式数组（已去掉 Bash(...) 包装）
 */
function loadBashAskPatterns(projectRoot) {
  try {
    const settingsPath = _join(projectRoot, '.claude', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf8');
    const json = JSON.parse(raw);
    const ask = json.permissions?.ask ?? [];
    return ask
      .filter((item) => typeof item === 'string' && item.startsWith('Bash(') && item.endsWith(')'))
      .map((item) => item.slice('Bash('.length, -1).trim());
  } catch {
    return [];
  }
}

/**
 * 将 Git Bash 驱动器风格路径（如 /d/code/project）转换为 Windows 绝对路径（D:\code\project）。
 * 仅匹配 /单字母/ 格式（Git Bash 驱动器路径），不处理 /usr/bin/... 等 Unix 系统路径。
 * 仅在 Windows 平台调用。
 * @param {string} gitBashPath
 * @returns {string | null} Windows 路径，若不符合驱动器路径格式则返回 null
 */
function gitBashToWindowsPath(gitBashPath) {
  const m = new RegExp(/^\/([a-zA-Z])(\/.*)?$/).exec(gitBashPath);
  if (!m) return null;
  const drive = m[1].toUpperCase();
  const rest = (m[2] ?? '').replaceAll('/', '\\');
  return `${drive}:${rest || '\\'}`;
}

/**
 * 判断已 resolve 的绝对路径是否在项目根目录内（大小写不敏感）。
 * @param {string} resolvedPath
 * @param {string} projectRootLower 已小写化的项目根路径
 * @returns {boolean}
 */
function isPathInProject(resolvedPath, projectRootLower) {
  const lp = resolvedPath.toLowerCase();
  return lp === projectRootLower || lp.startsWith(projectRootLower + sep);
}

/**
 * 从 Bash 命令字符串中提取所有绝对路径候选项。
 *
 * 平台分支（完全隔离于本函数内，主流程无需感知平台差异）：
 *
 * Windows：
 *   1. 提取 C:\... 格式的 Windows 原生绝对路径。
 *   2. 提取 /d/... 格式的 Git Bash 驱动器路径并转换为 Windows 格式。
 *      转换失败时返回 requiresConfirmation=true（保守处理）。
 *
 * macOS / Linux：
 *   1. 先从命令副本中去除所有 URL（scheme://...），防止将 http://host/path
 *      中的 /path 误识别为本地绝对路径。
 *   2. 提取以 / 开头的路径（Unix 绝对路径）。
 *      负向后瞻 (?<![a-zA-Z0-9:]) 自然排除：
 *        - URL scheme 残留（如 http:/ 去除后的痕迹）
 *        - SCP 风格远程路径（user@host:/remote/path 中 : 之后的 /path）
 *
 * @param {string} command
 * @returns {{ paths: string[], requiresConfirmation: boolean }}
 *   paths: 已可直接传入 _resolve() 的路径字符串数组
 *   requiresConfirmation: true 表示遇到无法解析的路径格式，主调方应保守地要求确认
 */
function extractAbsolutePaths(command) {
  const paths = [];

  if (PLATFORM === 'win32') {
    // ── Windows 原生绝对路径：C:\path\... ──────────────────────────────────
    for (const raw of command.match(/[A-Za-z]:\\[^\s'"`,;|&<>]*/g) ?? []) {
      paths.push(raw.replaceAll(/^["']|["']$/g, ''));
    }

    // ── Git Bash 驱动器路径：/d/path/... → D:\path\... ─────────────────────
    // 精确匹配 /单字母/ 开头，不误匹配 /usr/bin/... 等多字母 Unix 系统路径
    for (const raw of command.match(/\/[a-zA-Z]\/[^\s'"`,;|&<>]*/g) ?? []) {
      const winPath = gitBashToWindowsPath(raw);
      if (winPath === null) {
        // 结构异常，无法确定路径意图 → 保守处理，要求确认
        return { paths, requiresConfirmation: true };
      }
      paths.push(winPath);
    }
  } else {
    // ── macOS / Linux：Unix 绝对路径 /path/... ─────────────────────────────
    // 步骤 1：去除带 scheme 的 URL（http://、https://、git:// 等），
    // 防止将 URL 中的路径段（/api/data）误识别为本地文件路径。
    // 这是原则性过滤，而非补丁：scheme:// 是可靠的"非本地路径"标识。
    const commandWithoutUrls = command.replaceAll(/\w+:\/\/[^\s'"`,;|&<>]*/g, '');

    // 步骤 2：提取 Unix 绝对路径
    // 负向后瞻 (?<![a-zA-Z0-9:]) 排除以下误匹配：
    //   - URL 残留（: 后紧跟 /，如 ftp:/ 去除不完整时）
    //   - SCP 远程路径（user@host:/remote/path 中 : 之后的 /remote/path 不是本地路径）
    for (const raw of commandWithoutUrls.match(/(?<![a-zA-Z0-9:])\/[^\s'"`,;|&<>]*/g) ?? []) {
      // 排除孤立的单个 /（在 shell 中不代表任何具体文件路径）
      if (raw.length > 1) {
        paths.push(raw);
      }
    }
  }

  return { paths, requiresConfirmation: false };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.exit(0);
    }

    const input = JSON.parse(raw);
    if (input.hook_event_name !== 'PermissionRequest') {
      process.exit(0);
    }

    const toolName = input.tool_name;
    const toolInput = input.tool_input ?? {};

    // 计算项目根目录（优先使用 CLAUDE_PROJECT_DIR，其次用 cwd）
    let projectRoot = String(process.env.CLAUDE_PROJECT_DIR || input.cwd || '');
    if (!projectRoot) {
      process.exit(0);
    }
    projectRoot = _resolve(projectRoot);
    const projectRootLower = projectRoot.toLowerCase();

    // ── Edit / Write 工具：直接检查 file_path ────────────────────────────────
    // _resolve 在各平台均使用原生路径语义，isPathInProject 通过 sep 正确区分平台
    if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = String(toolInput.file_path || toolInput.path || '');
      if (!filePath) {
        process.exit(0);
      }
      const resolved = _resolve(projectRoot, filePath);
      if (!isPathInProject(resolved, projectRootLower)) {
        process.exit(0);
      }
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        }),
      );
      return;
    }

    // ── Bash 工具 ─────────────────────────────────────────────────────────────
    if (toolName !== 'Bash') {
      process.exit(0);
    }

    const command = String(toolInput.command || '');
    const trimmedCommand = command.trim();

    // 1. 黑名单检查：锚定到命令开头（^），防止 echo "git push" 等子串误匹配
    const bashAskPatterns = loadBashAskPatterns(projectRoot);
    if (bashAskPatterns.length > 0) {
      const isBlacklisted = bashAskPatterns.some((pattern) => {
        const re = new RegExp('^' + globToRegexSource(pattern), 'i');
        return re.test(trimmedCommand);
      });
      if (isBlacklisted) {
        process.exit(0);
      }
    }

    // 2. 越级访问（../）检查：跨平台，同时匹配 \ 和 / 作为路径分隔符
    //    Windows UNC 网络路径（\\server\share）检查：macOS 上此正则永远不匹配，无副作用
    const hasParentRef = /(^|[\\/])\.\.([\\/]|$)/.test(command);
    const hasNetworkPath = /\\\\[^\\]/.test(command);
    if (hasParentRef || hasNetworkPath) {
      process.exit(0);
    }

    // 3. 提取绝对路径（平台差异完全封装在 extractAbsolutePaths 内）
    const { paths, requiresConfirmation } = extractAbsolutePaths(command);
    if (requiresConfirmation) {
      process.exit(0);
    }

    // 4. 逐一判断提取出的路径是否越出项目目录
    for (const rawPath of paths) {
      const resolved = _resolve(rawPath);
      if (!isPathInProject(resolved, projectRootLower)) {
        process.exit(0);
      }
    }

    // 5. 所有检查通过 → 自动放行
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      }),
    );
  } catch {
    // 出错时保守处理，不自动放行
    process.exit(0);
  }
})();
