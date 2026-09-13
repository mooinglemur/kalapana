// Downloaded datapackages kept between sessions in IndexedDB, keyed by game and checksum, with the least
// recently used evicted past a size cap.
//
// Only the page uses this cache, but world code in the worker (uploaded apworlds included) shares the
// origin's IndexedDB and could plant or alter entries. A client can't recompute a datapackage checksum,
// since servers don't send the name groups it covers, so each entry is signed with an HMAC instead. The
// key lives in localStorage, which workers can't reach, and an entry that fails the check is ignored.
const DB_NAME = "kalapana";
const TEXTS = "datapackages";
const ENTRIES = "entries";
const KEY_STORAGE = "kalapana.datapackage-key";
// Counted in UTF-16 code units, which is close enough to bytes for a cap.
const MAX_SIZE = 100 * 1024 * 1024;

const keyOf = (game, checksum) => `${game} ${checksum}`;
const signedBytes = (game, checksum, text) => new TextEncoder().encode(`${game}\n${checksum}\n${text}`);

function settled(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction) {
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
  // Awaited later; this keeps an early failure from being reported as unhandled first.
  done.catch(() => {});
  return done;
}

let database = null;
function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(TEXTS);
      request.result.createObjectStore(ENTRIES, { keyPath: "key" }).createIndex("usedAt", "usedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

let signingKey = null;
function key() {
  signingKey ??= (async () => {
    let encoded = localStorage.getItem(KEY_STORAGE);
    if (!encoded) {
      encoded = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      localStorage.setItem(KEY_STORAGE, encoded);
    }
    const raw = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  })();
  return signingKey;
}

// checksums: {game: checksum}. Returns the verified texts by game, and the games whose entries failed
// the check. When storage or crypto is unavailable, nothing is cached and everything downloads.
export async function loadDatapackages(checksums) {
  const found = {};
  const rejected = [];
  try {
    const signing = await key();
    // WebCrypto is asynchronous and would let a transaction commit mid-loop, so read first, then verify.
    const read = (await open()).transaction([TEXTS, ENTRIES]);
    const readDone = finished(read);
    const candidates = [];
    for (const [game, checksum] of Object.entries(checksums)) {
      const entryKey = keyOf(game, checksum);
      const entry = await settled(read.objectStore(ENTRIES).get(entryKey));
      const text = entry && (await settled(read.objectStore(TEXTS).get(entryKey)));
      if (typeof text === "string") candidates.push({ game, checksum, entry, text });
    }
    await readDone;

    const verified = [];
    for (const { game, checksum, entry, text } of candidates) {
      const valid = entry.mac instanceof ArrayBuffer
        && (await crypto.subtle.verify("HMAC", signing, entry.mac, signedBytes(game, checksum, text)));
      if (valid) {
        found[game] = text;
        verified.push(entry);
      } else {
        rejected.push(game);
      }
    }
    if (verified.length) {
      const touch = (await open()).transaction(ENTRIES, "readwrite");
      const touchDone = finished(touch);
      for (const entry of verified) touch.objectStore(ENTRIES).put({ ...entry, usedAt: Date.now() });
      await touchDone;
    }
  } catch {
    // Whatever was verified before the failure is still good.
  }
  return { found, rejected };
}

export async function saveDatapackage(game, checksum, text) {
  try {
    const mac = await crypto.subtle.sign("HMAC", await key(), signedBytes(game, checksum, text));
    const transaction = (await open()).transaction([TEXTS, ENTRIES], "readwrite");
    const done = finished(transaction);
    const entryKey = keyOf(game, checksum);
    transaction.objectStore(TEXTS).put(text, entryKey);
    transaction.objectStore(ENTRIES).put({ key: entryKey, game, checksum, size: text.length, usedAt: Date.now(), mac });
    const entries = await settled(transaction.objectStore(ENTRIES).index("usedAt").getAll());
    let total = 0;
    for (const entry of entries.reverse()) {
      total += entry.size;
      if (total > MAX_SIZE) {
        transaction.objectStore(TEXTS).delete(entry.key);
        transaction.objectStore(ENTRIES).delete(entry.key);
      }
    }
    await done;
  } catch {
    // Not saved, so it downloads again next time.
  }
}
