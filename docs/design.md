# Kalapana: Universal Tracker on the web

Kalapana runs Archipelago's Universal Tracker (UT) in the browser at `ut.ionium.us`. Players open a link, and the tracker connects to their room with no install. Python runs in the browser via Pyodide (WebAssembly).

This document proposes the architecture for the first production version. It builds on the spikes in `spikes/`, all of which passed in Node, headless Chrome 153 and Firefox 155. The live test ran against a pahoa room on `mw.ionium.us`.

## Summary

- **No server-side application code.** The app is static files: an HTML/JS shell, the Pyodide runtime, Archipelago (AP) bundles, and a catalog. The browser connects straight to room servers over `wss://`.
- **The container is a static file server.** It serves precompressed, content-hashed assets. Envoy terminates TLS in front of it.
- **GitLab CI does the real work.** It builds trimmed, precompiled AP bundles from the AP version the curated index targets, plus one bundle per world version. It records each world's datapackage checksum, so the browser can pick the right bundle from the room's `RoomInfo` alone.
- **Puna hands off with a URL fragment.** It passes the server address, slot and game in a link. During testing the room password rides along base64url-encoded. For launch it is fetched once from puna with a single-use token, so it never appears in a URL. See [Handoff from puna](#handoff-from-puna).
- **Main security concern: arbitrary code on a same-site origin.** An uploaded apworld is arbitrary Python. On any `*.ionium.us` host it could send credentialed requests to `mw.ionium.us` and `ap-lobby.ionium.us`, which use `SameSite=Lax` cookies without CSRF tokens. Testing on `ut.ionium.us` therefore excludes uploaded apworlds, and full launch moves to a separate registrable domain. See [Isolation and cookies](#isolation-and-cookies).

## What the spikes established

| Question | Result |
|---|---|
| Python runtime | Pyodide 0.29.x (Python 3.13). AP's `ModuleUpdate` rejects 3.14. |
| UT compatibility | The unmodified `tracker.apworld` runs behind a small Kivy-free bridge (`spikes/lib/ui_bridge.py`). |
| Correctness | In-logic lists match desktop UT exactly: TUNIC 107/114, Stardew 21/10/32 during live play. |
| Update latency | 2 to 6 ms per tracker update for both TUNIC and Stardew. |
| Networking | The browser `WebSocket` shim works against pahoa over TLS. `ws://` falls back to `wss://`. |
| Threads | Not available in Pyodide. An inline executor covers the one world that uses a thread pool at import. |
| Persistence | IDBFS and OPFS both survive a full browser restart in Chrome and Firefox. |
| Map tab | Poptracker packs render as an SVG overlay, matching desktop UT's colors. |
| Pyodide packages needed | Only `pyyaml` and `orjson` for core. `ssl`, `bsdiff4` and `jellyfish` are replaced by stubs. |

Bundle measurements (`spikes/06-bundle`), gzipped transfer sizes:

| Piece | Source | Precompiled (.pyc) |
|---|---|---|
| Pyodide runtime (wasm, JS, stdlib) | 5.4 MB | 5.4 MB |
| `pyyaml` + `orjson` wheels | 0.24 MB | 0.24 MB |
| AP core bundle (modules, vendored wheels, stubs) | 0.67 MB | 1.22 MB |
| TUNIC world | 0.13 MB | 0.26 MB |
| Stardew Valley world | 0.35 MB | 0.75 MB |
| Import time, TUNIC / Stardew | 0.72 s / 1.49 s | 0.43 s / 0.58 s |

**Recommendation: ship precompiled bundles.** A cold visit costs about 1 MB more, and the HTTP cache absorbs that after the first load. Every page load after that imports up to a second faster. A first visit downloads roughly 7 to 8 MB. After that, only the bundles for a newly tracked world are fetched.

## Architecture

```mermaid
flowchart LR
  puna["puna (mw.ionium.us)<br>room page"] -- "link with #fragment" --> shell
  subgraph browser["Player's browser"]
    shell["Shell page<br>ut.ionium.us"] -- "postMessage" --> runtime["Runtime worker<br>Pyodide + AP + UT"]
    shell <--> storage[("OPFS library<br>YAMLs, packs, apworlds")]
  end
  shell -- "static assets" --> server["kalapana container<br>static file server"]
  runtime -- "bundles" --> server
  runtime -- "wss://" --> room["pahoa room<br>mw.ionium.us:PORT"]
```

### Components

1. **Shell page.** Plain HTML and JS with no npm or build step, following puna's approach. It handles:
   - the connect form and parsing the handoff fragment;
   - the file library (YAMLs, poptracker packs, uploaded apworlds);
   - the tabs: Tracker, Map, Hints and Log;
   - asking the browser for persistent storage (`navigator.storage.persist()` only works on the page, not in a worker).
2. **Runtime worker.** A module Web Worker that loads Pyodide, unpacks the bundles, installs the bridge and runs UT. It exchanges JSON messages with the shell, as in `spikes/05-ui`.
3. **Bridge (`ui_bridge.py`).** It stands in for the Kivy widgets UT touches: tracker list, header labels, map markers, map image and `ui` object. It forwards their updates to the shell. Production changes from the spike:
   - send raw `JSONMessagePart` lists instead of AP's console text, which contains ANSI escapes, and render the colors in HTML;
   - flatten nested message lists (the `/explain` crash);
   - add the hints tab with UT's "In Logic" column, command autocomplete, map groups and location icons.
4. **Catalog and bundles.** Static files built by CI; see [Build pipeline](#build-pipeline).

### Session flow

1. **Open.** The shell reads the handoff fragment (`server`, `slot`, optional `game`), or the player fills in the form.
2. **Probe.** The shell opens a short-lived `wss://` connection and reads `RoomInfo`: `generator_version`, `games` and `datapackage_checksums`. If `game` wasn't provided and the room has more than one game, it sends a `Connect` with the `Tracker` tag to learn the slot's game from `Connected.slot_info`, then disconnects.
3. **Resolve.** The shell looks up the runtime version and the world bundle in `catalog.json` by the game's datapackage checksum. The catalog also says whether the world needs a YAML (it lacks `ut_can_gen_without_yaml`), whether it has a map tab that needs an external poptracker pack, and which extra Pyodide packages it needs.
4. **Collect files.** Anything required is asked for now: a YAML, or optionally a pack, from the library or an upload. UT requests files synchronously while it handles packets, so they must already be in place before connecting.
5. **Boot.** The worker loads Pyodide, the core bundle, the world bundle, UT and the files, then runs UT's context with the bridge.
6. **Connect.** UT connects and tracks. Everything after this point happens in UT; the shell only renders.

A room that no catalog entry matches still boots. The shell offers "upload the apworld for this game", with a warning that uploaded code is untrusted. If the checksum still doesn't match, UT reports it as it does on desktop.

## Build pipeline

GitLab CI in the same style as puna and the lobby: buildah, `:sha-<short>` tags, `:latest` from `main`, `:dev` from `ionium-dev`, and no deploy job.

**Pinned inputs**
- **AP source:** the tag named by the index's `archipelago_version` (currently 0.6.7). A rebuild follows the index.
- **Archipelago-index:** a commit, with `index.lock` providing the sha256 for each world version.
- **UT:** a `tracker.apworld` release URL plus sha256, pinned per AP version. It isn't in the index today; see open decision 3.
- **Pyodide:** a release (0.29.x) plus the sha256 of each file we host.

**Stages**
1. **fetch.** Download Pyodide's dist files and the few wheels we serve. Download each world version the build policy selects, verified against `index.lock`. Most index URLs are GitHub release assets, which CI can fetch but browsers can't (no CORS), so CI mirrors them.
2. **catalog.** In a Python 3.13 image with the AP source, import each world version natively and record:
   - its datapackage checksum and game name;
   - whether it sets `ut_can_gen_without_yaml` and has a `tracker_world` with an `external_pack_key`;
   - whether it imports anything Pyodide lacks (a native dependency, which marks it unsupported);
   - the extra Pyodide packages it needs (for example `requests` for four worlds, or `setuptools` for pokemon_emerald).
   Core worlds come from the AP source tree the same way.
3. **bundle.** Build the precompiled core bundle and one precompiled bundle per world version. This is `spikes/06-bundle/build_bundles.py`, extended to apworld inputs. Name every file by content hash and precompress it with brotli and gzip.
4. **image.** Stage the static tree, `catalog.json` and the shell into the image. Build and push with buildah.

**Which world versions to build** is a policy choice (open decision 2). Each version bundle is typically 0.1 to 1 MB, with outliers up to about 14 MB for asset-heavy manual worlds. Building every locked version is simplest. Building only versions a live room could use is smaller but needs input from the lobby or puna.

**Published layout**

```
/                          shell (index.html, app.js, app.css), no-cache
/catalog.json              runtime versions, checksum -> world bundle, flags; short cache
/runtime/pyodide-0.29.x/   Pyodide dist files and wheels; immutable
/ap/0.6.7/core.<hash>.zip  precompiled AP core + stubs + vendored pure wheels; immutable
/ap/0.6.7/tracker.<hash>.zip
/worlds/<world>/<version>.<hash>.zip
/healthz                   static file for probes
```

## Container and serving

- **Server:** a prebuilt static file server, so no application code. Recommendation: `static-web-server` (a single Rust binary). It serves precompressed `.br`/`.gz` variants, sets cache headers per path and runs non-root. The image can be `scratch` or `debian:13-slim` like puna's. nginx with `gzip_static` works too if you'd rather use something familiar.
- **Behind Envoy:** Envoy terminates TLS for `ut.ionium.us` and forwards plain HTTP to the pod. Envoy should not recompress the precompressed files.
- **Headers**
  - `Cache-Control: public, max-age=31536000, immutable` for hashed assets, `no-cache` for `index.html` and `catalog.json`.
  - `Content-Type: application/wasm` for `.wasm` (needed for streaming compilation).
  - `Content-Security-Policy`:
    - `script-src 'self' 'wasm-unsafe-eval'` (Pyodide needs wasm compilation);
    - `worker-src 'self'`;
    - `connect-src 'self' wss:` (rooms can be on any port or host);
    - `img-src 'self' blob: data:`;
    - `frame-ancestors 'none'`.
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
  - COOP/COEP are not needed: we don't use `SharedArrayBuffer` or threads.
- **Health:** `GET /healthz` returns a static file.
- **Resources:** static serving is tiny. Most of the image is world bundles.

**Is server-side code needed?** Not for the first version:
- rooms are reached directly over `wss://`;
- the catalog is built ahead of time;
- the handoff is a URL fragment;
- the player's files stay in their browser.

Two things would need a server later. Neither is required for puna rooms:
- **A `ws://`-to-`wss://` relay**, for third-party rooms without TLS. An https page can't open plain `ws://` connections. Pahoa rooms are always TLS.
- **An upload proxy or mirror** for apworlds that aren't in the index, if we ever want to fetch them by URL instead of asking the player to upload.

## Handoff from puna

Puna's room page gets a "Track in browser" link per slot. Everything travels in the URL **fragment**: it is never sent to any server, doesn't appear in Envoy logs, and isn't included in `Referer` headers. The shell reads the fragment, then removes it from the address bar with `history.replaceState` so it isn't copied along with the URL.

The fields that aren't secret:
- `v`: handoff format version.
- `server`: host and port (always `wss://` for pahoa rooms).
- `slot`: the player name.
- `game`: optional; it skips the second probe connection when the room has several games.

The room password is the only secret, and it is handled in two phases.

### Testing: base64url fragment

```
https://ut.ionium.us/#h=eyJ2IjoxLCJzZXJ2ZXIiOiJtdy5pb25pdW0udXM6NDUwMTIiLCJzbG90IjoiVHVuZXIiLCJwYXNzd29yZCI6Ii4uLiJ9
```

`h` is base64url-encoded JSON containing the fields above plus an optional `password`. The encoding only prevents casual reading, for example over a shoulder or in a screenshot. Anything with the URL can decode it: history, sync, a link pasted into chat, extensions. It is acceptable while testing, not for launch. Puna includes the password only when its patch policy would already reveal it to this user (the `wss://slot:pass@host:port` patch format).

### Launch: single-use handoff token

The password never appears in any URL:

1. Puna's link carries the non-secret fields plus `token`: a random, single-use value that expires after about 60 seconds. Puna stores it with the room and slot.
2. The shell sends `POST https://mw.ionium.us/api/handoff/redeem` with the token, `credentials: "omit"` and no cookies.
3. Puna returns `{server, slot, game, password}` and marks the token used. The endpoint allows CORS only from kalapana's origin.
4. The shell connects. A leaked or copied link is useless after one use or once it expires.

This keeps kalapana fully static and holds no secret shared with puna. The redemption endpoint isn't a CSRF risk: it uses no cookies, and its only side effect is consuming the token.

We considered a signed or encrypted redirect through kalapana server code. It was rejected because the redirect still ends in a URL containing the password, and it would add server code plus a secret shared between puna and kalapana.

### Other handoff rules

- **Known hosts only:** the shell auto-connects only to known room hosts (`mw.ionium.us`, `mw.ionium-dev.us`). A handoff naming any other server needs confirmation first, so a crafted link can't silently point the tracker at an attacker's server.
- **Link attributes:** puna links with `rel="noopener noreferrer"`.
- **No shared session:** kalapana never uses puna's cookies or login session.
- **YAMLs:** per-slot YAMLs aren't stored in puna. If the lobby later offers them, it would be through a separate single-use or capability URL with CORS, not a login session.

Puna needs the per-slot link and, for launch, the token table and redeem endpoint. That's a `HANDOFF.md` for puna once this design is approved.

## Isolation and cookies

**What's already safe.** Puna's `punasession` and the lobby's `session` cookies are host-only (no `Domain` attribute). The browser never sends them to `ut.ionium.us`, so nothing on kalapana's side can read them.

**The gap.** `ut.ionium.us`, `mw.ionium.us` and `ap-lobby.ionium.us` share the registrable domain `ionium.us`, so they are the same site. Any script running on `ut.ionium.us` can send `fetch("https://mw.ionium.us/...", {method: "POST", credentials: "include"})`, and the browser attaches the Lax cookies. The script can't read the response without CORS, but the action still happens. Puna and the lobby rely on `SameSite=Lax` for CSRF protection and don't check `Origin` or `Sec-Fetch-Site`. Kalapana would run arbitrary Python on that origin as soon as it accepts uploaded apworlds.

Browsers draw these boundaries at the site (scheme plus registrable domain), not the hostname. So a different subdomain of `ionium.us` doesn't help:
- `SameSite` cookies are attached to requests between any `*.ionium.us` hosts.
- Code on any subdomain can set `Domain=ionium.us` cookies that reach puna and the lobby ("cookie tossing").
- Chrome's per-site process isolation may put same-site subdomains in one process.

**Plan**
1. **Testing on `ut.ionium.us`.** Ship without uploaded apworlds. Curated index worlds, core worlds and UT are the only code that runs. YAMLs and poptracker packs are data, not code.
2. **Puna and the lobby reject state-changing requests that aren't from their own origin.** Reject a POST, PUT, PATCH or DELETE unless `Sec-Fetch-Site` is `same-origin` (or `none`), falling back to an `Origin` check. A request from another `ionium.us` subdomain arrives as `same-site` and is refused. This is a small guard in each app, worth doing regardless of kalapana.
3. **Full launch on a separate registrable domain.** Kalapana moves to its own domain before launch. Requests from it to `ionium.us` are cross-site, so `SameSite=Lax` cookies are withheld even from an app that lacks the guard. It also can't toss `ionium.us` cookies. Uploaded apworlds can be enabled from this point. The shell and runtime share the new origin, so no iframe split is needed.
4. **Handoff origin.** Puna's link target, the redeem endpoint's CORS allowlist and kalapana's known-hosts list move with the domain change. Library storage is per origin and doesn't carry over from `ut.ionium.us`; that's acceptable for data created during testing.

## Storage

- **Library.** The player's YAMLs, poptracker packs and (later) uploaded apworlds live in OPFS, mounted into Pyodide with `mountNativeFS`. IDBFS is the fallback if a browser lacks the OPFS features Pyodide needs.
- **Persistent storage.** The shell asks for it at first upload. The spikes measured quotas of about 10 GB (Chrome) and 4.8 GB (Firefox).
- **Export and import** of the whole library as a zip, because Safari can evict storage.
- **UT state.** UT's per-seed data (ignored locations, manual items) and `host.yaml` options persist in the same storage.
- **Cache.** Bundles are not stored in the library; the HTTP cache handles them.

## Versions

- **Runtime version.** Each runtime is keyed by AP version and built from the index's `archipelago_version`. `catalog.json` lists every runtime still served and maps a room's `generator_version` to the best one. After an index bump, keep the previous runtime for a while so long-running rooms keep working.
- **UT version.** UT is pinned per AP version and checked against its `minimum_ap_version`.
- **World versions.** These are resolved by datapackage checksum, never by guessing from the room.

## Known limitations

- **Native dependencies.** Worlds that need native packages can't be tracked (for example soe `pyevermizer`, zillion, kh2, tww, jak). The catalog marks them unsupported.
- **Rooms without TLS** can't be reached until a relay exists.
- **Safari** is untested: storage eviction and OPFS behavior need checking on a Mac or iOS device.
- **Poptracker packs** are supplied by the player (upload or library). Packs contain game art, so kalapana doesn't host them.
- **Randomized YAML options.** UT's own limitation still applies: a YAML with randomized options gives wrong logic unless the player sets the rolled values.

## Open decisions

1. **World version build policy:** build every locked version in `index.lock`, the latest N per world, or only versions the lobby's room manifests reference?
2. **UT distribution:** add `tracker.apworld` to Archipelago-index (with a lock hash), or pin it in kalapana's CI?
3. **Handoff token details:** token lifetime (60 seconds proposed), and whether redeeming requires the room to be running.
4. **Guard in puna and lobby:** approve the `Sec-Fetch-Site` check as HANDOFFs to both repos?

Decided: test on `ut.ionium.us` without uploaded apworlds, and move to a separate registrable domain before full launch. The password travels as a base64url fragment during testing and by single-use token for launch.

## Milestones

1. **Build pipeline:** core and world bundles from AP 0.6.7 and the index, `catalog.json`, container image and CI. Verify TUNIC and Stardew against a pahoa room.
2. **Shell and runtime:** connect flow, probe and resolve, library with OPFS, Tracker/Map/Hints/Log tabs, JSON message rendering. Harden the bridge.
3. **Puna handoff (testing):** the per-slot link with the base64url fragment, plus the request guards in puna and the lobby.
4. **Launch:** move to the separate domain, add the single-use handoff token, enable uploaded apworlds, library export/import, and a Safari pass.
5. **Later:** a relay if third-party `ws://` rooms matter.
