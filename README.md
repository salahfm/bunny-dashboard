# Bunny Publisher — TMDB → Bunny Stream dashboard

A standalone dashboard that searches TMDB, lets you pick **movies, single episodes,
whole seasons or a whole series**, and queues **media you own** into Bunny Stream
across up to **30 accounts** with a **10-concurrent-upload cap per account**.
Bunny does the encoding; the dashboard tracks every job until it is playable.

> **Scope:** the dashboard takes media from three places — a file you upload, a
> URL Bunny fetches itself, or — the *direct scraping* path — an embed host or a
> source URL this machine resolves and downloads before handing the bytes to
> Bunny. The scraping core is ported from the `ogaro` backend's providers
> (`lib/providers/*`) with the subtitle/Arabic-track logic stripped out. Whatever
> you publish is your responsibility: the hosts are third-party players, and
> having the tool resolve them is not a licence to redistribute what they serve.

## How the source pipeline works

1. **Resolve.** For a TMDB target the six hosts are swept at once (`Movy`,
   `Aurora`, `Rigel`, `VidLink`, `VidFast`, `CineSrc`); for a pasted URL the URL
   is read directly — a `.m3u8`/`.mp4` is used as-is, an embed page is routed to
   the provider that knows it, and any other page is scanned for a playlist.
2. **Pick a tier.** Candidates are probed best-first and the first one whose
   manifest really reaches the floor wins — `4K → 2K → 1080p → …`, and a host
   that tops out at 720p is walked past while another still has 1080p. When no
   source reaches the floor, the best of them is used and the job says so.
3. **Measure.** Every segment's size is read (`Content-Length`/`Content-Range`,
   or `#EXT-X-BYTERANGE`) so the upload can declare an exact length before it
   starts. AES-128 segments are decrypted, fMP4 init segments are prepended.
4. **Download while uploading.** Segments land in `DATA_DIR/uploads/<job-id>.ts`
   (or `.mp4`); the same file is read at the other end by whichever transport is
   carrying it, so the bytes are downloaded once and the transfer overlaps the
   download.
5. **Transport.** With the tunnel up, Bunny is handed
   `/relay/<token>/stream.<ext>` and pulls the file from Bunny's own network;
   without one (or if Bunny refuses), the dashboard streams the spool into
   Bunny's resumable upload endpoint itself. The job records which one it was.

Segments are fetched four at a time (`STREAM_CONCURRENCY`), each with four
attempts, and a failed relay read breaks its connection rather than sending a
truncated body. Live playlists (no `#EXT-X-ENDLIST`, fewer than three segments)
are refused: they never end, so they cannot be published as a file.

To try the whole path without touching a third-party host, the repo ships a tiny
local origin — it serves a two-tier master playlist and four segments:

```bash
node scripts/demo-source.mjs        # http://127.0.0.1:4800/master.m3u8
```

Paste that URL into **Source URL** and press **Download & upload**.

## Features

- **Titles**: search by title, bare TMDB id (`27205`), IMDb id (`tt1375666`) or a
  TMDB link; pick a movie, or a show → season → episode. The selected target then
  has four actions: *Direct scraping → upload*, *Preview sources*, *Bunny fetch*
  (a direct URL Bunny pulls itself) and *Upload file*.
- **Source URL**: paste one URL and click once — the backend resolves it,
  downloads the TS and hands it to Bunny. The same tab owns the **tunnel** panel
  (state, public URL, start/stop, cloudflared log).
- **Queue**: one table of every job with status, byte progress, the stage it is
  in, which host and tier its source came from, and the transport that carried it.
  Click a row for the full candidate ladder, the resolved URL, byte counts and
  the relay state; retry, cancel and delete live per row.
- **Preview sources** answers "what would be picked, and why" without downloading
  anything: every probed candidate with its height, host and note.
- **Accounts**: add/enable/disable/test/delete Bunny Stream accounts; keys are
  encrypted at rest (AES-256-GCM) and only ever displayed masked. Limit: 30.
