import type { MonitorTask } from './types.js';

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
