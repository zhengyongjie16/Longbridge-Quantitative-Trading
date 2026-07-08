/**
 * 外部 API retry 配置。
 * 类型用途：限定真实外部 API 请求失败后的有限重试次数与间隔。
 * 数据来源：调用方显式传入或使用 API 默认常量。
 * 使用范围：wrapExternalApiRequest 工具函数。
 */
export type ExternalApiRetryConfig = Readonly<{
  retries: number;
  delayMs: number;
}>;

/**
 * 外部 API 重试决策。
 * 类型用途：表达单个错误在统一分类器下应进入有限重试还是立即抛出。
 * 数据来源：isRetryableExternalApiError 对错误对象的分类结果。
 * 使用范围：wrapExternalApiRequest 默认重试门禁。
 */
export type ExternalApiRetryDecision = 'RETRY' | 'FAIL_FAST';

/**
 * 外部 API 请求失败错误。
 * 类型用途：表达真实外部 API 请求在有限尝试后仍失败。
 * 数据来源：createExternalApiRequestError 根据原始错误构造。
 * 使用范围：运行时错误分类与 retry 边界判断。
 */
export type ExternalApiRequestError = Error &
  Readonly<{
    name: 'ExternalApiRequestError';
    operation: string;
    attempts: number;
  }>;

/**
 * 外部 API 聚合请求错误构造参数。
 * 类型用途：表达同一个恢复任务中多个外部 API 请求失败的聚合分类。
 * 数据来源：调用方收集到的 ExternalApiRequestError 列表。
 * 使用范围：需要保留 retry 分类的聚合失败边界。
 */
export type ExternalApiAggregateRequestErrorParams = Readonly<{
  operation: string;
  attempts: number;
  causes: ReadonlyArray<ExternalApiRequestError>;
}>;

/**
 * 外部 API 请求错误构造参数。
 * 类型用途：封装 ExternalApiRequestError 所需的请求标识、尝试次数和原始错误。
 * 数据来源：wrapExternalApiRequest 在重试耗尽后组装。
 * 使用范围：ExternalApiRequestError 构造函数。
 */
export type ExternalApiRequestErrorParams = Readonly<{
  operation: string;
  attempts: number;
  cause: unknown;
}>;

/**
 * 外部 API 请求包装参数。
 * 类型用途：封装单次外部 API 请求函数、操作名与 retry 配置。
 * 数据来源：各 Longbridge SDK / marketDataClient / trader 请求边界传入。
 * 使用范围：wrapExternalApiRequest 工具函数。
 */
export type WrapExternalApiRequestParams<T> = Readonly<{
  operation: string;
  request: () => Promise<T>;
  shouldRetry?: (error: unknown) => boolean;
  retryConfig?: ExternalApiRetryConfig;
}>;