- **Queue engine**: oldest-first, evenly spread across enabled accounts, never
  more than 10 concurrent uploads per account. Retry failed jobs, cancel active
  ones, delete finished ones. Playback links when a pull-zone host is set.
- **Watched folder**: drop video files into a folder and the dashboard reads the
  title, year and episode numbers out of each filename, matches them on TMDB and
  queues them automatically.
- **Mock mode** that simulates TMDB and Bunny (encodes finish in ~20 s) so the
  whole flow can be used and tested without any credentials.

## Quick start

```bash
npm install

# Explore the full flow with no credentials (simulated TMDB + Bunny):
npm run mock            # http://127.0.0.1:4747

# Real mode:
npm start               # same URL, real TMDB and Bunny APIs
```

Open the dashboard (defaults to `http://127.0.0.1:4747`) and:

1. **Settings** → paste a TMDB **v3 API key** or **v4 access token** and save.
2. **Accounts** → add each Bunny Stream library: a name, the **library ID**,
   that library's **Stream API key**, and optionally its pull-zone host
   (`vz-xxxx.b-cdn.net`) so finished jobs get playable links.
3. **Titles** → search, pick a movie or an episode, then publish it: **Direct
   scraping** (the dashboard downloads it), **Bunny fetch** (Bunny downloads a URL
   you paste), or **Upload file** (a file on this machine). Watch progress in
   **Queue**.
4. **Source URL** → paste an `.m3u8`, a media file or an embed page and click
   **Download & upload**. If the tunnel is not up yet, press **Start tunnel**
   first — or let it fall back to uploading the bytes directly.
5. Optional: **Watched folder** → point it at an incoming folder and files dropped
   there are matched and queued for you (see *Watched folder*).

## Configuration

Every setting can also come from `.env` (see `.env.example`) — the file is read
at startup and never overrides real environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4747` / `127.0.0.1` | HTTP listener |
| `DATA_DIR` | `./data` | `db.json`, the AES key file, temporary uploads |
| `PER_ACCOUNT_CONCURRENCY` | `10` | concurrent uploads per account (clamped to 1–10) |
| `MAX_ACCOUNTS` | `30` | account limit (clamped to 1–30) |
| `TICK_INTERVAL_MS` / `POLL_INTERVAL_MS` | `1000` / `10000` | scheduler tick / Bunny status poll |
| `UPLOAD_MODE` | `tus` | `tus` = resumable chunks; `put` = one raw PUT request, no resume |
| `TUS_CHUNK_BYTES` | `8388608` (8 MiB) | TUS chunk size, clamped to 64 KiB – 1 GiB |
| `WATCH_DIR` | – | default for the watched folder; the value saved in the dashboard wins |
| `WATCH_INTERVAL_MS` | `15000` | how often the watched folder is inspected |
| `WATCH_MIN_AGE_MS` | `30000` | how long a file must stay unchanged before it is picked up |
| `STREAM_CONCURRENCY` | `4` | segments downloaded in parallel for a scraped stream (1–10) |
| `SOURCE_TUNNEL` | `1` | allow a Cloudflare quick tunnel so Bunny can pull the relay |
| `SOURCE_TUNNEL_DOWNLOAD` | `1` | fetch `cloudflared` into `.tools/` when it is not installed |
| `TUNNEL_PUBLIC_URL` | – | use a tunnel you run yourself instead of spawning one (e.g. `https://abc.trycloudflare.com`) |
| `CLOUDFLARED` | – | path to an existing `cloudflared` binary |
| `MOCK_PROVIDERS` | `0` | `1` behaves like `npm run mock` |
| `NETWORK_TIMEOUT_MS` | `30000` | per-attempt ceiling for Bunny API and playlist calls (min 1000) |
| `NETWORK_RETRIES` | `3` | extra attempts after a transport failure (clamped 0–8, with jittered backoff) |
| `DASHBOARD_USER` | `index` | login user, used only when a password is set |
| `DASHBOARD_PASSWORD` | – | set it to require the login on every page and API route |

Queue limits can also be changed live in the **Settings** tab (validated against
the hard caps). Uploads are capped at 10 GB per file.

## How the queue works

