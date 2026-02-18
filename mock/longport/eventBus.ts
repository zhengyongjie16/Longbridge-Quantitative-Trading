/**
 * LongPort 事件总线
 *
 * 功能：
 * - 提供延迟投递、顺序控制与批量刷新能力
 */
import type { PushCandlestickEvent, PushOrderChanged, PushQuoteEvent } from 'longport';

export type LongportEventTopic = 'quote' | 'candlestick' | 'orderChanged';

export type LongportEventPayloadMap = {
  readonly quote: PushQuoteEvent;
  readonly candlestick: PushCandlestickEvent;
  readonly orderChanged: PushOrderChanged;
};

type Subscriber<TTopic extends LongportEventTopic> = (
  payload: LongportEventPayloadMap[TTopic],
) => void;

type QueueEvent<TTopic extends LongportEventTopic> = {
  readonly topic: TTopic;
  readonly payload: LongportEventPayloadMap[TTopic];
  readonly deliverAtMs: number;
  readonly sequence: number;
  readonly insertedAt: number;
};

type QueueEventUnion = {
  [K in LongportEventTopic]: QueueEvent<K>;
}[LongportEventTopic];

function createQueueEvent<TTopic extends LongportEventTopic>(
  topic: TTopic,
  payload: LongportEventPayloadMap[TTopic],
  deliverAtMs: number,
  sequence: number,
  insertedAt: number,
): QueueEvent<TTopic> {
  return {
    topic,
    payload,
    deliverAtMs,
    sequence,
    insertedAt,
  };
}

export type EventPublishOptions = {
  readonly deliverAtMs?: number;
  readonly sequence?: number;
};

export interface LongportEventBus {
  subscribe<TTopic extends LongportEventTopic>(
    topic: TTopic,
    subscriber: Subscriber<TTopic>,
  ): () => void;
  publish<TTopic extends LongportEventTopic>(
    topic: TTopic,
    payload: LongportEventPayloadMap[TTopic],
    options?: EventPublishOptions,
  ): void;
  flushDue(nowMs?: number): number;
  flushAll(): number;
  getQueueSize(): number;
}

/**
 * 选取当前可投递事件并从队列移除。
 *
 * 按 `deliverAtMs -> sequence -> insertedAt` 三重排序，确保同一时间点下
 * 事件分发顺序稳定，便于测试中断言可重复。
 */
function takeDueEvents(
  queue: Array<QueueEventUnion>,
  nowMs: number,
): ReadonlyArray<QueueEventUnion> {
  const dueEvents = queue
    .filter((event) => event.deliverAtMs <= nowMs)
    .sort((a, b) => {
      if (a.deliverAtMs !== b.deliverAtMs) {
        return a.deliverAtMs - b.deliverAtMs;
      }
      if (a.sequence !== b.sequence) {
        return a.sequence - b.sequence;
      }
      return a.insertedAt - b.insertedAt;
    });

  if (dueEvents.length === 0) {
    return [];
  }

  const dueSet = new Set(dueEvents);
  queue.splice(
    0,
    queue.length,
    ...queue.filter((event) => !dueSet.has(event)),
  );

  return dueEvents;
}

/**
 * 创建可控的 LongPort 事件总线。
 *
 * 该实现支持延迟投递和显式 flush，目的是让测试在时间推进与事件分发之间
 * 获得确定性的执行边界。
 */
export function createLongportEventBus(getNowMs: () => number = () => Date.now()): LongportEventBus {
  const subscribers = {
    quote: new Set(),
    candlestick: new Set(),
    orderChanged: new Set(),
  } as {
    quote: Set<Subscriber<'quote'>>;
    candlestick: Set<Subscriber<'candlestick'>>;
    orderChanged: Set<Subscriber<'orderChanged'>>;
  };

  const queue: Array<QueueEventUnion> = [];
  let insertionCounter = 0;

  function subscribe<TTopic extends LongportEventTopic>(
    topic: TTopic,
    subscriber: Subscriber<TTopic>,
  ): () => void {
    if (topic === 'quote') {
      subscribers.quote.add(subscriber as Subscriber<'quote'>);
    } else if (topic === 'candlestick') {
      subscribers.candlestick.add(subscriber as Subscriber<'candlestick'>);
    } else {
      subscribers.orderChanged.add(subscriber as Subscriber<'orderChanged'>);
    }

    return () => {
      if (topic === 'quote') {
        subscribers.quote.delete(subscriber as Subscriber<'quote'>);
      } else if (topic === 'candlestick') {
        subscribers.candlestick.delete(subscriber as Subscriber<'candlestick'>);
      } else {
        subscribers.orderChanged.delete(subscriber as Subscriber<'orderChanged'>);
      }
    };
  }

  function publish<TTopic extends LongportEventTopic>(
    topic: TTopic,
    payload: LongportEventPayloadMap[TTopic],
    options: EventPublishOptions = {},
  ): void {
    const deliverAtMs = options.deliverAtMs ?? getNowMs();
    const sequence = options.sequence ?? 0;
    queue.push(
      createQueueEvent(topic, payload, deliverAtMs, sequence, insertionCounter) as QueueEventUnion,
    );
    insertionCounter += 1;
  }

  function flushDue(nowMs: number = getNowMs()): number {
    const dueEvents = takeDueEvents(queue, nowMs);
    for (const event of dueEvents) {
      if (event.topic === 'quote') {
        for (const subscriber of subscribers.quote) {
          subscriber(event.payload);
        }
      } else if (event.topic === 'candlestick') {
        for (const subscriber of subscribers.candlestick) {
          subscriber(event.payload);
        }
      } else {
        for (const subscriber of subscribers.orderChanged) {
          subscriber(event.payload);
        }
      }
    }
    return dueEvents.length;
  }

  function flushAll(): number {
    let total = 0;
    while (queue.length > 0) {
      total += flushDue(Number.POSITIVE_INFINITY);
    }
    return total;
  }

  function getQueueSize(): number {
    return queue.length;
  }

  return {
    subscribe,
    publish,
    flushDue,
    flushAll,
    getQueueSize,
  };
}
