# Deploying to bunny.net Magic Containers

Magic Containers runs this dashboard on bunny.net's own network — the same place
Bunny Stream lives — so the machine that downloads sources, serves the relay and
talks to the Stream API is a datacenter host rather than your PC or home
internet. No Cloudflare tunnel is needed: the app's own endpoint is public, so
Bunny pulls the relay over its own network.

## What you need

- A **GitHub account** (free, no card) with this project pushed to a repository.
  The repository can be private; only the image needs to be reachable by Bunny
  (see step 2).
- A **bunny.net account** with Magic Containers access. The Deploy App page
  states it plainly: “A payment card is required to use Magic Containers during
  the trial”, with $30 in trial credits and no automatic charge — so this is not
  a card-free host, whatever the marketing page suggests.

## 1. Push this project to GitHub

From this folder, once (uses your connection for a couple of megabytes):

```bash
git init -b main
git add .github Dockerfile docker-compose.yml package.json package-lock.json src public
git commit -m "Dashboard"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.github/workflows/publish-image.yml` then builds the image and pushes it to
`ghcr.io/<you>/<repo>:latest` on every push to `main`.

## 2. Let Bunny pull the image

- Public package: nothing to do — Magic Containers finds `ghcr.io/<you>/<repo>`
  in the GitHub registry search.
- Private package (private repo): in the Bunny dashboard go to **Magic
  Containers → Image Registries**, add a private GitHub registry and use a
  GitHub token with `read:packages` as the password.

## If the image does not show up

“We couldn't load images from one of your selected registries. Check its
credentials and try again.” is what the Deploy App page says when there is
nothing to list, not only when a token is bad:

- **The image has not been built yet.** Finish step 1 and wait for the
  “Publish container image” Action to go green, then open
  `https://github.com/<you>?tab=packages` and confirm the package exists.
  Reopen the Deploy App page (or reconnect the GitHub registry chip) and search
  again.
- **The package is private** (a private repository produces a private package,
  and the *Public* GitHub registry cannot see it). Either open the package on
  GitHub → Package settings → Change visibility → Public, or add a private
  registry in Bunny with a `read:packages` token (step 2).
- **Sanity check:** switch the registry chips to DockerHub Public and search
  `nginx`. If that lists results, the page works and only the GitHub side is
  empty.

## 3. Create the app

**Magic Containers → + Add App**, then:

| Setting | Value |
| --- | --- |
| Image | `ghcr.io/<you>/<repo>:latest` |
| Endpoint | type **CDN**, container port **4747** (this is also the relay's public URL) |
| Volume | name `dashboard-data`, mount path **`/data`**, size **10 GB** (trial limit is 30 GB, 1 volume) |
| Region | one region — pick the one nearest you; a single region keeps the cost down |

Environment variables:

```
HOST=0.0.0.0
PORT=4747
DATA_DIR=/data
SCRATCH_DIR=/dev/shm/bunny-publisher
DASHBOARD_USER=index
DASHBOARD_PASSWORD=<your password>
SOURCE_TUNNEL=0
SOURCE_TUNNEL_DOWNLOAD=0
TUNNEL_PUBLIC_URL=https://<the endpoint hostname Bunny shows for the app>
```

`DASHBOARD_PASSWORD` is what puts a login in front of the endpoint: your browser
will prompt for it, and every page and API route is behind it. Leave it out and
the whole dashboard is public — the process warns you at startup if it is
listening beyond localhost with no password. `GET /api/health` and `/relay/...`
stay open on purpose: the platform health check and Bunny Stream cannot log in,
and the relay URL carries its own random token.

`SOURCE_TUNNEL=0` and `SOURCE_TUNNEL_DOWNLOAD=0` stop the dashboard from ever
starting a quick tunnel or fetching cloudflared inside the container, and
`TUNNEL_PUBLIC_URL` is the public base the pipeline uses in every case — so the
relay is served on the app's own bunny.net endpoint and Bunny Stream is told to
fetch it there instead of through a tunnel from your PC.

`SCRATCH_DIR` keeps a scraped title's working file off the volume: a stream is
downloaded and uploaded at the same time out of one scratch file, and a single
1080p title can occupy gigabytes while it runs. `/dev/shm` is the container's own
RAM disk, the path is created at startup, and nothing put there outlives its job
— the file is deleted as soon as the job finishes. Size it against how many
streams run at once (the memory counts towards the container's limit), or leave
`SCRATCH_DIR` unset and the working files go to `/data/uploads` as before.

Optional: `UPLOAD_MODE=tus`, `NETWORK_TIMEOUT_MS=30000`, `NETWORK_RETRIES=3`.

**After the first deploy:** in the app's **Scaling** settings pin it to
**exactly one instance in one region**. The JSON store is single-process, and
every pod gets its own blank volume — a second instance would keep a separate
copy of the queue and split your state.

Then open the endpoint, add your Bunny library (name, library ID, Stream API key)
in **Settings**, and press **Check network** — the Bunny API row should be green
from inside bunny.net.

## What it costs

Trial: free for 14 days (see the card note above), limited to one app, three
regions, three instances per region, one volume up to 30 GB. After the trial,
pay-as-you-go for one always-on instance:

| Item | Price | 1 core + 1 GB + 10 GB |
| --- | --- | --- |
| CPU | $0.02 per core/hour | ≈ $14.60 / month |
| RAM | $0.005 per GB/hour | ≈ $3.65 / month |
| Persistent storage | $0.10 per GB/month | $1.00 / month |
| Network | $0.01 per GB (EU/NA) | ~$0.04 per 2 GB film pulled to Bunny |

So roughly **$15–19 per month** for the smallest sensible instance. Volumes are
capped at **10 MB/s read and 10 MB/s write** each way, which slows a 2 GB source
to about 3.5 minutes per direction — the pipeline still streams download and
upload at the same time, it just does so at that ceiling.

If you stop the app, remember detached volumes keep billing until deleted from
the **Volumes** tab.
