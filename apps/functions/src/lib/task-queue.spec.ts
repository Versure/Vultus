import { describe, expect, it } from 'vitest';
import {
  chunk,
  createTaskEnqueuer,
  QUEUE_NAMES,
  SHARD_SIZE_ASSIGNMENTS,
  SHARD_SIZE_SHOWS,
  SHARD_SIZE_TITLES,
  SHARD_SIZE_USERS,
  shardTaskName,
  watchdogTaskName,
} from './task-queue';
import type {
  AiringScanTask,
  EpisodeCacheTask,
  EpisodeFanoutTask,
  SyncWatchdogTask,
  TaskQueueLike,
  TitleSyncTask,
} from './task-queue';

describe('chunk', () => {
  it('splits N items into ceil(N/size) shards, last shard is the remainder', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(chunk(items, 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('produces one full shard when N is an exact multiple of size', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('produces a single shard when size >= N', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('returns [] for empty input (0 shards)', () => {
    expect(chunk([], 500)).toEqual([]);
  });

  it('throws on a non-positive or non-integer size', () => {
    expect(() => chunk([1], 0)).toThrow();
    expect(() => chunk([1], -1)).toThrow();
    expect(() => chunk([1], 1.5)).toThrow();
  });
});

describe('shard-size constants', () => {
  it('are the spec-0101 defaults', () => {
    expect(SHARD_SIZE_TITLES).toBe(500);
    expect(SHARD_SIZE_SHOWS).toBe(150);
    expect(SHARD_SIZE_ASSIGNMENTS).toBe(1000);
    expect(SHARD_SIZE_USERS).toBe(500);
  });

  it('20,000 titles / SHARD_SIZE_TITLES => 40 shards', () => {
    const titles = Array.from({ length: 20000 }, (_, i) => i);
    expect(chunk(titles, SHARD_SIZE_TITLES)).toHaveLength(40);
  });
});

describe('task-name builders', () => {
  it('are deterministic: same (runId, stage, shardIndex) => same name', () => {
    expect(shardTaskName('run-1', 'titleSync', 3)).toBe(
      shardTaskName('run-1', 'titleSync', 3),
    );
    expect(shardTaskName('run-1', 'titleSync', 3)).toBe('run-1-titleSync-3');
  });

  it('differ by shardIndex (de-dupe only within the same shard)', () => {
    expect(shardTaskName('run-1', 'titleSync', 3)).not.toBe(
      shardTaskName('run-1', 'titleSync', 4),
    );
  });

  it('differ by stage', () => {
    expect(shardTaskName('run-1', 'titleSync', 0)).not.toBe(
      shardTaskName('run-1', 'episodeCache', 0),
    );
  });

  it('watchdog name is `${runId}-watchdog`', () => {
    expect(watchdogTaskName('run-1')).toBe('run-1-watchdog');
    expect(watchdogTaskName('run-1')).toBe(watchdogTaskName('run-1'));
  });
});

describe('enqueue payload shapes', () => {
  it('TitleSyncTask matches the interface', () => {
    const task: TitleSyncTask = {
      runId: 'r',
      shardIndex: 0,
      titles: [{ tmdbId: 1, type: 'movie' }],
      forced: false,
    };
    expect(task).toEqual({
      runId: 'r',
      shardIndex: 0,
      titles: [{ tmdbId: 1, type: 'movie' }],
      forced: false,
    });
  });

  it('EpisodeCacheTask carries distinct TV tmdbIds', () => {
    const task: EpisodeCacheTask = {
      runId: 'r',
      shardIndex: 1,
      shows: [10, 20],
    };
    expect(task.shows).toEqual([10, 20]);
  });

  it('EpisodeFanoutTask carries (uid, titleId, tmdbId) assignments', () => {
    const task: EpisodeFanoutTask = {
      runId: 'r',
      shardIndex: 2,
      assignments: [{ uid: 'u1', titleId: 't1', tmdbId: 5 }],
    };
    expect(task.assignments[0]).toEqual({
      uid: 'u1',
      titleId: 't1',
      tmdbId: 5,
    });
  });

  it('AiringScanTask carries uids', () => {
    const task: AiringScanTask = {
      runId: 'r',
      shardIndex: 3,
      uids: ['u1', 'u2'],
    };
    expect(task.uids).toEqual(['u1', 'u2']);
  });

  it('SyncWatchdogTask carries only the runId', () => {
    const task: SyncWatchdogTask = { runId: 'r' };
    expect(Object.keys(task)).toEqual(['runId']);
  });
});

describe('createTaskEnqueuer', () => {
  interface Enqueued {
    queueName: string;
    data: unknown;
    opts?: { id?: string; scheduleDelaySeconds?: number };
  }

  function fakeFactory() {
    const enqueued: Enqueued[] = [];
    const factory = (queueName: string): TaskQueueLike => ({
      enqueue: (data, opts) => {
        enqueued.push({ queueName, data, opts });
        return Promise.resolve();
      },
    });
    return { factory, enqueued };
  }

  it('routes payload to the named queue and maps `name` -> Cloud Tasks `id`', async () => {
    const { factory, enqueued } = fakeFactory();
    const enqueuer = createTaskEnqueuer(factory);
    const payload: TitleSyncTask = {
      runId: 'r1',
      shardIndex: 0,
      titles: [{ tmdbId: 1, type: 'tv' }],
      forced: false,
    };

    await enqueuer.enqueue(QUEUE_NAMES.titleSync, payload, {
      name: shardTaskName('r1', 'titleSync', 0),
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].queueName).toBe('titleSyncWorker');
    expect(enqueued[0].data).toEqual(payload);
    expect(enqueued[0].opts).toEqual({ id: 'r1-titleSync-0' });
  });

  it('passes scheduleDelaySeconds through (watchdog)', async () => {
    const { factory, enqueued } = fakeFactory();
    const enqueuer = createTaskEnqueuer(factory);
    const payload: SyncWatchdogTask = { runId: 'r1' };

    await enqueuer.enqueue(QUEUE_NAMES.watchdog, payload, {
      name: watchdogTaskName('r1'),
      scheduleDelaySeconds: 7200,
    });

    expect(enqueued[0].queueName).toBe('syncWatchdog');
    expect(enqueued[0].opts).toEqual({
      id: 'r1-watchdog',
      scheduleDelaySeconds: 7200,
    });
  });

  it('omits undefined option keys (no id / delay when not given)', async () => {
    const { factory, enqueued } = fakeFactory();
    const enqueuer = createTaskEnqueuer(factory);
    await enqueuer.enqueue(QUEUE_NAMES.airingScan, {
      runId: 'r',
      shardIndex: 0,
      uids: [],
    });
    expect(enqueued[0].opts).toEqual({});
  });
});