1. `POST /api/jobs/upload` streams the file to `DATA_DIR/uploads/<job-id>.bin`
   (no size buffering in memory); `POST /api/jobs/remote` just records the URL.
2. A tick every second assigns queued jobs to accounts with free capacity —
   oldest first, spread as evenly as possible, never above the per-account cap.
3. A worker creates the Bunny video object, then either uploads the file over
   TUS (see below) or calls `POST /videos/fetch` for remote URLs.
4. Status moves `queued → uploading → encoding → ready` (or `failed`), polling
   Bunny every 10 s. While uploading, `progress` tracks bytes sent to Bunny.

### Resumable (TUS) uploads

Files go up in `TUS_CHUNK_BYTES` chunks against Bunny's
`https://video.bunnycdn.com/tusupload` endpoint, each request signed with the
SHA-256 presigned credentials Bunny requires. A chunk that dies is retried with
backoff; after every failure the authoritative offset is re-read with `HEAD`, so
the upload continues from the byte Bunny actually holds — even when the
connection dropped mid-chunk and Bunny stored only part of it. Cancelling a job
stops it between chunks.

The upload session (its `Location` URL and the account that owns it) is stored on
the job, so an interrupted upload picks up where it stopped instead of starting
the file again:

- **flaky connection** — chunk retries, then a resumable failure that keeps the
  job retryable;
- **Retry button** — reuses the same Bunny video object and offset;
- **dashboard restart** — interrupted uploads are requeued with their session
  and resume on the same account.

A failed resumable upload keeps its temp file so the resume has something to
read; deleting the job removes it. A failed `put`-mode upload deletes the temp
file as before. Temp files left behind by jobs that no longer exist are swept on
startup.

A source job is not resumed byte for byte — its URL is resolved again. The URL
the last attempt settled on is tried first, and because these hosts sign their
playlists (an old token answers `403`), a fresh scrape follows it: retrying an
old job finds a new source rather than failing on the URL the first attempt used.

Bunny video states are mapped as: `4` finished / `8` JIT playlists → ready,
`5` error / `6` upload failed → failed, everything else → still working.

## Watched folder

Point the **Watch** tab at an incoming folder (or set `WATCH_DIR`) and every
video file dropped there is matched and queued without further clicks. Names are
read the way releases are named:

| Filename | Queued as |
| --- | --- |
| `Inception.2010.1080p.BluRay.x264-GROUP.mkv` | movie *Inception* (2010) |
| `The Matrix (1999) [2160p].mp4` | movie *The Matrix* (1999) |
| `Breaking.Bad.S01E02.2160p.WEB-DL.mkv` | *Breaking Bad* S01E02 (with its TMDB episode title) |
| `Show Name - 1x02 - Pilot.mkv` | *Show Name* S01E02 |
| `Arcane Season 1 Episode 3 1080p.mkv` | *Arcane* S01E03 |

Release tags (`1080p`, `WEB-DL`, `x265`, `DDP5.1`, `HDR`, group names, …) are
discarded, and so are `.sample` files, hidden files and anything that is not a
video container. Sub-folders are searched two levels deep.

How it behaves:

- A file must sit unchanged for `WATCH_MIN_AGE_MS` (30 s) first, so a half-copied
  file is never queued; empty files wait too.
- The filename is searched on TMDB and the best candidate is confirmed against
  the real movie/show detail. Only an exact title is trusted on its own — a
  partial or prefix title also needs a year that agrees, otherwise the file is
  reported instead of guessed.
- A queued file is **moved** into the uploads folder (a rename when the folder is
  on the same disk, otherwise a verified copy-and-delete) and then behaves like
  any other job: TUS upload, encoding poll, playback link.
- Whatever is **still in the folder** could not be resolved. Those entries are
  listed in the Watch tab with the reason (no confident match, unknown season or
  episode, TMDB not configured, …) and retried every 5 minutes — or immediately
  with **Retry unresolved**. Fix the filename and the next scan picks it up.
- A re-dropped file with a name that was already queued is new work: it is
  matched and queued again.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness + mock flag |
