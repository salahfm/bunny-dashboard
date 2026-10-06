# Bunny Publisher — TMDB → Bunny Stream dashboard

A standalone dashboard that searches TMDB, lets you pick **movies, single episodes,
whole seasons or a whole series**, and queues **media you own** into Bunny Stream
across up to **30 accounts** with a **10-concurrent-upload cap per account**.
Bunny does the encoding; the dashboard tracks every job until it is playable.

> **Scope:** the dashboard takes media from three places — a file you upload, a
> URL Bunny fetches itself, or — the *direct scraping* path — an embed host or a
> source URL this machine resolves and downloads before handing the bytes to
> Bunny. The scraping core is ported from the `ogaro` backend's providers
> (`lib/providers/*`). Subtitles are carried from the stream's own HLS manifest
> as Bunny caption tracks, and the languages a title is missing — Arabic by
> default, or a list such as `ar,fr,es` — are translated from the best source
> track's **text**, never from the audio (see *Subtitles*).
> Whatever you publish is your responsibility: the hosts are third-party players,
> and having the tool resolve them is not a licence to redistribute what they
> serve.

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
  (a direct URL Bunny pulls itself) and *Upload file*. The minimum tier applies to
  the scrape: pick *whatever is available* (`0`) and the best tier any host offers
  is taken instead of the 1080p default.
- **Add a whole list**: paste one entry per line — a title (`Inception (2010)`),
  a TMDB id (`27205`), an IMDb id (`tt1375666`), a TMDB link, or a show. Movies and
  shows can be mixed, `#` comments a line out, and anything already in the queue is
  skipped rather than queued twice, so re-pasting a list is safe. A show expands to
  every episode of every season; `Breaking Bad S03` pins one season and
  `Breaking Bad S02E05` a single episode. One click queues the lot (up to
  `DEFAULT_MAX_BULK_JOBS = 200` per paste) and the report says what was created and
  what was skipped, and why.
- **Whole series / one season**: with a show selected, *Queue this season* queues
  every episode of the season the picker has open, and *Queue whole series* every
  episode of every season — one job per episode, no further clicking.
- **Source URL**: paste one URL and click once — the backend resolves it,
  downloads the TS and hands it to Bunny. The same tab owns the **tunnel** panel
  (state, public URL, start/stop, cloudflared log).
- **Queue**: one table of every job with status, byte progress, the stage it is
  in, which host and tier its source came from, and the transport that carried it.
  It is **live**: the server pushes each change and only the row that moved is
  redrawn, so a job's progress updates in place and the rest of the table —
  scroll position, the open detail, a filtered view — is left exactly as it was.
  Click a row for the full candidate ladder, the resolved URL, byte counts and
  the relay state; retry, cancel and delete live per row.
