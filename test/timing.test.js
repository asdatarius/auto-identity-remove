/**
 * test/timing.test.js
 *
 * Unit tests for jitterSleep() in lib/timing.js.
 *
 * These used to assert timing by measuring wall-clock:
 *
 *   const start = Date.now();
 *   await jitterSleep(0, 0);
 *   assert.ok(Date.now() - start < 100, ...);
 *
 * which made them flaky, and for a reason worth spelling out: on the fast path
 * jitterSleep returns Promise.resolve(), so the awaited continuation is a
 * microtask and cannot be delayed by the event loop at all. What the elapsed
 * figure actually measures is whether the OS descheduled this process between
 * the two Date.now() calls. Under `node --test`, ~28 test files run in parallel
 * on a CI runner's 2-4 cores, so that is a real risk: measured on a machine at
 * 4x oversubscription, an immediate `await Promise.resolve()` was observed taking
 * 90ms against the 100ms bound above. Ten milliseconds of headroom on a quantity
 * that has nothing to do with the code under test.
 *
 * The property these tests actually care about is structural, not temporal:
 * does jitterSleep schedule a timer, and if so for how long? So they now observe
 * setTimeout directly. That is deterministic, load-independent, instant, and it
 * checks strictly more than the old version did (the file header used to claim a
 * delay-range test that did not exist).
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TIMING = require.resolve('../lib/timing');

// isFast is captured at module load, so env changes need a fresh copy.
function loadTiming() {
  delete require.cache[TIMING];
  return require('../lib/timing');
}

/**
 * Run `fn` with global.setTimeout replaced by a recording stub.
 *
 * The stub still fires the callback (synchronously via queueMicrotask) so the
 * promise under test resolves; we only care that a timer was requested and with
 * what delay.
 *
 * @returns {Promise<{ calls: number[], value: unknown }>} calls = delays requested
 */
async function recordingTimers(fn) {
  const realSetTimeout = global.setTimeout;
  const calls = [];
  global.setTimeout = (cb, delay) => {
    calls.push(delay);
    queueMicrotask(cb);
    return { unref() {} };
  };
  try {
    const value = await fn();
    return { calls, value };
  } finally {
    global.setTimeout = realSetTimeout;
  }
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.TURBO;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  delete process.env.TURBO;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  delete require.cache[TIMING];
});

// ── Fast paths: no timer at all ───────────────────────────────────────────────

test('NODE_ENV=test schedules no timer, however large the range', async () => {
  process.env.NODE_ENV = 'test';
  const { jitterSleep } = loadTiming();
  const { calls } = await recordingTimers(() => jitterSleep(5000, 10000));
  assert.deepEqual(calls, [], 'the fast path must not schedule a timer');
});

test('TURBO=1 schedules no timer, however large the range', async () => {
  process.env.TURBO = '1';
  const { jitterSleep } = loadTiming();
  const { calls } = await recordingTimers(() => jitterSleep(5000, 10000));
  assert.deepEqual(calls, [], 'the fast path must not schedule a timer');
});

test('TURBO=1 wins even when NODE_ENV is something else', async () => {
  process.env.NODE_ENV = 'production';
  process.env.TURBO = '1';
  const { jitterSleep } = loadTiming();
  const { calls } = await recordingTimers(() => jitterSleep(5000, 10000));
  assert.deepEqual(calls, []);
});

test('the fast path still resolves, and to undefined', async () => {
  process.env.TURBO = '1';
  const { jitterSleep } = loadTiming();
  const { value } = await recordingTimers(() => jitterSleep(0, 0));
  assert.equal(value, undefined);
});

test('jitterSleep(0, 0) schedules no timer on the fast path', async () => {
  process.env.TURBO = '1';
  const { jitterSleep } = loadTiming();
  const { calls } = await recordingTimers(() => jitterSleep(0, 0));
  assert.deepEqual(calls, []);
});

// ── Real path: exactly one timer, delay inside the range ──────────────────────

test('with no fast-path env, exactly one timer is scheduled', async () => {
  const { jitterSleep } = loadTiming();
  const { calls } = await recordingTimers(() => jitterSleep(400, 800));
  assert.equal(calls.length, 1, 'one sleep should mean one timer');
});

test('the scheduled delay lies within the requested range', async () => {
  const { jitterSleep } = loadTiming();
  for (let i = 0; i < 200; i++) {
    const { calls } = await recordingTimers(() => jitterSleep(1200, 2200));
    assert.ok(
      calls[0] >= 1200 && calls[0] <= 2200,
      `delay ${calls[0]} outside [1200, 2200]`,
    );
  }
});

test('the range is inclusive at both ends', async () => {
  // Math.floor(random * (max - min + 1)) + min is the classic off-by-one site:
  // drop the +1 and max is unreachable; use ceil and it overshoots. Pin both
  // boundaries by driving Math.random directly instead of sampling and hoping.
  const { jitterSleep } = loadTiming();
  const realRandom = Math.random;
  try {
    Math.random = () => 0;
    let { calls } = await recordingTimers(() => jitterSleep(400, 800));
    assert.equal(calls[0], 400, 'random=0 must produce exactly the minimum');

    // The largest double below 1.
    Math.random = () => 1 - Number.EPSILON / 2;
    ({ calls } = await recordingTimers(() => jitterSleep(400, 800)));
    assert.equal(calls[0], 800, 'random just below 1 must produce exactly the maximum');
  } finally {
    Math.random = realRandom;
  }
});

test('a zero-width range schedules exactly that delay', async () => {
  // lib/hibp.js calls jitterSleep(1500, 1500) for a fixed pause.
  const { jitterSleep } = loadTiming();
  const { calls } = await recordingTimers(() => jitterSleep(1500, 1500));
  assert.deepEqual(calls, [1500]);
});

test('jitterSleep(0, 0) on the real path schedules a 0ms timer', async () => {
  // Documents the actual behaviour: outside the fast path a timer IS scheduled,
  // it just has zero delay. No production caller passes (0, 0).
  const { jitterSleep } = loadTiming();
  const { calls } = await recordingTimers(() => jitterSleep(0, 0));
  assert.deepEqual(calls, [0]);
});

test('the real path resolves to undefined', async () => {
  const { jitterSleep } = loadTiming();
  const { value } = await recordingTimers(() => jitterSleep(10, 20));
  assert.equal(value, undefined);
});

test('every production call site uses a valid range', async () => {
  // min > max would make (max - min + 1) non-positive and yield a delay below
  // min, i.e. a silently-skipped pause.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = ['lib/broker-runner.js', 'lib/serp-scan.js', 'lib/hibp.js', 'lib/forms.js'];
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/jitterSleep\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
      const [min, max] = [Number(m[1]), Number(m[2])];
      assert.ok(min <= max, `${f}: jitterSleep(${min}, ${max}) has min > max`);
      assert.ok(min >= 0, `${f}: jitterSleep(${min}, ${max}) has a negative minimum`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'precondition: production code should call jitterSleep');
});
