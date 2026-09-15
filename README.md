# kalapana

Archipelago's Universal Tracker, running in the browser. Python runs client-side in Pyodide; the server
only serves files and keeps a catalog of apworld bundles built from the curated
[Archipelago-index](https://github.com/ionium-ap/Archipelago-index).

## How it works

- **Refresh.** At startup and on `POST /admin/refresh`, the server:
  1. downloads the index;
  2. downloads every locked apworld version, checked against `index.lock`;
  3. analyzes each new one in a sandbox (see below);
  4. publishes `catalog.json`.

  Results are cached by apworld sha256, so later refreshes only process new versions.
- **Analysis sandbox.** Apworlds are arbitrary Python. Each one is imported in a child Node process running Pyodide under Node's permission model: no network, no child processes, no environment, and writes only to its job directory. The analysis records:
  - the world's datapackage checksum;
  - whether Universal Tracker needs a player YAML or a poptracker pack for it;
  - which Pyodide packages it needs.

  It also produces a precompiled bundle of the world.
- **Browser.** The page opens a short connection to the room to read its datapackage checksums, picks the matching world bundle from the catalog, asks for a YAML or pack if the world needs one, then runs the tracker in a Web Worker. Once the room is checked, a player can use their own `.apworld` instead of the catalog's, for a room no catalog version matches or for a newer version with different logic, even while tracking. It is checked against the room's game and datapackage in the browser and never uploaded to the server. Dropped connections are retried with backoff, but not while the tab is hidden. The last connection details and a short Recent list are kept in localStorage.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KALAPANA_DATA_DIR` | `/data` in the image | Shared data directory (catalog, apworlds, bundles, lease). Shared by all pods. |
| `KALAPANA_WORK_DIR` | OS temp dir | Per-pod scratch space for analyzer jobs. |
| `KALAPANA_PORT` / `KALAPANA_HOST` | `8080` / `::` | Listen address. A non-integer port, such as the `tcp://...` value Kubernetes injects for a Service named `kalapana`, is ignored with a warning. Invalid values for the other numeric settings stop startup with an error naming the variable. |
| `KALAPANA_ADMIN_TOKEN` or `KALAPANA_ADMIN_TOKEN_FILE` | unset | Bearer token for `/admin/*`. Admin endpoints are disabled without one. |
| `KALAPANA_INDEX_URL` | `main` tarball of ionium-ap/Archipelago-index | Where to fetch the index. |
| `KALAPANA_INDEX_PATH` | unset | Use a local index checkout instead (development). |
| `KALAPANA_INDEX_WORLDS` | unset | Comma-separated world names to process (development). |
| `KALAPANA_ANALYZER_CONCURRENCY` | min(4, CPUs) | Analyzer processes at once. Each needs a few hundred MB. |
| `KALAPANA_ANALYZER_TIMEOUT_SECONDS` | `180` | Per-apworld analysis timeout. |
| `KALAPANA_DOWNLOAD_CONCURRENCY` | `8` | Parallel apworld downloads. |
| `KALAPANA_REFRESH_ON_STARTUP` | `true` | Request a refresh when the pod starts. |

## Endpoints

| Route | Notes |
|---|---|
| `GET /` | The web app. |
| `GET /catalog.json` | Current catalog. |
| `GET /runtime/pyodide-<version>/*`, `/bundles/core/<key>.zip`, `/bundles/worlds/<key>.zip` | Immutable assets. |
| `GET /healthz` | Liveness. |
| `GET /readyz` | 200 once a catalog exists. |
| `POST /admin/refresh` | Requests a refresh. Returns 202 with status. Needs the bearer token. |
| `GET /admin/status` | Needs the bearer token. Shows this pod's refresh progress, the lease holder, the last published refresh with its failures, and the last refresh that downloaded or analyzed anything (pod restarts publish cache-only refreshes). |

## Running several pods

All pods mount the same data directory (CephFS). Only one pod processes apworlds at a time: a renewable lease file (`refresh.lease`) is created atomically and renewed while a refresh runs. A refresh request on any pod leaves a request file that the lease holder, or the next pod to get the lease, picks up. A lease whose holder died expires after 90 seconds. Everything a pod publishes is written to a temporary name and renamed into place, so other pods never read partial files.

## Development

```sh
node deploy/fetch-inputs.mjs vendor        # pinned AP, Pyodide, UT and wheels; needs tar and bzip2
KALAPANA_DATA_DIR=./data KALAPANA_ADMIN_TOKEN=dev KALAPANA_INDEX_WORLDS=tunic,stardew_valley \
  node server/main.mjs
node --test 'test/*.test.mjs'
```

Requires Node 26: the analyzer sandbox relies on the permission model's `--allow-net`. `spikes/` holds the feasibility experiments and a puppeteer end-to-end check (`spikes/07-kalapana/e2e.mjs`). Its npm dependencies stay in `spikes/`.

## Updating pinned versions

`deploy/inputs.json` pins the Archipelago release (it must match the index's `archipelago_version`), Pyodide, Universal Tracker, the pure-Python wheels, and pure-Python packages only published as source (a `sources` entry names the tarball and the package directory inside it), all by sha256. A refresh fails loudly if the index moves to a different Archipelago version than the image has.
