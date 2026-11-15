import { redis } from '@devvit/web/server';
import { assertCheckpoint, assertRecord, BridgeError, LEASE_MS, RETENTION_MS, type Checkpoint, type RecordState, type Store } from '../core.ts';
import { assertActivation, assertLatestFiveIds, type Activation, type DeliveryStore, type LatestFive } from '../delivery.ts';

const PREFIX = 'glr-read-v1:';
const key = (s: string) => PREFIX + s;
const recordKey = (id: string) => key(`post:${id}`);
const parse = (value: string | null | undefined): unknown => {
  if (value == null) return undefined;
  try { return JSON.parse(value); } catch { throw new BridgeError('INVALID_REDIS_JSON'); }
};

export class RedisStore implements Store, DeliveryStore {
  async claim(token: string, now: number): Promise<boolean> {
    await redis.set(key('lease'), token, { nx: true, expiration: new Date(now + LEASE_MS) });
    return await redis.get(key('lease')) === token;
  }
  async checkpoint(): Promise<Checkpoint | undefined> {
    const value = parse(await redis.get(key('checkpoint')));
    if (value === undefined) return undefined;
    assertCheckpoint(value);
    return value;
  }
  async records(ids: string[]): Promise<(RecordState | undefined)[]> {
    if (!ids.length) return [];
    return (await redis.mGet(ids.map(recordKey))).map((raw, i) => {
      const value = parse(raw);
      if (value === undefined) return undefined;
      assertRecord(value);
      if (value.id !== ids[i]) throw new BridgeError('RECORD_ID_MISMATCH');
      return value;
    });
  }
  private async transaction(token: string) {
    const tx = await redis.watch(key('lease'));
    if (await redis.get(key('lease')) !== token) {
      await tx.discard();
      throw new BridgeError('LEASE_LOST');
    }
    await tx.multi();
    return tx;
  }
  async commit(token: string, records: RecordState[], checkpoint?: Checkpoint, latestFive?: LatestFive): Promise<void> {
    records.forEach(assertRecord);
    if (checkpoint) assertCheckpoint(checkpoint);
    if (!records.length && !checkpoint && !latestFive) return;
    const tx = await this.transaction(token);
    const values: Record<string, string> = {};
    if (checkpoint) values[key('checkpoint')] = JSON.stringify(checkpoint);
    for (const record of records) values[recordKey(record.id)] = JSON.stringify(record);
    if (latestFive) values[key('latest-five-requested')] = '1';
    await tx.mSet(values);
    if (latestFive) {
      await tx.set(key('latest-five-ids'), JSON.stringify(latestFive.ids), {
        expiration: new Date(latestFive.requestedAt + RETENTION_MS),
      });
    }
    if (records.length) {
      const ids = records.map(r => r.id);
      await tx.zRem(key('pending'), ids);
      await tx.zRem(key('recheck'), ids);
      await tx.zRem(key('expiry'), ids);
      await tx.zRem(key('telegram-posted'), ids);
      await tx.zRem(key('telegram-reserved'), ids);
      await tx.zRem(key('telegram-removals'), ids);
      const pending = records.filter(r => r.stage === 'pending' && r.availability === 'available');
      if (pending.length) await tx.zAdd(key('pending'), ...pending.map(r => ({ member: r.id, score: r.createdAt })));
      const recheck = records.filter(r => r.stage === 'pending');
      if (recheck.length) await tx.zAdd(key('recheck'), ...recheck.map(r => ({ member: r.id, score: r.nextCheckAt })));
      const posted = records.filter(r => r.stage === 'sent');
      if (posted.length) await tx.zAdd(key('telegram-posted'), ...posted.map(r => ({ member: r.id, score: r.nextCheckAt })));
      const removals = posted.filter(r => r.availability === 'unavailable');
      if (removals.length) await tx.zAdd(key('telegram-removals'), ...removals.map(r => ({ member: r.id, score: r.nextCheckAt })));
      const reserved = records.filter(r => r.stage === 'reserved');
      if (reserved.length) await tx.zAdd(key('telegram-reserved'), ...reserved.map(r => ({ member: r.id, score: r.lastCheckedAt })));
      const expire = records.filter(r => r.stage !== 'sent' && r.stage !== 'reserved');
      if (expire.length) await tx.zAdd(key('expiry'), ...expire.map(r => ({
        member: r.id, score: Math.max(r.createdAt, r.latestFiveRequestedAt ?? 0),
      })));
    }
    const result = await tx.exec();
    if (!result.length) throw new BridgeError('TRANSACTION_NOT_COMMITTED');
  }
  async due(now: number, limit: number): Promise<string[]> {
    return (await redis.zRange(key('recheck'), '-inf', now, {
      by: 'score', limit: { offset: 0, count: limit },
    })).map(r => r.member);
  }
  async activation(): Promise<Activation | undefined> {
    const value = parse(await redis.get(key('telegram-activation')));
    if (value === undefined) return undefined;
    assertActivation(value);
    return value;
  }
  async activate(token: string, value: Activation): Promise<void> {
    assertActivation(value);
    const tx = await this.transaction(token);
    await tx.mSet({ [key('telegram-activation')]: JSON.stringify(value) });
    if (!(await tx.exec()).length) throw new BridgeError('TRANSACTION_NOT_COMMITTED');
  }
  async pendingAfter(startedAt: number, limit: number): Promise<string[]> {
    return (await redis.zRange(key('pending'), startedAt + 1, '+inf', {
      by: 'score', limit: { offset: 0, count: limit },
    })).map(r => r.member);
  }
  async postedDue(now: number, limit: number): Promise<string[]> {
    return (await redis.zRange(key('telegram-posted'), '-inf', now, {
      by: 'score', limit: { offset: 0, count: limit },
    })).map(r => r.member);
  }
  async hasPendingRemovals(): Promise<boolean> {
    return await redis.zCard(key('telegram-removals')) > 0;
  }
  async requestedLatestFive(): Promise<string[] | undefined> {
    const [marker, snapshot] = await redis.mGet([key('latest-five-requested'), key('latest-five-ids')]);
    if (marker == null && snapshot == null) return undefined;
    if (marker !== '1') throw new BridgeError('INVALID_LATEST_FIVE_MARKER');
    if (snapshot == null) return []; // Retain the one-time marker after the ID snapshot expires.
    const ids = parse(snapshot);
    assertLatestFiveIds(ids);
    return ids;
  }
  async commitLatestFive(token: string, records: RecordState[], batch: LatestFive): Promise<void> {
    assertLatestFiveIds(batch.ids);
    await this.commit(token, records, undefined, batch);
  }
  async prune(token: string, before: number): Promise<number> {
    const ids = (await redis.zRange(key('expiry'), '-inf', before, {
      by: 'score', limit: { offset: 0, count: 100 },
    })).map(r => r.member);
    if (!ids.length) return 0;
    const tx = await this.transaction(token);
    await tx.del(...ids.map(recordKey));
    for (const index of ['expiry', 'pending', 'recheck']) await tx.zRem(key(index), ids);
    if (!(await tx.exec()).length) throw new BridgeError('TRANSACTION_NOT_COMMITTED');
    return ids.length;
  }
  async counts() {
    return {
      pending: await redis.zCard(key('pending')),
      trackedForRecheck: await redis.zCard(key('recheck')),
      telegramTracked: await redis.zCard(key('telegram-posted')),
      telegramReserved: await redis.zCard(key('telegram-reserved')),
      checkpoint: await this.checkpoint(),
    };
  }
}
