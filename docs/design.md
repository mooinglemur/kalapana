# Kalapana: Universal Tracker on the web

Kalapana runs Archipelago's Universal Tracker (UT) in the browser at `ut.ionium.fyi`. Players open a link, and the tracker connects to their room with no install. Python runs in the browser via Pyodide (WebAssembly).

This document describes the architecture of the test instance. It builds on the spikes in `spikes/`, all of which passed in Node, headless Chrome 153 and Firefox 155. The live test ran against a pahoa room on `mw.ionium.us`. For operating details (configuration, endpoints, development), see the README.

## Summary

- **The browser does the tracking.** The page reads the room's datapackage checksums, loads the matching world bundle, and runs the unmodified `tracker.apworld` in a Web Worker. Game data never passes through kalapana's server.
- **The server keeps a catalog of world bundles.** A small Node service (no npm dependencies) fetches the curated Archipelago-index at startup and when an admin POSTs `/admin/refresh`. It downloads every locked apworld version and analyzes each new one. It then publishes `catalog.json`, which maps each game and datapackage checksum to a precompiled bundle.
- **Apworld analysis is sandboxed.** Analyzing an apworld means importing it, which runs arbitrary Python. Each import runs in a child Node process with Pyodide under Node's permission model: no network, no child processes, no environment, and file writes only in its own job directory.
- **Several pods share one data directory.** CephFS in production. A renewable lease file ensures only one pod processes apworlds at a time; everything else is atomic writes.
- **The image pins its inputs.** Archipelago (matching the index's `archipelago_version`), Pyodide, UT and a few wheels are all pinned by sha256. GitLab CI builds it with buildah, like puna.

## What the spikes established

| Question | Result |
|---|---|
| Python runtime | Pyodide 0.29.x (Python 3.13). AP's `ModuleUpdate` rejects 3.14. |
| UT compatibility | The unmodified `tracker.apworld` runs behind a small Kivy-free bridge. |
| Correctness | In-logic lists match desktop UT exactly: TUNIC 107/114, Stardew 21/10/32 during live play. |
| Update latency | 2 to 6 ms per tracker update for TUNIC and Stardew. |
| Networking | A browser `WebSocket` shim works against pahoa over TLS. |
| Threads | Not available in Pyodide. An inline executor covers the world that uses a thread pool at import. |
| Persistence | IDBFS and OPFS both survive a full browser restart in Chrome and Firefox. |
| Packages | Core needs only `pyyaml`. `bsdiff4`, `jellyfish` and `ModuleUpdate` are replaced by stubs, and so is `ssl` unless a world uses `requests`, in which case Pyodide's real `ssl` is loaded. |
| Bundles | Precompiled `.pyc` bundles cost about 1 MB more on a cold load but import up to a second faster. |
| Sandbox | Under the analyzer's permissions, host reads, writes outside the job, processes, workers and network are all denied, even from code that reaches Node's `process`. |

## Architecture

```mermaid
flowchart LR
  index["Archipelago-index<br>(GitHub tarball)"] --> refresh
  apworlds["apworld release URLs"] --> refresh
  subgraph pod["kalapana pods"]
    http["HTTP server"]
    refresh["Refresh pipeline<br>(lease holder only)"] --> sandbox["Analyzer child process<br>Pyodide, no network"]
  end
  refresh <--> data[("Shared data dir<br>CephFS")]
  http <--> data
  subgraph browser["Player's browser"]
    page["Page"] -- "postMessage" --> worker["Worker<br>Pyodide + AP + UT"]
  end
  page -- "catalog, bundles" --> http
  worker -- "runtime, bundles" --> http
  page -- "probe wss://" --> room["pahoa room"]
  worker -- "wss://" --> room
```

### Server

- **HTTP** (`server/http.mjs`) serves:
  - the web app;
  - the vendored Pyodide runtime at `/runtime/pyodide-<version>/`;
  - core and world bundles at `/bundles/...`, named by content key and immutable;
  - `catalog.json`;
  - health endpoints and the admin endpoints.

  Text assets are compressed with brotli or gzip on first request and cached in memory. Zips are served as-is.
- **Refresh pipeline** (`server/refresh.mjs`). Any pod can request a refresh; it leaves a request file in the data directory. The pod holding the lease processes requests until none remain:
  1. **Core bundle:** build it if the current key has none. The key covers the pinned inputs and kalapana's runtime and analyzer code.
  2. **Tracker:** analyze the pinned `tracker.apworld`, then build the pinned `tracker_addons.apworld` against it. The addons are optional: if they fail, the failure is recorded and the catalog has no `trackerAddons`.
  3. **Index:** download the tarball and parse it in the sandbox with `tomllib`. Refuse to continue if its `archipelago_version` differs from the image's.
  4. **Resolve versions** with the lobby's rules: skip disabled worlds, take supported worlds from the AP source, and map each version to a `local` file, its own `url`, or `default_url` with `{{version}}` substituted.
  5. **Download** anything missing, verifying the sha256 from `index.lock` when present. Store files as `apworlds/<sha256>.apworld`.
  6. **Analyze** every apworld without a cached result.
  7. **Publish** `catalog.json` and `last-refresh.json`, the summary with failures.
- **Analyzer** (`server/sandbox.mjs`, `analyzer/`). Each task is a child `node --permission` process running Pyodide:
  - **`build_core`** builds `core.zip` (precompiled) and `core-src.zip` (sources, for the analyzer), then smoke-tests importing `worlds`, `CommonClient` and `Generate`.
  - **`analyze_world`** imports one world alone. It records every registered game's datapackage checksum, whether UT needs a YAML (`ut_can_gen_without_yaml`), whether UT is disabled, whether the map needs an external poptracker pack, and which Pyodide packages the world imported. It then writes a reproducible precompiled bundle.
  - **`analyze_addon`** builds Universal Tracker Addons, which registers extra tracker commands (`/next_progression`, `/get_depth`, `/nearest_locations`, `/glp`, `/get_regions`) rather than World classes. It unpacks the tracker's bundle first, since the addons import `worlds.tracker`, imports `worlds.tracker_addons` directly, and writes a precompiled bundle. Its cache key covers the addons file, the tracker build and this task. World analyses never load the addons, so neither the addons input nor this task is part of their key, and pinning a new addons release rebuilds only the addons.
- **Caching.** Completed analyses, including failures, are cached under a key that combines the apworld sha256 with a hash of the analyzer's context: the pinned inputs, the analyzer tasks and the stubs it imports. Crashes and timeouts aren't cached, so they are retried. Changing the analyzer therefore retries earlier failures, and bundle URLs change with it. Changing browser-only modules (the bridge and the WebSocket shim) rebuilds only the core bundle.

### Browser

- **Page** (`web/app.mjs`):
  1. Load `catalog.json`.
  2. On Connect, open a short `wss://` probe and read `RoomInfo`. If the room has more than one game, send a tracker `Connect` to learn the slot's game from `Connected.slot_info`. A refused slot or password is reported here.
  3. Choose the newest catalog entry whose checksum matches the room's checksum for that game.
  4. If the entry needs a YAML, require one; if its map needs an external pack, offer an optional upload.
  5. Start the worker.

  The page follows puna's look, with its light, dark and system theme selector. Server, slot and password are kept in localStorage so a reload doesn't clear them. The last 10 distinct combinations that connected are offered in a Recent menu.

  While a tracker runs, Connect becomes Disconnect. Disconnecting terminates the worker, so no Python state, uploaded file or map image carries over to the next room, slot or game, and the next Connect boots a fresh worker (about 2 seconds with the runtime cached). Picking a different Recent entry while tracking disconnects and connects to it; while idle it only fills the fields. A room check still in flight is ignored if the details change before it answers.

  **Using my apworld.** The page always offers "Use my apworld…", to the right of Recent. When the catalog matches the room, the player can ignore it; otherwise it is the way forward. A chosen file takes precedence over the catalog, so a player can track with a newer apworld whose datapackage matches but whose logic differs. The choice survives edits to the connection details and is cleared by picking another Recent connection, which is usually another game. Choosing a file checks the room once a server and slot are filled in, and removing one after a room check goes back to the catalog; either leaves a running tracker first: the worker loads the runtime and the file, and `world_info.inspect_upload` (the same unpacking and description code the analyzer uses) reports its worlds. The page accepts it only if one of those worlds is the slot's game with the room's datapackage checksum, then asks for a YAML or pack as usual, and the same worker goes on to track. Every vendored Pyodide package is loaded, since an upload hasn't been analyzed. `spikes/07-kalapana/upload.mjs` covers a matching apworld (whether or not the catalog also matches), the catalog without an apworld, the wrong game, a changed datapackage, a malformed archive and a CSP probe.

  When several catalog versions share the room's checksum, the page takes the newest. The server sorts each game's versions newest first, comparing each dot-separated piece as a number as AP does, with semver prerelease precedence as the tie-breaker and build metadata ignored.

  The gear menu has one saved option, streamer mode. It hides the room's port in the address field (except while the field is being edited), the status line and the Recent menu. The log is masked on a best-effort basis: anything shaped like `host:port`.

  The log keeps its most recent 2000 lines, on the page and in memory. When older lines are dropped, a reader scrolled back through the log keeps their place.

  **Name suggestions.** After `!hint`, `!hint_location`, `!getitem`, `/explain` or `/get_logical_path` and a space, the command box lists matching names, prefix matches first, and Tab (or Enter after choosing with the arrow keys) completes one. When the catalog loads Tracker Addons, so do its `/glp`, `/nearest_locations` and `/get_regions`. The bridge sends each list once per generated multiworld, matching what the command itself accepts: item names and groups, location names and groups, item names, the generated world's locations and regions, those plus its entrances for `/get_logical_path` and `/glp`, and its regions for `/nearest_locations` and `/get_regions`.

  **Datapackage cache.** CommonClient caches downloaded datapackages in a cache directory, which in the worker is memory that ends with the session. Instead, the page owns a cache in IndexedDB (`web/datapackage-cache.mjs`), keyed by game and checksum, with the least recently used evicted past 100 MB.
  - **Starting a session:** while the worker boots, the page loads the room's other games from the cache, and downloads the rest from the room with `GetDataPackage`, which needs no login. It hands them to `runtime/datapackage_cache.py`, which answers AP's load function, and saves the downloads.
  - **Integrity:** world code in the worker, including uploaded apworlds, can write to the origin's IndexedDB. A client can't recompute a datapackage checksum, because servers don't send the item and location name groups it covers. So each entry is signed with an HMAC whose key is kept in localStorage, which workers can't reach. An entry that fails the check is ignored and downloaded again.
  - **Checked by** `spikes/07-kalapana/datapackage-cache.mjs`: the first download, the reuse after a reload, and a tampered entry. `spikes/07-kalapana/switch.mjs` checks this.
- **Worker** (`web/worker.mjs`):
  1. Load Pyodide from kalapana and the packages the entries list.
  2. Unpack the core, tracker, tracker addons (when the catalog has them) and world bundles at `/`, and place the uploaded files.
  3. Run `kalapana_boot.prepare()` and install the WebSocket shim.
  4. Start the bridge and connect UT.
- **Bridge** (`runtime/ui_bridge.py`). It stands in for the Kivy widgets UT touches: tracker list, header labels, map markers and images, and the `ui` object. It sends their updates to the page:
  - nothing while an addon command runs. `/next_progression` updates the tracker once per progression item with that item pretend-collected, so the bridge holds back tracker lines, labels, markers and timings until the command finishes, then sends one real update;
  - server text as Kivy-style `[color=name]` markup, not ANSI escapes. The page maps each name to a CSS token with light and dark values;
  - nested message lists from `/explain` flattened;
  - the startup generation skipped when no YAML was supplied, since UT regenerates YAML-less worlds on connect;
  - connection state, shown as a dot and a sentence as on puna's journal page.
- **Reconnecting.** The bridge replaces CommonClient's autoreconnect with the journal page's policy:
  - after a drop it retries with a jittered delay that doubles from 1 second up to 30;
  - while the tab is hidden the connection stays open, but a lost connection isn't retried until the tab is shown again;
  - showing the tab or the browser coming back online retries immediately.

  The page can't see WebSocket pings, so a watchdog sends a harmless `Get` after 20 seconds without traffic and abandons the connection after 45. `spikes/07-kalapana/reconnect.mjs` checks this against a real server that is killed, restarted and frozen.

### Shared data directory

```
catalog.json                  published catalog
last-refresh.json             summary of the last published refresh, including failures
refresh.lease                 lease file (owner, expiry)
refresh-requested.json        pending refresh request
apworlds/<sha256>.apworld     downloads
apworlds/unlocked-downloads.json   URL -> sha256 for versions index.lock doesn't cover
core-v1/<key>/                core.zip, core-src.zip, result.json
analysis-v1/<key>/            bundle.zip, result.json (key = hash of analyzer context and apworld sha256)
```

**Locking.** The lease is created with `link()`, which is atomic and never exposes a half-written file, and renewed every 30 seconds with a 90-second expiry. An expired lease is taken over by renaming it aside. The contender checks it moved the stale lease it read, and puts a live lease back if not. A holder that finds someone else's owner id stops processing. Published files and directories are written under temporary names and renamed into place.

## Catalog

```json
{
  "schema": 1,
  "archipelagoVersion": "0.6.7",
  "pyodide": { "version": "0.29.4", "base": "/runtime/pyodide-0.29.4/" },
  "core": { "bundle": "/bundles/core/<key>.zip", "packages": ["pyyaml"] },
  "tracker": { "version": "0.3.3", "bundle": "/bundles/worlds/<key>.zip", "packages": ["pyyaml"] },
  "trackerAddons": { "version": "0.1.1", "bundle": "/bundles/worlds/<key>.zip", "packages": [] },
  "kalapanaVersion": "0.1.0+abc1234",
  "games": {
    "TUNIC": [
      { "module": "tunic", "version": "0.6.7", "source": "core", "checksum": "c2cfbd...",
        "bundle": "/bundles/worlds/<key>.zip", "packages": ["pyyaml"], "needsYaml": false,
        "disableUt": false, "map": { "externalPack": true, "internalPack": false } }
    ]
  }
}
```

**Publishing in two steps.** A new image serves its page as soon as its pod starts, but a refresh can take many minutes. So once the new core, tracker and tracker addons bundles are ready, the refresh first republishes the existing catalog pointing at them, keeping its games, and publishes the full catalog at the end. The early step is skipped when the pinned Archipelago or Pyodide version changed, since world bundles are compiled for those.

**Checksum ambiguity.** Entries are sorted newest first. A datapackage checksum only covers item and location names and ids, so versions that changed logic without renaming anything share a checksum (ANIMAL WELL 0.5.0 and 0.5.2 do). The browser takes the newest match. That may not be the version the room generated with; the room's apworld version isn't available anywhere the browser can see.

## Container and deployment

- **Image.** `deploy/Dockerfile` has two stages:
  1. `node:26-trixie-slim` runs `deploy/fetch-inputs.mjs`, which downloads and verifies `deploy/inputs.json`;
  2. `node:26-trixie-slim` with the vendored inputs and kalapana's code, running as `node` (158 MB locally).

  Node 26 is required for the permission model's `--allow-net`.
- **CI.** `.gitlab-ci.yml` runs `node --test` and syntax checks, then buildah with `:sha-<short>` on every branch, `:latest` on `main` and `:dev` on `ionium-dev`. No deploy job.
- **Kubernetes.** Manifests live outside the repo, as with puna. The pod needs:
  - `/data` on the shared RWX volume;
  - the admin token from a Secret (`KALAPANA_ADMIN_TOKEN_FILE`);
  - `/healthz` for liveness and `/readyz` for readiness;
  - egress to GitHub for the index and apworld downloads.

  Envoy terminates TLS. The deployment sets `enableServiceLinks: false`, although the server also ignores the `KALAPANA_PORT=tcp://...` value Kubernetes injects for a Service named `kalapana`.
- **Resources.** Each analyzer process peaks at about 250 MB. In the cluster, the first refresh on an empty volume took about 20 minutes with 4 analyzers, peaking at about 870 MiB working set and 6 cores; the other replica stayed under 80 MiB. Once the cache is warm, only new index versions are processed.
- **Hostnames.** Nothing in the server or web client names a hostname, which is why the move from `ut.ionium.us` to `ut.ionium.fyi` needed no code changes. Keep it that way.
- **Headers.** HTML gets a Content Security Policy:
  - `script-src 'self' 'wasm-unsafe-eval'`;
  - `connect-src 'self' wss: ws:`;
  - `img-src 'self' blob: data:`;
  - `frame-ancestors 'none'`.

  Every response gets `nosniff`, `no-referrer` and `Cross-Origin-Resource-Policy: same-origin`. Runtime and bundle files are `immutable`; the app and catalog are `no-cache` with ETags.

## Handoff from puna

Deferred. The agreed direction:
- **Link.** A per-slot "Track in browser" link on puna's room page, with the server, slot and game in the URL fragment. The page reads it and strips it with `history.replaceState`.
- **Password, testing.** Base64url-encoded in the fragment. This only prevents casual reading.
- **Password, launch.** A single-use handoff token of about 60 seconds, redeemed with one cookie-less CORS request to puna, so the password never appears in a URL.
- **Known hosts.** The page auto-connects only to known room hosts, and asks before connecting anywhere else.

Until then, the page accepts `?address=&slot=` in the query string. It never accepts a password there.

## Isolation and cookies

- **Separate site.** Kalapana runs on `ut.ionium.fyi`, a different registrable domain from puna (`mw.ionium.us`) and the lobby (`ap-lobby.ionium.us`). Their cookies never reach it, and it can't toss cookies onto them. The `.fyi` site keeps no server-side sessions or user-identifying state.
- **Guard.** Recommended for puna and the lobby regardless: reject state-changing requests unless `Sec-Fetch-Site` is `same-origin` (or `none`), with an `Origin` fallback.
- **World code runs in the worker.** UT, catalog worlds and apworlds players supply all run in the Web Worker. Workers have no localStorage or DOM, so saved connections and passwords are out of their reach, and the page renders everything the worker sends as text.
- **Worker CSP.** The server gives `worker.mjs` its own policy, built from the `?room=host:port` the page passes: scripts only from kalapana with no eval, and connections only to kalapana and that room. An IPv6 literal falls back to any WebSocket host, since CSP can't name one. Verified with a probe apworld: eval and `new Function` throw, and fetch and WebSocket requests to another origin never leave the browser.
- **What world code can still reach.** The session's own room address, slot, password, YAML and pack; the room itself, as that slot; and the origin's IndexedDB, Cache API and OPFS. Kalapana stores nothing in those today. A saved library would have to treat their contents as untrusted.
- **Server side.** Index apworlds run only inside the analyzer sandbox, and uploaded apworlds never reach the server. The server process itself never imports world code.

## Known limitations

- **Native dependencies.** Worlds needing native packages fail analysis and don't appear in the catalog (for example soe, which the index also disables).
  - **Stand-ins:** `runtime/native_stubs.py` provides `dolphin_memory_engine` and `tkinter`, which some apworlds import only for their game clients. Imports succeed, and anything called raises (`tkinter.TclError` for tkinter, which AP's dialog helpers treat as "no GUI"). This brought in Luigi's Mansion, PokePark, Minecraft Dig and Oracle of Ages, whose imports touch nothing from those modules while loading.
  - **Vendored for worlds:** `maseya-z3pr` (a PyPI wheel, for Clair Obscur) and `zilliandomizer` (source at the commit AP's Zillion requires, since it isn't on PyPI) are pure Python and ship in the core bundle.
  - **Libraries an apworld ships:** Super Junkoid carries `super_junkoid_randomizer` in its own folder and imports it by its top-level name, which desktop AP arranges by extracting it from the zipped `.apworld`. `runtime/bundled_libraries.py` answers such an import from a world's folder, but only when that world's `requirements.txt` names the package.
- **Rooms without TLS** can't be reached from an https page.
- **No saved library yet.** The test instance doesn't keep uploaded YAMLs and packs between visits. OPFS persistence was proven in the spikes but isn't wired in.
- **Missing UI.** No hints tab, map groups or location icons yet.
- **Uploaded apworlds aren't kept.** The choice lasts until the page is reloaded. A huge or malicious archive can exhaust the tab's memory, but nothing beyond the tab.
- **Saved password.** The room password is kept in plain text in the browser's localStorage, along with the Recent list.
- **Safari** is untested.
- **Randomized YAML options.** UT's own limitation still applies: they need the rolled values filled in.

## Open decisions

1. **Handoff token details.** Token lifetime, and whether redeeming requires the room to be running.
2. **Guard.** Approve the `Sec-Fetch-Site` check as HANDOFFs to puna and the lobby?
3. **UT pinning.** Keep `tracker.apworld` pinned in `deploy/inputs.json`, or add it to Archipelago-index?

## Milestones

1. **Test instance** (this). Server refresh and sandboxed analysis, catalog, browser client, image and CI. Verified end to end locally against AP 0.6.7 rooms for TUNIC (with map) and Stardew (with YAML), and in the container.
2. **Deploy to `ut.ionium.us`** on the shared volume. Test against a live pahoa room.
3. **Client polish:** persistent library, hints tab, autocomplete, map groups and icons.
4. **Puna handoff:** link, guard, then token.
5. **Launch:** separate domain, uploaded apworlds, Safari pass.
