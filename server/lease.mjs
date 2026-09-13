// A renewable lease on a lock file in the shared data directory, so only one pod processes apworlds
// at a time. Creation uses link(), which is atomic on CephFS and never exposes a half-written file.
// If the holder dies, another pod may take over once the lease has expired.
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { uniqueSuffix } from "./fsutil.mjs";
import { log } from "./log.mjs";

const DEFAULT_TTL_MS = 90_000;

async function readLeaseFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    // Unreadable content is treated as expired so a corrupt file can't block refreshes forever.
    if (err instanceof SyntaxError) return { owner: null, expires: 0 };
    throw err;
  }
}

export class Lease {
  #path;
  #ttlMs;
  #timer = null;
  owner;
  lost = false;

  constructor(path, owner, ttlMs) {
    this.#path = path;
    this.owner = owner;
    this.#ttlMs = ttlMs;
  }

  // Resolves to a Lease, or null when another live holder has it.
  static async acquire(path, pod, { ttlMs = DEFAULT_TTL_MS } = {}) {
    const lease = new Lease(path, `${pod}-${uniqueSuffix()}`, ttlMs);
    if (await lease.#create()) return lease.#started();

    const current = await readLeaseFile(path);
    if (!current || current.expires > Date.now()) return null;

    // Move the expired lock aside. Only one contender's rename can succeed.
    const aside = `${path}.expired-${uniqueSuffix()}`;
    try {
      await rename(path, aside);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    const moved = await readLeaseFile(aside);
    if (moved?.owner !== current.owner || moved?.expires !== current.expires) {
      // The lock changed hands between our read and the rename, so put the live lease back.
      await link(aside, path).catch(() => {});
      await unlink(aside).catch(() => {});
      return null;
    }
    await unlink(aside).catch(() => {});
    log(`taking over expired refresh lease from ${current.owner}`);
    return (await lease.#create()) ? lease.#started() : null;
  }

  async #create() {
    const temp = `${this.#path}.new-${uniqueSuffix()}`;
    await writeFile(temp, this.#content());
    try {
      await link(temp, this.#path);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  #content() {
    return JSON.stringify({ owner: this.owner, expires: Date.now() + this.#ttlMs, renewedAt: new Date().toISOString() });
  }

  #started() {
    this.#timer = setInterval(() => this.#renew().catch((err) => log("lease renewal failed:", err)), this.#ttlMs / 3);
    this.#timer.unref();
    return this;
  }

  async #renew() {
    if (this.lost) return;
    const current = await readLeaseFile(this.#path);
    if (current?.owner !== this.owner) {
      this.lost = true;
      clearInterval(this.#timer);
      log("refresh lease was lost to another pod");
      return;
    }
    const temp = `${this.#path}.renew-${uniqueSuffix()}`;
    await writeFile(temp, this.#content());
    await rename(temp, this.#path);
  }

  async release() {
    clearInterval(this.#timer);
    if (this.lost) return;
    this.lost = true;
    const current = await readLeaseFile(this.#path);
    if (current?.owner === this.owner) await unlink(this.#path).catch(() => {});
  }
}
