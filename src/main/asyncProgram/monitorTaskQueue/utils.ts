import type { MonitorTask } from './types.js';

/**
 * 从队列中按条件移除任务（从尾部向前遍历，避免索引偏移）
 *
 * @param queue 任务队列数组（原地修改）
 * @param predicate 判断是否移除的条件函数，返回 true 则移除
 * @param onRemove 可选的移除回调，每移除一个任务时调用
 * @returns 实际移除的任务数量
 */
export const removeTasksFromQueue = <TType extends string, TData>(
  queue: Array<MonitorTask<TType, TData>>,
  predicate: (task: MonitorTask<TType, TData>) => boolean,
  onRemove?: (task: MonitorTask<TType, TData>) => void,
): number => {
  const originalLength = queue.length;

  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const task = queue[i];
    if (!task) {
      continue;
    }
    if (predicate(task)) {
      onRemove?.(task);
      queue.splice(i, 1);
    }
  }

  return originalLength - queue.length;
};
