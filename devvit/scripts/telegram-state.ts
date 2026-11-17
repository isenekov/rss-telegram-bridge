import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SMOKE_ID, TelegramError, type DeliveryJournal, type SendOutcome, type Target } from '../src/telegram.ts';

type State = {
  version: 1; test: typeof SMOKE_ID; attempt: string; startedAt: number;
  outcome?: SendOutcome; retryAt?: number;
};
function decode(raw: string): State {
  let s: State;
  try { s = JSON.parse(raw); } catch { throw new TelegramError('INVALID_TEST_STATE'); }
  if (!s || s.version !== 1 || s.test !== SMOKE_ID || typeof s.attempt !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(s.attempt) || !Number.isFinite(s.startedAt) || s.startedAt <= 0) {
    throw new TelegramError('INVALID_TEST_STATE');
  }
  if (s.outcome) {
    const o = s.outcome;
    if (!['sent', 'unknown', 'rejected'].includes(o.kind) ||
        o.kind === 'sent' && (!Number.isSafeInteger(o.messageId) || o.messageId <= 0) ||
        o.kind === 'rejected' && (!Number.isInteger(o.code) || o.code < 400 || o.code >= 500 ||
          !Number.isFinite(s.retryAt) || s.retryAt! < s.startedAt)) throw new TelegramError('INVALID_TEST_STATE');
  }
  return s;
}
function hasCode(e: unknown, code: string) { return !!e && typeof e === 'object' && 'code' in e && e.code === code; }

/** Local smoke-test journal, independent of Reddit Redis and the RSS history.
 * No secret, title, chat ID or bot token is written. Keep this directory across
 * invocations; separate Codespaces do not share it.
 */
export class FileJournal implements DeliveryJournal {
  readonly directory: string;
  #root: string;
  #clock: () => number;
  constructor(root: string, target: Target, clock: () => number = Date.now) {
    const digest = createHash('sha256').update(`${SMOKE_ID}:${target.botId}:${target.chatId}`).digest('hex');
    this.#root = root;
    this.directory = join(root, digest);
    this.#clock = clock;
  }
  async #syncDirectory(directory = this.directory) {
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async #read(): Promise<State | undefined> {
    try { return decode(await readFile(join(this.directory, 'state.json'), 'utf8')); }
    catch (e) { if (hasCode(e, 'ENOENT')) return undefined; throw e; }
  }
  async #write(state: State) {
    decode(JSON.stringify(state));
    const temp = join(this.directory, `${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, join(this.directory, 'state.json'));
    await this.#syncDirectory();
  }
  async #unlock() { await unlink(join(this.directory, 'lock')); await this.#syncDirectory(); }
  async begin(): ReturnType<DeliveryJournal['begin']> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await this.#syncDirectory(dirname(this.#root));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.#syncDirectory(this.#root);
    const prior = await this.#read();
    if (prior?.outcome?.kind === 'sent') return { kind: 'already_sent', messageId: prior.outcome.messageId };
    if (prior && (!prior.outcome || prior.outcome.kind === 'unknown')) return { kind: 'blocked' };
    if (prior?.retryAt && prior.retryAt > this.#clock()) return { kind: 'cooldown' };
    const attempt = randomUUID();
    let lock;
    try { lock = await open(join(this.directory, 'lock'), 'wx', 0o600); }
    catch (e) { if (hasCode(e, 'EEXIST')) return { kind: 'busy' }; throw e; }
    try { await lock.writeFile(attempt); await lock.sync(); } finally { await lock.close(); }
    // Re-read after locking: another process may have completed between read
    // and lock acquisition. Never replace its successful/ambiguous attempt.
    const current = await this.#read();
    if (current && current.attempt !== prior?.attempt) {
      await this.#unlock();
      if (current.outcome?.kind === 'sent') return { kind: 'already_sent', messageId: current.outcome.messageId };
      return { kind: 'blocked' };
    }
    await this.#write({ version: 1, test: SMOKE_ID, attempt, startedAt: this.#clock() });
    return { kind: 'reserved', attempt };
  }
  async finish(attempt: string, outcome: SendOutcome) {
    const lock = await readFile(join(this.directory, 'lock'), 'utf8');
    const state = await this.#read();
    if (lock !== attempt || state?.attempt !== attempt || state.outcome) throw new TelegramError('TEST_RESERVATION_LOST');
    const retryAt = outcome.kind === 'rejected'
      ? this.#clock() + Math.max(60, outcome.retryAfter ?? 60) * 1000 : undefined;
    await this.#write({ ...state, outcome, ...(retryAt === undefined ? {} : { retryAt }) });
    await this.#unlock();
  }
}
