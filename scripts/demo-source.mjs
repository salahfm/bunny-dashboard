/**
 * A local HLS origin, for trying the one-click source flow without touching a
 * third-party host (and without a working internet connection).
 *
 *   node scripts/demo-source.mjs            # http://127.0.0.1:4800/master.m3u8
 *   node scripts/demo-source.mjs 8123       # pick the port
 *
 * Paste the master URL into the dashboard's **Source URL** tab and press
 * *Download & upload*: the dashboard reads the ladder, takes the 1080p variant,
 * downloads the four segments and hands them to Bunny by whichever transport is
 * available. Each segment is delayed a little so the progress column has
 * something to show.
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 4800);

const SEGMENTS = [
  Buffer.alloc(400 * 1024, 7),
  Buffer.alloc(350 * 1024, 9),
  Buffer.alloc(300 * 1024, 11),
  Buffer.alloc(250 * 1024, 13),
];

const mediaPlaylist = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  ...SEGMENTS.flatMap((_, index) => ['#EXTINF:6.000,', `seg${index}.ts`]),
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const masterPlaylist = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
  'v720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
  'v1080/index.m3u8',
  '',
].join('\n');

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/master.m3u8') {
    response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return void response.end(masterPlaylist);
  }
  if (url.pathname.endsWith('/index.m3u8')) {
    response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return void response.end(mediaPlaylist);
  }

  const segment = /^\/v\d+\/seg(\d)\.ts$/.exec(url.pathname);
  if (segment) {
    const body = SEGMENTS[Number(segment[1])];
    if (!body) {
      response.writeHead(404);
      return void response.end('no such segment');
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    setTimeout(() => {
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]) + 1, body.length) : body.length;
        response.writeHead(206, {
          'content-type': 'video/mp2t',
          'content-range': `bytes ${start}-${end - 1}/${body.length}`,
          'content-length': String(end - start),
        });
        return void response.end(body.subarray(start, end));
      }
      response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(body.length) });
      response.end(body);
    }, 250);
    return;
  }

  response.writeHead(404);
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`demo HLS origin on http://127.0.0.1:${port}/master.m3u8 (1080p + 720p, ${SEGMENTS.length} segments)`);
});