| `GET` | `/api/diagnostics` | reachability of the Bunny API, each pull zone, the scraper hosts and the relay (what **Settings → Check network** renders) |
| `GET`/`PUT` | `/api/settings` | TMDB credential, queue limits |
| `GET`/`POST` | `/api/accounts` | list / add an account |
| `PATCH`/`DELETE` | `/api/accounts/:id` | update (incl. `enabled`) / remove |
| `POST` | `/api/accounts/:id/test` | verify key + library |
| `GET` | `/api/tmdb/search?q=` | title search |
| `GET` | `/api/tmdb/lookup?q=` | TMDB id, IMDb id or TMDB URL |
| `GET` | `/api/tmdb/movie/:id`, `/api/tmdb/tv/:id`, `/api/tmdb/tv/:id/season/:n` | details |
| `POST` | `/api/jobs/upload?meta=<json>&name=` | raw binary body → job |
| `POST` | `/api/jobs/remote` | `{ target, url }` → Bunny fetch job |
| `POST` | `/api/jobs/source` | `{ target?, url?, title?, only?, minHeight? }` → the dashboard downloads it (`url` empty ⇒ scrape the target) |
| `GET` | `/api/sources/providers` | the scraping hosts + default tier floor |
| `POST` | `/api/sources/preview` | `{ target, only?, minHeight? }` → what a scrape would pick |
| `GET` | `/api/tunnel` | tunnel state + recent cloudflared log |
| `POST` | `/api/tunnel/start` / `/stop` | bring the quick tunnel up or down |
| `GET` | `/relay/<token>/stream.<ext>` | the live spool, for Bunny (and only Bunny) |
| `GET` | `/relay/<token>/master.m3u8` · `/playlist.m3u8` · `/seg/<n>.<ext>` | the same stream as an HLS ladder |
| `GET` | `/api/jobs` | jobs + queue stats |
| `POST` | `/api/jobs/:id/retry` / `/cancel` | lifecycle |
| `DELETE` | `/api/jobs/:id` | remove a finished job |
| `GET` | `/api/queue/stats` | counts + per-account usage |

## Data & security

- `DATA_DIR/db.json` — settings, accounts, jobs (atomic writes; a corrupt file is
  moved aside rather than crashing the process).
- `DATA_DIR/.secret` — 32-byte AES-256-GCM key, generated on first run, mode
  `0600`. Account API keys and the TMDB credential are stored encrypted; the API
  returns them masked (`••••1234`) and the dashboard never renders them.
- Temporary uploads live in `DATA_DIR/uploads` and are deleted as soon as a job
  turns ready or cancelled. A failed resumable upload keeps its file so Retry can
  resume it; deleting that job removes the file, and strays are swept on startup.
- The dashboard has an optional **Basic Auth login**: set `DASHBOARD_USER` and
  `DASHBOARD_PASSWORD` and every page and API route asks for them (constant-time
  comparison; the browser prompts, the server stores nothing). Without a password
  it is open — fine on `127.0.0.1` (the default), never on a public address, and
  the process prints a warning when it starts on a non-loopback host with no
  login. Two paths stay open for machines: `GET /api/health` for platform health
  checks, and `/relay/...` for Bunny Stream fetching a job's stream (that URL
  carries a random token instead of credentials).

## Hosting it

The dashboard is a long-running single process with a persistent data directory,
so serverless platforms with ephemeral disks (Vercel, Netlify, Cloudflare
Workers) do **not** fit: the queue scheduler would stop and `db.json` would
vanish between requests.

