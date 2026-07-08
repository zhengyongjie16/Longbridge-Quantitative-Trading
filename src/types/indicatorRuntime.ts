/**
 * 增量指标运行态公共句柄。
 * 类型用途：为跨模块缓存与传递 runtime 提供不透明句柄，避免 types 层依赖 indicators/runtime 内部状态细节。
 * 数据来源：由 indicators/runtime 模块创建并维护，外部调用方只允许持有并回传，不应解构内部字段。
 * 使用范围：MonitorState 与调用 runtime 服务的模块。
 */
export type IndicatorIncrementalRuntime = {
  readonly __indicatorIncrementalRuntimeBrand: never;
};
