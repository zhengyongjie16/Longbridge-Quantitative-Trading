/**
 * monitorQuoteEventRuntime 集合工具模块
 *
 * 职责：
 * - 提供 monitor quote 与 switch wakeup runtime 共用的字符串集合比较逻辑
 */

/**
 * 判断两个字符串集合是否包含完全相同的元素。
 *
 * @param left 左侧集合
 * @param right 右侧集合
 * @returns 两个集合元素完全一致时返回 true
 */
export function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}