| Option | Cost | Fit |
| --- | --- | --- |
| **Run it locally** (recommended for one operator) | free | best throughput: the file goes browser → your machine → Bunny; no third party in the path. Reach it remotely with a tunnel (Tailscale, Cloudflare Tunnel) rather than by exposing it. |
| **Oracle Cloud Always Free** | free | always-on VM with persistent disk and very generous egress. As of June 2026 the ARM Ampere A1 allowance is 2 OCPU / 12 GB RAM (1,500 OCPU-hours and 9,000 GB-hours per month) — still plenty. ARM capacity can be scarce when provisioning. |
| **[Fly.io](https://fly.io)** | pay-as-you-go (smallest VM ≈ $2/month) | micro-VMs in 35+ regions, persistent volume for `DATA_DIR`, deploy near Bunny's storage region. Best "real hosting" fit for this app. |
| Render / Koyeb / Zeabur free tiers | free | spin down when idle, which pauses the queue worker mid-encode, and free plans usually lack a persistent disk. Acceptable only if you use remote-URL jobs and can tolerate cold starts. |
| Hetzner Cloud | ≈ €4/month | cheapest per unit of network throughput if you want a full VPS. |

A sample `fly.toml` mount for this app:

```toml
[mounts]
  source = "bunny_publisher_data"
  destination = "/data"
```

and start it with `HOST=0.0.0.0 DATA_DIR=/data npm start` so the app listens on
the VM's network interface.

Because uploads pass through the dashboard, pick a region on the same continent
as your Bunny storage zone (Bunny Stream has EU, NA, SA, Asia and Oceania
regions) — the round trip to Bunny dominates once the bytes leave your machine.

### Run it with Docker

A `Dockerfile` and a `docker-compose.yml` are included, so the same image runs
locally, on a VPS, or on any container host:

```bash
docker compose up -d --build     # http://127.0.0.1:4747, data in a named volume

# or build and run it directly:
docker build -t bunny-publisher .
docker run -d --name bunny-publisher -p 4747:4747 -v bunny-data:/data bunny-publisher
```

The image installs runtime dependencies only (`npm ci --omit=dev`) and starts
the dashboard with `HOST=0.0.0.0 PORT=4747 DATA_DIR=/data`. Keep a volume
mounted at `/data` so accounts, settings, in-flight jobs and resumable temp
files survive restarts, and run **one** replica — the JSON store is
single-process. Add `-e MOCK_PROVIDERS=1` for a fully offline demo container.

To run it on bunny.net itself (Magic Containers), where Bunny Stream pulls the
relay from the app's own endpoint and no Cloudflare tunnel is involved, follow
[deploy/magic-containers.md](deploy/magic-containers.md).

For scraped sources the container also runs the relay, and Bunny has to reach it:
the automatic quick tunnel works from inside the container (it downloads the
linux `cloudflared` into `.tools/` on first use), provided the container has
outbound HTTPS. If it does not, set `TUNNEL_PUBLIC_URL` to a tunnel you run
elsewhere and point it at the published port.

Outbound calls to the Bunny API retry transport failures and give up with an
error that names the host and what the transport said, rather than a bare
`fetch failed`. A quick tunnel's hostname is brand new when Bunny is first asked
to pull it, and Bunny can answer `DNS resolution failed` for a few seconds: the
pipeline retries the fetch, and if Bunny still cannot resolve it, the job
switches to uploading the bytes directly (a streamed source that is
AES-encrypted is uploaded from the finished file, because its true length is
only known once the padding is stripped). When a job will not start, **Settings → Check network** probes
the Bunny API, every enabled pull zone, the scraper hosts and the relay, and
shows latency and the resolved address per check — enough to tell a dead
credential from a network path that cannot reach `video.bunnycdn.com` (a
browser can reach it on a different path, so "it loads in Chrome" is not proof
that the dashboard can publish).

On PaaS container hosts, the free tiers that work for a *demo* (Render, Koyeb)
sleep after idle time or cannot attach volumes, which kills a background upload
mid-flight; an always-on service with a small volume (for example Northflank's
free sandbox, which requires a payment method on file) or a cheap VPS is the
right home for the queue. Hosts that build from a git repository only need the
`Dockerfile`, `package.json`, `package-lock.json`, `src/` and `public/`.

## Tests

```bash
npm run typecheck        # tsc --noEmit
npm test                 # 98 tests (queue caps, crypto, store, clients, TUS, watcher, job lifecycle, crash resume, HLS, source pipeline, tunnel, network policy, diagnostics, login)

# End-to-end against a running mock server:
npm run mock &           # or in another terminal
node scripts/smoke.mjs   # TMDB, accounts, uploads, concurrency cap, the source pipeline, watched folder, cleanup

# …when the dashboard runs with a custom DATA_DIR:
SMOKE_BASE_URL=http://127.0.0.1:4791 SMOKE_DATA_DIR=data-smoke2 node scripts/smoke.mjs
```

`tests/source-flow.test.ts` stands up a real origin CDN (master playlist, media
playlist, ranged segment responses) and a real relay server, then drives the
pipeline three ways: Bunny pulling the playlist through the relay segment by
segment *while it is still downloading* (a fake Bunny fetches the master, the
media playlist and every segment, and its bytes are compared with the origin),
the same stream uploaded chunk by chunk from the growing spool, and the tier walk
that skips a 720p host in favour of a 1080p one. One more test pins down the
reason a real pull used to die: a playlist whose measured sizes are not the bytes
the downloader produced (an AES-encrypted source is shorter once padding is
stripped) must still be served at the lengths that really exist. The smoke script
does the same thing once over HTTP: it serves an HLS stream from its own process,
submits it through `POST /api/jobs/source`, and checks the tier it settled on,
the byte counts and that nothing was left on disk.

`tests/crash-resume.test.ts` proves the resume behaviour end to end without any
Bunny credentials. It stands up a fake Bunny over HTTP, starts the real
dashboard as a child process, SIGKILLs it in the middle of a chunk, restarts
it against the same data directory, and asserts that the next `PATCH` begins at
the exact byte offset the fake Bunny already holds — same video object, same
upload session, no re-uploaded bytes.

## Known limitations

- The watcher reads titles from filenames only: it never looks inside folders for
  metadata (`movie.nfo`, cover art, `tvshow.nfo`) and ignores files whose name
  carries no title.
- Whole-season files (`Show.S02.mkv`) are refused rather than guessed — name them
  with `SxxExx`, or queue the season from the Search tab. Multi-episode files
  (`S01E01E02`) queue their first episode only.
- Watched-folder history lives in memory, so the list of already-queued files is
  lost on restart (the jobs themselves are not).
- Resuming needs the original temp file, so a job whose file was already cleaned
  up (ready, cancelled, or a `put`-mode failure) cannot continue a partial upload.
- Bunny expires an abandoned upload session (the docs say 24 h by an
  `AuthorizationExpire` of the creation request, or ~48 h of inactivity). After
  that the upload restarts from byte zero.
- Progress is reported per chunk, so a single chunk (8 MiB by default) is the
  finest granularity you will see.
- The JSON store is single-process: run one instance only, and don't point two
  instances at the same `DATA_DIR`.
- The login is one shared username/password (Basic Auth), not user accounts:
  whoever has it has full control of the dashboard.
- The scraping hosts are third-party pages: when one changes shape its resolver
  answers nothing (the job says which host failed and the next one is tried).
  `VidFast` and `CineSrc` are resolved by ogaro in a real browser; this dashboard
  has no browser, so only `VidFast`'s enc-dec route check and the plain page scan
  run for them, and `CineSrc`'s DDoS-Guard challenge usually refuses a server.
- A source whose size cannot be established (no `Content-Length`, no
  `#EXT-X-BYTERANGE`) is skipped in favour of the next candidate: TUS needs an
  exact `Upload-Length` and the relay needs a `Content-Length` for Bunny.
- The tunnel needs outbound HTTPS the first time (to fetch `cloudflared` from
  GitHub). If that fails — or if the binary is missing and downloading is off —
  jobs run on the direct upload transport and say so. Point `TUNNEL_PUBLIC_URL`
  at a tunnel you run yourself to skip the download entirely.
- Cloudflare's quick tunnels are best-effort by design (random hostname per
  start, no uptime guarantee, ~200 concurrent requests). They are perfect for the
  "Bunny pulls from this machine" step and wrong for anything that must have a
  stable address; use a named tunnel for that.
- A scraped job that fails is retried by re-downloading: the spool is deleted
  with the relay, so there is no partial file to resume from (unlike an uploaded
  file, whose TUS session survives).
