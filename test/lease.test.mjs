import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Lease } from "../server/lease.mjs";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "kalapana-lease-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("only one holder at a time", () =>
  withDir(async (dir) => {
    const path = join(dir, "refresh.lease");
    const first = await Lease.acquire(path, "pod-a");
    assert.ok(first);
    assert.equal(await Lease.acquire(path, "pod-b"), null);
    await first.release();
    const second = await Lease.acquire(path, "pod-b");
    assert.ok(second);
    await second.release();
  }));

test("an expired lease can be taken over, and the old holder notices", () =>
  withDir(async (dir) => {
    const path = join(dir, "refresh.lease");
    const stale = await Lease.acquire(path, "pod-a", { ttlMs: 60_000 });
    // Simulate a holder that stopped renewing long ago.
    const content = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...content, expires: Date.now() - 1 }));

    const taker = await Lease.acquire(path, "pod-b");
    assert.ok(taker);
    assert.equal(JSON.parse(await readFile(path, "utf8")).owner, taker.owner);

    await stale.release();
    assert.equal(JSON.parse(await readFile(path, "utf8")).owner, taker.owner, "the old holder must not delete the new lease");
    await taker.release();
  }));

test("concurrent takeovers of an expired lease produce a single holder", () =>
  withDir(async (dir) => {
    const path = join(dir, "refresh.lease");
    await writeFile(path, JSON.stringify({ owner: "dead-pod", expires: Date.now() - 1 }));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => Lease.acquire(path, `pod-${i}`)));
    const holders = results.filter(Boolean);
    assert.equal(holders.length, 1);
    await holders[0].release();
  }));