- **Library**: the permanent record. The moment a job turns *ready* its whole
  record is written to `DATA_DIR/catalog.json` — where it plays (video id,
  account, pull zone, playback URL, transport), what was published (the tier, the
  host, the resolved URL and its headers), **every quality the chosen source
  offered** (the full ladder from its master playlist), **every source URL the
  scrape found** (each with the headers it needed and the note about it) and
  **every subtitle track it was published with** — scraped or translated, with
  the language and the cue count. It survives deleting the job and a dashboard
  restart; filter it by title, id, quality, host, account or **subtitle
  language**, open a record for the URL-by-URL detail, or forget one (the video
  stays in Bunny). **Fill in subtitles** re-runs just the caption half for titles
  that are missing a target language — every missing language in one press, the
  whole list in batches, or one title picked out of a *missing / already has*
  subtitle filter — see [Filling in a
  title that is already published](#filling-in-a-title-that-is-already-published).
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
- **Autopilot**: walk TMDB's **top-rated** movies and shows without clicking.
  Each page is read highest rating first and a title is only queued when it
  **clears a rating floor** (default 3) — a title with **no rating at all**
  counts as failing, because a title nobody has rated is not "top rated".
  Titles already queued or already published are stepped over, so re-reading a
  page is free. When a cycle finds nothing new it **retries the failed jobs**
  automatically; when there is nothing to retry either it starts the list over
  from page one. A cycle creates a bounded number of jobs and the whole thing
  pauses while the queue is deep, so it can be left running. See *Autopilot*.
- **Stays unblocked**: requests to one scraping host are spaced out, and a host
  that refuses (401/403/429/503) or serves a bot wall goes into an **escalating
  cooldown** instead of being retried into a permanent ban; a host can also be
  routed through a **bunny.net pull zone** so it sees Bunny's IPs, not this
  machine's. See *Avoiding blocks*.
- **Subtitles**: a scraped stream's subtitle tracks are read from its HLS
  manifest, downloaded, converted to WebVTT and attached to the Bunny video as
  **caption tracks**. Each missing target language (`SUBTITLE_TARGET_LANG`, one
  code or a list like `ar,fr,es`) is translated from the best available track's
  *text* and uploaded against the same timings — no speech recognition is
  involved, and one press produces every language. See *Subtitles* below.
- **R2 archive**: once a title has finished encoding, **everything** Bunny made
  of it is copied into Cloudflare R2 — every MP4 fallback rendition, the
  original file, the HLS playlist, every thumbnail, every animated preview
  (`preview.gif`, `preview.webp`, `preview_hq.webm`, `preview_hq.mp4`), the
  player's seek sprites and every caption track — under a readable, sortable
  folder with a `manifest.json` that hashes every object. Each upload is
  confirmed with a `HEAD` against the bucket, and **only then is the video
  deleted from Bunny**. A title whose MP4 renditions are missing (MP4 Fallback
  switched off in the library, most often) is left exactly where it is. It runs
  as its **own background queue** — one title at a time, with a live per-title
  percentage in the Library — so nothing ever waits on a multi-gigabyte copy.
  The same queue re-checks a folder later by **re-hashing every object against
  its manifest** in R2, **mends the specific objects a check flags** (re-fetching
  them from Bunny, or falling back to the bucket's intact copies), and can **put
  a title back into Bunny** from the archive — straight out of R2 into Bunny with
  nothing spooled to this machine's disk, so restoring a film needs no free
  space. That re-check also runs **on its
  own, weekly**, so `verifiedAt` stays current and anything that has quietly
  stopped matching is surfaced in the counts and on its own row. Archived titles
  play **through the dashboard with short-lived signed URLs**, so the bucket
  never needs to be public. See *R2 archive* below.
- **Named by TMDB id**: the video object created in Bunny is called `tmdb:27205`
  for a movie and `tv:1396:S01E02` for an episode, not `Inception (2010)`.
  A library of ids stays unique and joinable back to TMDB (and to this
  dashboard's catalogue, whose keys are the same shape) however a release was
  named; the readable title still travels with the job and is what the queue and
  the Library show.
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

Mock mode mocks the subtitle translator as well: a caption produced while
`npm run mock` is running is prefixed with its language (`[AR] …`) and answered
on this machine, so a demo never reaches deepl.com. Point
`SUBTITLE_TRANSLATOR_URL` somewhere and that endpoint is used instead, mock mode
or not — naming one is a choice, not an accident.

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
| `MOCK_PROVIDERS` | `0` | `1` behaves like `npm run mock` (including the local, unkeyed subtitle translator) |
| `NETWORK_TIMEOUT_MS` | `30000` | per-attempt ceiling for Bunny API and playlist calls (min 1000) |
| `NETWORK_RETRIES` | `3` | extra attempts after a transport failure (clamped 0–8, with jittered backoff) |
| `SCRAPER_MIN_INTERVAL_MS` | `350` | smallest gap between two requests to the same scraping host (`0` disables) |
| `SCRAPER_COOLDOWN_MS` | `60000` | first cooldown for a host that refused us (min 1000); doubles per repeat, capped at 30 min |
| `SCRAPER_EGRESS` | – | route a scraping host through a bunny.net pull zone: `host=base,host=base` |
| `SUBTITLES` | `1` | carry a scraped stream's subtitle tracks into Bunny as caption tracks |
| `SUBTITLE_TARGET_LANG` | `ar` | the languages a title should end up with, in order — one code or a list (`ar,fr,es`, `Arabic, French, Spanish`); each one the stream does not already carry is translated and attached |
| `SUBTITLE_TRANSLATOR` | `deepl` | whether the missing languages are machine-translated; `off` = carry the stream's tracks only, invent nothing |
| `SUBTITLE_TRANSLATOR_URL` | `https://www2.deepl.com/jsonrpc` | the endpoint the DeepL scraper posts to |
| `R2_ACCOUNT_ID` | – | Cloudflare account id for the archive (all four `R2_*` credentials are needed together, or none are) |
| `R2_ACCESS_KEY_ID` | – | R2 API token's access key id |
| `R2_SECRET_ACCESS_KEY` | – | R2 API token's secret |
| `R2_BUCKET` | – | the bucket finished titles are copied into |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | overrides the S3 endpoint |
| `R2_PUBLIC_BASE` | – | an *optional* public base (`https://pub-….r2.dev` or a custom domain); not needed for playback, which the dashboard serves with signed URLs |
| `R2_PREFIX` | `archive` | the folder every title is filed under |
| `R2_URL_TTL` | `300` | how long a signed playback URL stays valid, in seconds (clamped 1 s – 7 days). The bucket can stay private |
| `R2_ARCHIVE` | `1` | copy a finished publish automatically (also the default of the dashboard switch) |
| `R2_KEEP_BUNNY` | `0` | `1` keeps the video in Bunny after a successful archive instead of deleting it |
| `R2_VERIFY` | `1` | re-check the archive on a schedule, refreshing `verifiedAt` and reporting anything that stopped matching (also the default of the dashboard switch) |
| `R2_VERIFY_INTERVAL_MS` | `604800000` | how often that pass runs, in ms (clamped 1 hour – 30 days); a weekly pass by default |
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

### Live queue

The browser does not poll. It opens one `GET /api/events` event stream and the
server pushes a delta whenever a job changes — `added`, `updated` or `removed` —
carrying only the rows that moved, in the same shape the queue list uses. The UI
patches those rows in place (and skips a row whose rendered fields did not
change), so an update never rebuilds the table and never costs a full list
download. Changes made anywhere are announced the same way: the job worker, the
autopilot, the watched folder and the API routes all go through the store's
single change hook.

Bursts are coalesced for 250 ms, so a download that moves its byte counter
dozens of times a second produces one message per job per window rather than a
flood. Queue counters ride along as a `stats` event, a title finishing
publishing is announced as `catalog`, and a comment line every 15 s keeps idle
proxies from closing the connection. `EventSource` reconnects by itself after a
restart — the Queue tab's **live** badge shows which state it is in, and while
the stream is down a slow poll keeps the list and the badge current.
5. Turning `ready` writes the job's full record to the published catalogue
   (`DATA_DIR/catalog.json`), so "what did we publish, at which quality, from
   which URL?" outlives the job and the dashboard.

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

## Subtitles

A scraped stream carries its subtitles in its HLS manifest as
`#EXT-X-MEDIA:TYPE=SUBTITLES` renditions — a URI per language, with the language
code and a label. Those are the source of truth: the manifest is the one place a
stream honestly says what subtitles come with it, so the pipeline reads them
from there rather than guessing at file names on the host.

For every subtitle track the chosen stream declares:

1. **Fetch.** The rendition URI is read through the same host guard as the
   scrape. It may be a plain `.vtt`/`.srt` file, or a *subtitle playlist* whose
   chunks are WebVTT segments on their own timeline — the `X-TIMESTAMP-MAP` of
   each chunk is applied, so segments do not all stack up at zero.
2. **Normalise.** SRT is converted to WebVTT (commas become full stops, hours are
   padded, cue indices dropped) and the language is normalised to a short ISO
   639-1 code — `en-US`, `ENG` and a track named *English* all become `en`.
3. **Attach.** The WebVTT is uploaded to Bunny as a caption track
   (`POST /videos/{id}/captions/{srclang}`). A caption Bunny decides is malformed
   is off the job with a note rather than reported as success.

Nothing here fails the job: a host that will not hand over its subtitles, or a
subtitle file that makes no sense, becomes a noted track on the job and the
video is still published.

### Missing languages without speech recognition

Every language in `SUBTITLE_TARGET_LANG` (`ar` by default; `ar,fr,es` works
too) that a title does not already carry is translated from an existing track
and uploaded as a normal caption — one caption per language, all from the same
source text, in one press.

The translation is **text → text**. Bunny's own transcribe/translate runs
Whisper over the **audio** first — speech recognition — which is slower, costs
per audio-minute, and is a poor way to reach a given language when the subtitle
is already sitting there in English. So instead the source cue lines are sent
to a translation engine once per language, and each language comes back against
the **same timings**: only the cue text is sent, and the cue count and order are
how the reply is matched back, so a translated track cannot drift out of sync.

**One engine, and no key.** The cues go to DeepL, on the endpoint deepl.com's
own translator page calls — `www2.deepl.com/jsonrpc`, JSON-RPC
`LMT_handle_texts`. There is no account, no API key and nothing to sign up for, so
a fresh install can produce translated subtitles with no setup at all:

| Setting | Value |
| --- | --- |
| endpoint | `https://www2.deepl.com/jsonrpc` (`SUBTITLE_TRANSLATOR_URL` points it elsewhere) |
| target | each configured language, uppercased (`ar` → `AR`, `fr` → `FR`) |
| source | the track's own language (`en`), or `auto` when the stream did not say |

Requests carry the cue text and nothing else, in batches of 25 cues (or 4 000
characters, whichever comes first) with a short pause between batches, and say
they come from DeepL's own mobile client — a bare `fetch` is the shape a scraper's
requests get refused in. That is the trade-off: this is **not a published API**,
so DeepL can change the shape, rate-limit it or refuse it at any time. A refusal
is therefore a *note on the job* (the video still publishes, and the track simply
is not there) rather than a failed job, and `SUBTITLE_TRANSLATOR=off` turns
machine translation off entirely.

The response is matched back by count: a reply that does not carry exactly one
translation per cue is refused rather than stitched onto the timings misaligned,
which is also why a target track can never arrive half-translated.

With translation off, nothing is invented: the tracks the stream actually had are
carried, and the job notes that each missing language was not created and
translation is switched off. A title published without subtitles at all is
recorded as such in the Library, and the catalogue keeps the full list — so
"which titles have Arabic, or French?" is one search.

### Filling in a title that is already published

A title is published once, so a missing Arabic track would otherwise mean
downloading the whole thing again. **Library → fill in ar, fr, es (n)** does
neither: the video is already in Bunny, so only the caption half of the pipeline
runs again — for every language that title is missing, out of one read of the
source text.

The button counts the published titles missing at least one of the languages in
`SUBTITLE_TARGET_LANG` and says where each one's text would come from:

1. **The subtitle URL the catalogue recorded** when that track was attached — the
   exact file used the first time, one request.
2. Otherwise **the master playlist** the catalogue recorded for the source,
   re-read so its `#EXT-X-MEDIA:TYPE=SUBTITLES` renditions can be used. The
   manifest is the one place a stream honestly declares its subtitles, so it is
   asked rather than guessed at.

English is preferred as the pivot in both cases — it is what the target languages
were designed to be translated from. The text is read once per title however many
languages are missing; each language is translated and attached on its own, so
one refusal does not take the others down, and a partial result says which landed
and which did not.

A title can be picked out rather than batched: the Library's subtitle filter
narrows the list to *missing ar, fr, es subtitles* (or *already has ar, fr, es
subtitles*, to see what the backfill has done), and every row that is missing one
carries its own **fill in ar, fr** button naming exactly what that row lacks. The
record's own panel has the same button, so the new tracks can be watched landing
on the title they belong to. The filter names the languages from
`SUBTITLE_TARGET_LANG` on both sides.

Work is done in batches (ten at a time from the UI, up to `limit: 100` over the
API) because every title in a batch costs a fetch, a translation and a caption
upload; whatever a batch does not reach is still counted afterwards and the next
press picks it up.

It also happens without anyone pressing anything. When a publish finishes without
a language this machine could have translated — a refused translation is the
usual reason, and DeepL rate-limits by design — the same fill-in is queued
automatically for that title. The queue runs one title at a time, so a burst of
publishes cannot become a burst of DeepL requests; a failed attempt is retried a
minute later, doubling, up to three times, because a rate limit clears with time.
If it still does not land, the title is left to the button above, which reports
why. Only a title that published a *readable* caption is repaired this way — if
the source text itself never came down there is nothing to translate from, and
the preview on the manual action is what says so. **Settings → fill in a missing
subtitle language as soon as a publish finishes** turns the automatic pass off.

A title that cannot be worked on says so *before* anything is tried — no Bunny
video id, an account that no longer exists, translation switched off, no source
recorded — and one that fails half way (a dead source, DeepL refusing) is reported
against the title with the reason, with the catalogue left exactly as it was.

## R2 archive

Bunny Stream is a player, not a locker. A finished video's own bytes are the
per-resolution **MP4 fallback** files on the pull zone (`play_1080p.mp4`, …); its
thumbnails and animated previews exist nowhere else; and deleting the video takes
all of it away. So the archive exists to make "remove it from Bunny" safe rather
than destructive: **copy everything out first, prove the copy is there, and only
then delete.**

Configure it by filling in the four `R2_*` credentials (an R2 API token with
object read/write on one bucket) and, optionally, `R2_PUBLIC_BASE` if the bucket
is served through `r2.dev` or a custom domain. With a destination configured,
**Settings → move a finished title to R2** is on by default, and every publish
that finishes encoding is archived without being asked. Without one, nothing about
archiving appears and nothing is ever deleted.

### What gets copied, and where

Every title gets one folder, named so a bucket browser can actually sort it and
suffixed with the TMDB id so two same-named releases cannot collide:

```
archive/Movies/Inception (2010) [27205]/
  video/1080p.mp4          every MP4 fallback rendition (up to 1080p)
  video/720p.mp4
  original                 the file that was uploaded, when Bunny kept it
  hls/playlist.m3u8        the HLS index those renditions belong to
  images/thumbnail.jpg     every thumbnail Bunny generated
  images/thumbnail_1.jpg
  images/preview.gif       every animated preview: gif, webp, and the HQ webm/mp4
  images/preview.webp
  images/preview_hq.webm
  images/preview_hq.mp4
  sprites/seek_0.jpg       the player's timeline sprites, as many as exist
  subtitles/en.vtt         every caption track on the video
  manifest.json            what all of it is, one SHA-256 per object

archive/Shows/Breaking Bad [1396]/Season 02/S02E05 - Breakage/…
```

Each asset is `HEAD`-ed on the pull zone first, so a rendition the library never
produced (or a `thumbnail_3.jpg` Bunny did not generate, or a sprite past the
last one) is *skipped* rather than treated as a failure. Every file that does
exist is streamed once into R2 — a signed `PUT` when it fits in one request, a
real S3 multipart upload when it does not — and then `HEAD`-ed **in the bucket**:
an object only counts once R2 itself says it is there, at the size that was sent.
`manifest.json` is written last, so its presence is what "this folder is a
complete archive" means.

### It runs as a background queue, not inside a request

Moving several gigabytes takes minutes, so a title is a **task on a queue**, not
a long HTTP call. `POST /api/archive` puts the picked titles in line and answers
immediately; one title moves at a time, and every title reports its own status
(`queued` → `active` → `done`/`failed`/`skipped`) and its own stage —
`checking` (read the video back from Bunny), `scanning` (HEAD every asset to
measure the job), `uploading` (one file at a time, in bytes), `manifest`,
`deleting`.

The measurement happens up front, which is what makes a progress bar honest —
the task knows the whole plan before it moves a byte, so the Library can show
`video/1080p.mp4 · 42% (1.4 GB of 3.4 GB)` rather than a spinner — and an
unreachable pull zone fails the title before anything is copied. A title waiting
behind another says where it is in line.

Progress is pushed, not polled: the same live event stream that carries the
queue carries `archive` deltas, each task coalesced to its latest state over the
same 250 ms window the job rows use — a multi-gigabyte upload reports its bytes
hundreds of times, and only the newest reading is sent. A page that reloads
mid-copy reads the current queue from `/api/archive` and carries on watching.
The task state itself is in memory (it describes work in progress, and a restart
simply offers the title again); what actually happened is the catalogue record
written at the end.

### Then, and only then, Bunny is told to forget it

The video is deleted from Bunny only after every object verified and the manifest
landed. A run that cannot reach the pull zone, that R2 refuses, or that finds **no
MP4 rendition at all** stops there and leaves the video in place — a folder of
thumbnails is not a replacement for the film, and Bunny is still the only copy.
Such a title keeps an `archive` record with `complete: false` and the reason, and
the automatic pass retries it twice more (five minutes apart, doubling) before
leaving it to the **move to R2** button in the Library.

Because a subtitle repair may still be attaching captions when a title is
published, the archive waits for it to settle before it reads the video —
deleting a video a caption upload is still in flight against would throw that
translation away.

Playback moves to the dashboard: an archived title's `playbackUrl` is the
dashboard's own `/api/archive/play/<key>` route, which answers with a **redirect
to a short-lived signed R2 URL** for the best archived rendition. The bucket
therefore never has to be public — the dashboard is the gatekeeper, the link it
hands out expires in `R2_URL_TTL` seconds, and a title Bunny was told to forget
still plays. Only `host` is signed, so the player can still send `Range`
requests; the bytes go straight from R2 to the player, not through the
dashboard. `R2_PUBLIC_BASE` remains optional and, when set, the folder's public
URL is recorded as `archive.base` for direct browsing. Either way the catalogue
record says which bucket, which folder, how many objects, how many bytes, which
object is the playable rendition, whether the copy is whole, and whether Bunny
still holds the video.

### Checking a copy, months later

An archive is only worth having if it is still the thing it claims to be, so the
**check R2** button in the Library (or `POST /api/archive/verify`) re-reads each
title's `manifest.json` **out of the bucket** — not out of the local catalogue —
and then downloads every object the manifest lists and compares its SHA-256 and
its size to what was recorded when it was written. A `HEAD` would only prove the
object is still *there*; hashing the bytes is what proves it is still the *same*
bytes.

Like an archive, a check is a task on the background queue: `checking` →
`verifying` (one object at a time, counted in the row) → `done`. **check R2**
walks up to 25 archived titles per press. The verdict is written onto the
catalogue entry — `verifiedAt`, plus `ok`, `checked`, `missing` and `mismatched`
lists — so "when was this last checked, and did it pass?" survives a reload. A
title whose bytes no longer match is reported rather than quietly repaired: the
row turns up in the red with the object's name, and the stored object is left
exactly as it was found.

### Checking the archive on its own

A check somebody has to remember to press is a check that stops happening, so
the same pass also runs **by itself, weekly** (`R2_VERIFY`, `R2_VERIFY_INTERVAL_MS`;
change it under **Settings → Checking the archive**). It puts every archived
title through the pass above, which is what keeps `verifiedAt` current and what
makes a title that has quietly rotted in the bucket show up without anyone
looking for it.

A sweep is the same background work as a button press, so nothing blocks: the
titles go into the archive queue, the browser watches them arrive on the event
stream, and the sweep is only marked finished once that queue has gone quiet.
When it has, the verdicts are counted and written to the schedule's log —
`checked 12 title(s): 11 still match, 1 stopped matching — movie:603` —
and the Settings panel shows the standing totals: how many titles are archived,
how many have a verdict, how many **stopped matching**, and how many have never
been checked at all.

A library larger than one batch is walked in **waves**: the queue never holds
more than the batch, and the next wave is only offered once the previous one has
been worked through, so a big library is still covered by a single sweep rather
than over several weeks. Two sweeps never overlap — a second would only re-queue
the first's titles and double the reads — and a queue that never goes quiet (a
stalled transfer, say) is given up on after a day rather than leaving the
schedule wedged. `POST /api/archive/check/run` runs one now, whatever the
schedule says.

The schedule's own state lives in `DATA_DIR/archive-check.json`, next to
`db.json` and the autopilot's, so "when did this last run, and what did it find?"
survives a restart. The environment only supplies the *defaults*: once the
interval or the switch has been changed from the dashboard, that choice is the
one that is kept.

### Mending what a check finds

A failed check names its objects, and `repair` on the row (or
`POST /api/archive/repair`) mends **just those** — the alternative, archiving the
title again, would re-download gigabytes to fix one file, and would not be
possible at all once Bunny has let the video go.

Each flagged object is fetched again from the pull zone it originally came from
and spooled to disk, so the fresh bytes are hashed *before* the stored object is
touched. A copy that hashes to exactly what the manifest recorded replaces what is
in the bucket; a copy Bunny now serves differently is stored **and recorded as
drift**, with its new hash, because Bunny is the origin and the record is the half
that has gone stale. Nothing is re-encoded, nothing is invented, and only the
flagged objects move.

When Bunny no longer holds the video there is nothing to fetch from, so the
repair falls back to what the bucket still has: playback moves onto the tallest
**intact** rendition, the objects nothing can supply are dropped from the record,
and `manifest.json` is rewritten so the folder agrees with the bucket again. The
repair finishes by verifying the folder as it now stands — a mend nobody checked
is just another claim — so the verdict on the record always describes the bucket
rather than the intention. Everything it did is recorded under `archive.repair`
(`recopied`, `drifted`, `dropped`, and the rendition playback moved to).

### Putting a title back into Bunny

The opposite trip is a **restore** (`restore` on a Library row, or
`POST /api/archive/restore`). It streams the **tallest archived MP4 rendition**
straight out of R2 and into a fresh Bunny video — the bucket's bytes are pulled
in chunks and handed to Bunny as they arrive, hashed on the way — and re-attaches
every caption the folder holds. The Bunny URL the archive replaced is then the
video's playback URL again, and the catalogue follows the new video id.

The rendition is **never written to this machine**, so a restore needs no free
disk: nothing is spooled to a temp file before the upload, whatever the transport
(`UPLOAD_MODE=tus` or `put`). The hash is therefore taken in the same pass that
sends the bytes, and the verdict comes after the upload rather than before it — if
the object no longer matches the manifest, the fresh video is **deleted** instead
of left in the library as a copy nothing has vouched for.

A restore is a **copy, not a move**: the R2 archive is left exactly where it is,
so a title can live in both places, and be archived again afterwards. The task
runs on the same queue and reports the round trip in one bar — bytes read and
bytes sent, counted as they happen.

## Autopilot

The **Autopilot** tab fills the queue from TMDB's **top-rated** lists with nobody
clicking. It is off by default; switch it on and it runs a cycle every
`intervalMs` (default 5 min, floor 10 s), or press **Run a cycle now**.

A cycle is one pass over the lists you ticked (movies and/or shows):

1. Read the current page of `/movie/top_rated` or `/tv/top_rated`, **highest
   rating first** — the client sorts by `voteAverage` itself, so the "best
   first" rule does not depend on the API's own order.
2. Queue a title only if its rating is **at or above the floor** (default **3**).
   A title with **no rating** fails the floor: "nobody has rated this" is not
   "top rated". Titles already queued or already in the published catalogue are
   stepped over, so re-reading a page costs nothing.
3. A show expands to every episode of every season (turn *expand shows into
   every episode* off to step over shows instead).
4. The cursor moves to the next page — but only once the page was fully dealt
   with. A page cut short by `maxJobsPerCycle` is picked up again next cycle, so
   a page is never half-skipped.

When a cycle creates **nothing**, the failure cleanup runs on its own: every
failed job whose attempts are below `maxAttempts` (default 5) is handed back to
the queue. When there is **nothing to retry either**, the list starts over from
page one, so a title that has gained a rating (or appeared on a new page) is
seen next time. That is the whole loop: fill the queue from the top, clean up
what fell over, then look again.

The whole thing pauses when the queue already holds `maxQueueDepth` unfinished
jobs (default 300) and reports why. State — the page cursor per list, the last
report and a rolling 200-line log — is written to `DATA_DIR/autopilot.json`, so a
restart resumes where it stopped instead of re-walking the same pages.

| Setting | Default | Meaning |
| --- | --- | --- |
| rating floor | `3` | queue a title at or above this; **unrated counts as failing** |
| lists | movies + shows | which top-rated lists to walk |
| minimum tier | `1080p` | the scrape floor for the jobs it queues |
| jobs per cycle | `25` | the most one cycle may create |
| retry limit | `5` | a failed job is retried until it has this many attempts |
| queue-depth pause | `300` | stop adding while this many jobs are unfinished |
| interval | `5 min` | how often a cycle runs (min 10 s) |
| expand shows | on | queue every episode of a show rather than stepping over shows |

## Avoiding blocks (politeness and bunny.net egress)

The scraping hosts are third-party players, and asking one of them for a
thousand titles looks exactly like abuse. Two layers keep the dashboard out of
trouble.

**Politeness (always on).** Requests to a single host are **serialised with a
minimum gap** between them (`SCRAPER_MIN_INTERVAL_MS`, default 350 ms) — several
hosts are still asked in parallel, but one host never sees a burst. A host that
answers `401`, `403`, `429` or `503` — or a body that is really a bot wall
("Just a moment", a Cloudflare `challenge-platform` page, `DDoS-Guard`,
"Checking your browser") — is put into **cooldown**, and a `Retry-After` is
honoured when it sends one. The first cooldown is `SCRAPER_COOLDOWN_MS` (default
60 s) and each further refusal doubles it up to 30 minutes, so a stuck host
cannot be retried into a permanent ban. While a host cools, every request to it
fails fast with a clear reason and the sweep moves on to the next host rather
than burning its timeout. **Settings → Cooling down** lists the hosts that are
cooling, why, and when they recover.

**Egress through bunny.net.** A CDN's job is to fetch content from an origin on
behalf of its visitors — and Bunny **forwards the visitor's headers unchanged**
(`User-Agent`, `Accept`, `Accept-Language`, `Referer`, `Cookie`, `Authorization`
and any custom header; it only adds `Host`, `X-Real-IP`, `X-Forwarded-For` and
`CDN-*`). So a pull zone whose **Origin URL** is the embed host turns a request
to a blocked host into a request from **Bunny's IPs**, with the dashboard's own
headers preserved. Nothing else about the request changes: the dashboard still
parses the page, only the address it came from does.

To use it, create a **pull zone** in the bunny.net dashboard (CDN → Pull Zones)
with the **Origin URL** set to the host you want to route, then tell the
dashboard to send that host through it:

```bash
# comma-separated host=base pairs — route vidfast.vc and one other host
SCRAPER_EGRESS="vidfast.vc=https://yourzone.b-cdn.net,embed.example=https://other.b-cdn.net"
```

A request for `https://vidfast.vc/x/y.m3u8` then goes out as
`https://yourzone.b-cdn.net/x/y.m3u8`; the path and query are kept, so Bunny
fetches the real URL from its own network and streams the answer back. The
**Settings** tab shows the egress map in force, and the job still records the
real host as its source.

Because a pull zone is free to point at any origin, this is a general workaround
for a host that blocks your IP, not just the embed hosts. It has limits: bunny.net
**drops header names containing `_`** and adds its own `Host`, a host that pins an
exact signed URL is not helped at all, and an interactive browser challenge is
not something a proxy can answer — for that, the cooldown path above is what
keeps the queue honest.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness + mock flag |
| `GET` | `/api/diagnostics` | reachability of the Bunny API, each pull zone, the scraper hosts and the relay (what **Settings → Check network** renders) |
| `GET`/`PUT` | `/api/settings` | TMDB credential, queue limits, watched folder, automatic subtitle repair |
| `GET`/`POST` | `/api/accounts` | list / add an account |
| `PATCH`/`DELETE` | `/api/accounts/:id` | update (incl. `enabled`) / remove |
| `POST` | `/api/accounts/:id/test` | verify key + library |
| `GET` | `/api/tmdb/search?q=` | title search |
| `GET` | `/api/tmdb/lookup?q=` | TMDB id, IMDb id or TMDB URL |
| `GET` | `/api/tmdb/movie/:id`, `/api/tmdb/tv/:id`, `/api/tmdb/tv/:id/season/:n` | details |
| `POST` | `/api/jobs/upload?meta=<json>&name=` | raw binary body → job |
| `POST` | `/api/jobs/remote` | `{ target, url }` → Bunny fetch job |
| `POST` | `/api/jobs/source` | `{ target?, url?, title?, only?, minHeight? }` → the dashboard downloads it (`url` empty ⇒ scrape the target) |
| `POST` | `/api/jobs/bulk` | `{ text \| lines[], expandSeries?, seasons?, maxJobs?, skipQueued?, only?, minHeight? }` → one job per movie, every episode per show; answers `{ created, skipped, counts, truncated }` |
| `POST` | `/api/jobs/series` | `{ target: { tmdbId, title? }, seasons?, maxJobs?, only?, minHeight? }` → every episode of the show (`seasons` narrows it) |
| `POST` | `/api/jobs/retry-failed` | retry every failed job in one call |
| `GET` | `/api/sources/providers` | the scraping hosts, the default tier floor, and the hosts currently cooling down |
| `POST` | `/api/sources/preview` | `{ target, only?, minHeight? }` → what a scrape would pick |
| `GET` | `/api/tunnel` | tunnel state + recent cloudflared log |
| `POST` | `/api/tunnel/start` / `/stop` | bring the quick tunnel up or down |
| `GET` | `/relay/<token>/stream.<ext>` | the live spool, for Bunny (and only Bunny) |
| `GET` | `/relay/<token>/master.m3u8` · `/playlist.m3u8` · `/seg/<n>.<ext>` | the same stream as an HLS ladder |
| `GET` | `/api/jobs` | jobs + queue stats. The rows are deliberately lean — the candidate ladder and per-source headers are left out of a list that may hold hundreds of jobs |
| `GET` | `/api/jobs/:id` | one job in full, its candidate ladder included (what opening a row fetches) |
| `POST` | `/api/jobs/:id/retry` / `/cancel` | lifecycle |
| `DELETE` | `/api/jobs/:id` | remove a finished job |
| `GET` | `/api/queue/stats` | counts + per-account usage |
| `GET` | `/api/events` | the live queue as `text/event-stream`: `hello` (current state), `jobs` (a delta of `{kind, job}`), `archive` (a delta of `{kind, task}` while titles copy to R2), `stats`, `catalog` — see [Live queue](#live-queue) |
| `GET` | `/api/catalog?q=&kind=&limit=&subtitles=` | published titles (search + filter) with stats; `subtitles=missing\|has` filters on the target languages and the answer carries the scoped missing count and the target list |
| `GET` | `/api/catalog/stats` | how many titles/qualities are recorded and how many bytes |
| `GET` | `/api/catalog/:key` | one record in full: every quality rung and every source URL |
| `DELETE` | `/api/catalog/:key` | forget a record (Bunny keeps the video) |
| `GET` | `/api/subtitles/backfill` | which published titles are still missing a target language, which languages each is missing, and what each would be translated from — a report only, nothing is fetched |
| `POST` | `/api/subtitles/backfill` | fill them in: `{ keys?, limit? }`. Re-reads the recorded subtitle text once, translates and attaches every missing language to the video that already exists — no re-download, no re-publish |
| `GET` | `/api/archive` | which published titles still have a Bunny copy waiting to be archived, what R2 holds and could be re-checked (`verify`), mended (`repair`) or put back (`restore`), plus the queue's live tasks (status, stage, bytes) |
| `POST` | `/api/archive` | **queue** them: `{ keys?, limit? }`. Answers at once with what was queued and what was skipped; the copying runs on the archive's own queue and reports progress on `/api/events` |
| `POST` | `/api/archive/verify` | **queue a verification pass**: re-read each manifest from R2 and re-hash every object it lists. `{ keys?, limit? }`, answers at once |
| `POST` | `/api/archive/repair` | **queue a targeted repair**: mend just the objects the last check flagged, from Bunny or from the bucket's intact copies. `{ keys?, limit? }`, answers at once |
| `POST` | `/api/archive/restore` | **queue a restore**: stream an archived title back into a fresh Bunny video, captions included. `{ keys?, limit? }`, answers at once |
| `GET` | `/api/archive/play/:key` | **play an archived title**: `302` to a short-lived signed R2 URL for its best rendition, so the bucket can stay private |
| `GET` | `/api/archive/check` | the **scheduled re-check**: its settings, when it last ran and runs next, the last sweep's report, the standing totals (`archived` / `checked` / `failing` / `never`) and the log |
| `PUT` | `/api/archive/check` | change it: `{ enabled?, intervalMs?, batchSize? }` (validated: 1 hour – 30 days, ≤5000 at a time); stored on disk, and it survives a restart |
| `POST` | `/api/archive/check/run` | **run one sweep now**, whatever the schedule says. Answers at once; the queue does the reading |
| `POST` | `/api/archive/check/log/clear` | forget the schedule's log lines |
| `GET`/`PUT` | `/api/autopilot` | read / change the autopilot (rating floor, lists, limits, interval) |
| `POST` | `/api/autopilot/run` | run one cycle now, whatever the schedule says |
| `POST` | `/api/autopilot/reset` | reset the page cursors to page 1 |
| `POST` | `/api/autopilot/log/clear` | clear the autopilot log |

## Data & security

- `DATA_DIR/catalog.json` — the published catalogue: one permanent record per
  title that finished publishing, with every source URL, quality rung and
  subtitle track the job produced, and — once a title has been archived — the R2
  bucket, folder, per-object `{ key, bytes, sha256 }` list, manifest key, sizes and
  whether Bunny was told to forget the video. Written on the `ready` transition,
  atomic, and
  set aside (not lost) if it cannot be parsed. Deleting a job does not touch it.
- `DATA_DIR/autopilot.json` — the autopilot's own state: whether it is on, its
  settings, the page cursor per top-rated list, the last report and a rolling
  200-line log. Atomic, and set aside (not lost) if it cannot be parsed.
- `DATA_DIR/db.json` — settings, accounts, jobs (atomic writes; a corrupt file is
  moved aside rather than crashing the process). A busy queue moves byte counters
  many times a second, so those progress-only updates are coalesced into one write
  (and flushed on a clean shutdown) while every structural change — a status, a
  session URL — is written immediately.
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
npm test                 # 266 tests (queue caps, crypto, store + its change hook, catalogue, clients, TUS, watcher, job lifecycle, crash resume, HLS, source pipeline, subtitles, DeepL translation, multi-language targets, subtitle backfill and its automatic repair, the R2 archive background queue with its verification pass and its scheduled weekly sweep, targeted repair, restore and signed-URL playback, and its SigV4 signer/presigner, tunnel, network policy, diagnostics, login, autopilot, host politeness)

# End-to-end against a running mock server:
npm run mock &           # or in another terminal
node scripts/smoke.mjs   # TMDB, accounts, uploads, concurrency cap, the live event stream, the source pipeline, the subtitle backfill (two titles repaired, one source fetch each), the autopilot, watched folder, cleanup

# …when the dashboard runs with a custom DATA_DIR:
SMOKE_BASE_URL=http://127.0.0.1:4791 SMOKE_DATA_DIR=data-smoke2 node scripts/smoke.mjs
```

`tests/jobs.test.ts` pins the hand-off: when a job finishes, the catalogue entry
is written first and then handed to the repair hook, tracks and all, so the
queue always reads the entry the publish actually produced.

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
the byte counts and that nothing was left on disk. It then publishes two
English-only titles whose cue file the pipeline could not read, runs the
Library's batch fill-in for both, and — counting the requests its origin
answered — checks that each title's source track was downloaded exactly once
before the caption landed on the video that already existed.

`tests/subtitles.test.ts` covers the text side of captions: SRT→WebVTT
conversion, cue settings and multi-line text surviving a round trip, language
normalisation (`en-US`, `ENG`, *English*, *العربية*), the HLS timestamp map, and
the rule that a translated cue keeps its original timing (and falls back to the
original text rather than blanking). `tests/translate.test.ts` drives the DeepL
scraper against a fake endpoint: the request shape (no key anywhere, the
`LMT_handle_texts` body, the `"method"` whitespace that follows the call id, the
i-count timestamp adjustment, lowercase source and uppercase target), chunking a
long cue list with the order preserved, a blank cue that is never sent, refusing a
reply with the wrong number of cues, and surfacing a refusal or a non-JSON answer
as a translation error rather than a crash. The source pipeline tests then run it
for real: an origin that declares English and Arabic renditions has both attached,
an origin with only English has an Arabic track translated out of the cue **text**
(the fake DeepL records exactly what it was sent, and the timings are asserted to
be untouched), one English track becomes Arabic, French and Spanish captions from
one read of the source text, and with translation switched off the missing
languages are noted rather than invented.

`tests/backfill.test.ts` does the same for the Library action, over a real origin
and a stand-in for DeepL: a published entry is translated from the subtitle the
catalogue recorded and the caption lands on its existing video (timings intact),
a title missing three languages gets all three from one read of the source text,
a batch of titles is shown to download each source track exactly once (the origin
counts its requests: three titles times two languages is six translations but
three downloads, and re-running the batch fetches nothing at all), one language
refusing still lands the others and says which did not, an entry with no recorded
track is recovered from its master playlist instead, a source that is gone is
reported against the title with nothing written, and a batch limit, an explicit
key list, a missing account and translation switched off each do the right
nothing. The automatic pass is driven from the same file: a publish that left a
language missing is queued and healed without a button, a second event for the
same title is not queued twice, a refusal is retried and then left to the
Library after the budget, a rate limit that clears lands on the retry, a title
with no readable source is never queued, and the setting turns it all off. The
smoke script makes the read-once guarantee end to end: its origin counts what it
is asked for, and a batch of two published titles must produce exactly two source
downloads.

`tests/autopilot.test.ts` drives the autopilot against a canned TMDB: it checks
that a page is processed highest rating first, that a below-floor or **unrated**
title is stepped over, that a page cut short by the per-cycle cap is not advanced,
that the list wraps at the end, that a cycle with nothing to queue retries the
failed jobs, that a deep queue pauses the cycle, and that settings are validated.
`tests/hostguard.test.ts` covers the politeness guard: pacing and per-host
serialisation, `Retry-After`, the escalating cooldown, and the bot-wall sniffing
that keeps a challenge page from being mistaken for a source.

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
