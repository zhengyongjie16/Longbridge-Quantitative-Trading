#!/usr/bin/env node

/**
 * PermissionRequest hook (Bash/Edit/Write), cross-platform.
 *
 * Allows actions only when they stay within the project root.
 * Any uncertainty falls back to the default permission prompt.
 *
 * Bash policy:
 * - Blocklisted patterns are loaded from `.claude/settings.json` (`permissions.ask` entries of `Bash(...)`).
 * - For other commands: reject `..` traversal and Windows UNC paths, then extract absolute paths and ensure all stay under the project root.
 *
 * Edit/Write policy:
 * - Allow only when `file_path` resolves within the project root.
 *
 * Limits:
 * - String parsing cannot reliably handle shell expansions (e.g. `$HOME`, `~`).
 */

import { readFileSync } from 'node:fs';
import { resolve as _resolve, sep, join as _join } from 'node:path';

/** Cache platform value. */
const PLATFORM = process.platform;

/**
 * Convert a glob (supports `*` only) into a safe regex source.
 * @param {string} pattern
 * @returns {string} Regex source (no anchors).
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
 * Load Bash patterns from `.claude/settings.json` -> `permissions.ask`.
 * @param {string} projectRoot
 * @returns {string[]} Patterns without the `Bash(...)` wrapper.
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
 * Convert Git Bash drive paths (e.g. `/d/foo`) to Windows paths (`D:\foo`).
 * Only matches `/[letter]/...` (does not handle `/usr/...`).
 * @param {string} gitBashPath
 * @returns {string | null} Windows path, or null if not a drive path.
 */
function gitBashToWindowsPath(gitBashPath) {
  const m = new RegExp(/^\/([a-zA-Z])(\/.*)?$/).exec(gitBashPath);
  if (!m) return null;
  const drive = m[1].toUpperCase();
  const rest = (m[2] ?? '').replaceAll('/', '\\');
  return `${drive}:${rest || '\\'}`;
}

/**
 * Check whether a resolved absolute path is inside the project root (case-insensitive).
 * @param {string} resolvedPath
 * @param {string} projectRootLower Lowercased project root.
 * @returns {boolean}
 */
function isPathInProject(resolvedPath, projectRootLower) {
  const lp = resolvedPath.toLowerCase();
  return lp === projectRootLower || lp.startsWith(projectRootLower + sep);
}

/**
 * Extract absolute path candidates from a Bash command.
 * - Windows: `C:\...` and Git Bash `/d/...` (fails closed if conversion is ambiguous).
 * - macOS/Linux: strip `scheme://...` URLs, then match `/...` while avoiding scp-style `host:/path`.
 * @param {string} command
 * @returns {{ paths: string[], requiresConfirmation: boolean }}
 *   paths: Path strings suitable for `_resolve()`.
 *   requiresConfirmation: True when parsing was ambiguous (fail closed).
 */
function extractAbsolutePaths(command) {
  const paths = [];

  if (PLATFORM === 'win32') {
    // Windows absolute paths: `C:\...`
    for (const raw of command.match(/[A-Za-z]:\\[^\s'"`,;|&<>]*/g) ?? []) {
      paths.push(raw.replaceAll(/^["']|["']$/g, ''));
    }

    // Git Bash drive paths: `/d/...` -> `D:\...`
    for (const raw of command.match(/\/[a-zA-Z]\/[^\s'"`,;|&<>]*/g) ?? []) {
      const winPath = gitBashToWindowsPath(raw);
      if (winPath === null) {
        // Ambiguous format: fail closed.
        return { paths, requiresConfirmation: true };
      }
      paths.push(winPath);
    }
  } else {
    // Strip `scheme://...` URLs so we don't treat URL segments as local paths.
    const commandWithoutUrls = command.replaceAll(/\w+:\/\/[^\s'"`,;|&<>]*/g, '');

    // Match Unix absolute paths while avoiding `user@host:/remote/path`.
    for (const raw of commandWithoutUrls.match(/(?<![a-zA-Z0-9:])\/[^\s'"`,;|&<>]*/g) ?? []) {
      // Ignore a bare `/`.
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

    // Resolve project root.
    let projectRoot = String(process.env.CLAUDE_PROJECT_DIR || input.cwd || '');
    if (!projectRoot) {
      process.exit(0);
    }
    projectRoot = _resolve(projectRoot);
    const projectRootLower = projectRoot.toLowerCase();

    // Edit/Write: allow only within project root.
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

    // Bash only.
    if (toolName !== 'Bash') {
      process.exit(0);
    }

    const command = String(toolInput.command || '');
    const trimmedCommand = command.trim();

    // 1) Blocklist check (anchored at start to avoid substring matches).
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

    // 2) Reject traversal and Windows UNC paths.
    const hasParentRef = /(^|[\\/])\.\.([\\/]|$)/.test(command);
    const hasNetworkPath = /\\\\[^\\]/.test(command);
    if (hasParentRef || hasNetworkPath) {
      process.exit(0);
    }

    // 3) Extract absolute paths (platform-specific inside `extractAbsolutePaths`).
    const { paths, requiresConfirmation } = extractAbsolutePaths(command);
    if (requiresConfirmation) {
      process.exit(0);
    }

    // 4) Ensure all extracted paths stay within project root.
    for (const rawPath of paths) {
      const resolved = _resolve(rawPath);
      if (!isPathInProject(resolved, projectRootLower)) {
        process.exit(0);
      }
    }

    // 5) All checks passed: allow.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      }),
    );
  } catch {
    // Fail closed.
    process.exit(0);
  }
})();
