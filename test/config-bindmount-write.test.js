/**
 * test/config-bindmount-write.test.js
 *
 * Every durable write in lib/config.js is tmp-file + rename, which is the right
 * thing on a normal filesystem. It is also the one operation that cannot work
 * against a Docker single-file bind mount: the kernel holds the mount on that
 * inode, so rename() onto it returns EBUSY. Reproduced in the shipped image:
 *
 *     $ docker run -v "$PWD/state.json:/app/state.json" ... node -e '...'
 *     mounted? true
 *     RENAME_FAILED: EBUSY
 *     DIRECT_WRITE_OK
 *
 * README.md and docker-compose.yml both documented exactly that file mount, so
 * on Linux and on a NAS every state write threw and nothing was ever persisted:
 * no lastSuccess, no cooldowns, so every scheduled run resubmitted every broker
 * from scratch. Mounting the directory instead is the real fix (and is what the
 * docs now say) but the code must not silently lose state for anyone who file
 * mounts anyway.
 *
 * Fallback contract: if the rename fails because the target is a mount point or
 * lives on a different device, write in place instead. That trades the atomicity
 * guarantee for actually persisting, which is the correct trade - the .bak copy
 * still covers the truncation case that atomicity was protecting against.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _renameOrRewrite } = require('../lib/config');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-bindmount-'));
}

test('_renameOrRewrite is exported for the durable-write paths', () => {
  assert.equal(typeof _renameOrRewrite, 'function');
});

test('normal case: renames into place and removes the temp file', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  const tmp = target + '.tmp';
  fs.writeFileSync(target, 'old');
  fs.writeFileSync(tmp, 'new');

  _renameOrRewrite(tmp, target, 'new');

  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(fs.existsSync(tmp), false, 'temp file must not be left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EBUSY (bind-mounted target): falls back to an in-place write', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  const tmp = target + '.tmp';
  fs.writeFileSync(target, 'old');
  fs.writeFileSync(tmp, 'new');

  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; };
  try {
    _renameOrRewrite(tmp, target, 'new');
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(fs.readFileSync(target, 'utf8'), 'new', 'state must still be persisted');
  assert.equal(fs.existsSync(tmp), false, 'temp file must be cleaned up after the fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EXDEV (target on another device): falls back to an in-place write', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, 'payload');

  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EXDEV: cross-device link'); e.code = 'EXDEV'; throw e; };
  try {
    _renameOrRewrite(tmp, target, 'payload');
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(fs.readFileSync(target, 'utf8'), 'payload');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unrelated rename error is NOT swallowed', () => {
  // EACCES means a genuine permission problem. Silently writing in place would
  // hide a misconfigured mount; the caller must see it.
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, 'payload');

  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
  try {
    assert.throws(() => _renameOrRewrite(tmp, target, 'payload'), /EACCES/);
  } finally {
    fs.renameSync = realRename;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveState persists when the target cannot be renamed onto', () => {
  // End to end through the real saveState, with rename forced to fail the way a
  // bind mount makes it fail.
  const cfg = require('../lib/config');
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, JSON.stringify({ optOuts: {} }));

  cfg.setTestStatePath(target);
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('state.json')) {
      const e = new Error('EBUSY: resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    }
    return realRename(from, to);
  };
  try {
    cfg.recordSuccess('ExampleBroker', 'submitted');
    cfg.saveState();
  } finally {
    fs.renameSync = realRename;
    cfg.setTestStatePath(null);
  }

  const persisted = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.ok(
    persisted.optOuts && persisted.optOuts.ExampleBroker,
    'recordSuccess + saveState must survive a bind-mounted state.json',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
