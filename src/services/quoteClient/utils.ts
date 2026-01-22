/**
 * 行情数据客户端模块工具函数
 */

/**
 * 静态信息类型（来自 LongPort API）
 * 包含标的的基本信息，如名称和交易单位
 * 仅内部使用
 */
type StaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
  readonly lot_size?: number | null;
  readonly lot?: number | null;
};

/**
 * 从静态信息中安全提取 lotSize
 * @param staticInfo 静态信息对象
 * @returns lotSize 值，如果无效则返回 undefined
 */
export const extractLotSize = (staticInfo: unknown): number | undefined => {
  if (!staticInfo || typeof staticInfo !== 'object') {
    return undefined;
  }

  const info = staticInfo as StaticInfo;
  const lotSizeValue = info.lotSize ?? info.lot_size ?? info.lot ?? null;

  if (lotSizeValue === null || lotSizeValue === undefined) {
    return undefined;
  }

  const parsed = Number(lotSizeValue);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return undefined;
};

/**
 * 从静态信息中安全提取名称
 * @param staticInfo 静态信息对象
 * @returns 名称，优先返回香港名称，其次中文名称，最后英文名称
 */
export const extractName = (staticInfo: unknown): string | null => {
  if (!staticInfo || typeof staticInfo !== 'object') {
    return null;
  }

  const info = staticInfo as StaticInfo;
  return info.nameHk ?? info.nameCn ?? info.nameEn ?? null;
};
