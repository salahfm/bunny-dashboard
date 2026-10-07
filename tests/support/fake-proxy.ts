/**
 * A proxy on loopback that remembers what was asked of it.
 *
 * The point of the proxy pool is that some requests go through it and some must
 * not, and the only honest way to test that is to have a proxy that can say what
 * it saw. So: it records what it was asked for, relays what it is meant to relay,
 * and can be told to refuse instead — which is how a plan that has run out of
 * bandwidth (402) and a credential that no longer works (407) are replayed.
 *
 * It speaks both shapes a real proxy gets, because they are not interchangeable:
 *
 *   - `CONNECT host:port`, then raw HTTP inside the tunnel. This is what a client
 *     sends for most destinations, and the tunnel is terminated here and relayed
 *     with one header added, which is how a test tells the exits apart.
 *   - a plain request in absolute form (`GET http://host/path`), which some
 *     clients use for `http://` destinations.
 *
 * A `CONNECT` it is refusing is answered before the tunnel opens, exactly as a
 * spent plan does — so the refusal path a test pins is the one production hits.
 */
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { parseProxyEntry, type ProxyEndpoint } from '../../src/proxies';

export interface FakeProxyOptions {
  /** The address it listens on. */
  host?: string;
  /** Refuse every request with this status instead of relaying it. */
  refuseWith?: number;
  /** Label of the exit, so two fake proxies in one test stay apart. */
  name?: string;
}

export interface FakeProxyRequest {
  /** What was asked of the proxy: an absolute URL, or `host:port` for a CONNECT. */
  target: string;
  method: string;
  /** The credentials the client sent, when it sent any. */
  authorization?: string;
  /** True for a `CONNECT` — a tunnel through this proxy. */
  tunnel: boolean;
}

export interface FakeProxy {
  /** `http://user:pass@host:port`, ready to hand to a ProxyPool. */
  endpoint: ProxyEndpoint;
  /** One entry per proxy-level interaction: a CONNECT or an absolute-form request. */
  requests: FakeProxyRequest[];
  /** Every URL relayed, in order — the "what did it actually carry?" list. */
  forwarded: string[];
  /** Refuse (or stop refusing) from here on. */
  refuse(status?: number): void;
  /** The exit's address, credentials and all. */
  url(): string;
  close(): Promise<void>;
}

/** A username long enough to look like a provider's, with a password to match. */
const USERNAME = 'proxyuser';
const PASSWORD = 'proxypass';

function statusText(status: number): string {
  return status === 402 ? 'Payment Required' : status === 407 ? 'Proxy Authentication Required' : 'Refused';
}

export async function startFakeProxy(options: FakeProxyOptions = {}): Promise<FakeProxy> {
  const requests: FakeProxyRequest[] = [];
  const forwarded: string[] = [];
  let refuseWith = options.refuseWith;
  const name = options.name ?? 'proxy';

  /**
   * Relays one request to the site and copies the answer back, with the exit's
   * own name attached: the origin cannot tell one loopback exit from another by
   * address, and that header is what lets a test block exactly one of them — the
   * way a host blocking one address looks from inside.
   */
  const relay = (req: http.IncomingMessage, res: http.ServerResponse, absolute: boolean): void => {
    // An absolute-form request names the whole URL; one that came through a
    // tunnel only names the path, because the client already said where the
    // tunnel goes — which is exactly how a real proxy sees the two.
    const raw = absolute ? req.url ?? '/' : `http://${req.headers.host ?? ''}${req.url ?? '/'}`;
    if (!/^https?:\/\/[^/]+\//i.test(raw)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('this is a proxy: send an absolute URL or CONNECT');
      return;
    }
    forwarded.push(raw);
    const target = new URL(raw);
    const headers = { ...req.headers, host: target.host } as http.OutgoingHttpHeaders;
    // The exit's credentials are for the proxy, not for the site behind it.
    delete headers['proxy-authorization'];
    headers['x-fake-proxy'] = name;

    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('the proxy could not reach the target');
    });
    req.pipe(upstream);
  };

  // Absolute-form requests arrive on the listening socket; tunneled ones are
  // handed to this server's parser afterwards, so both end up in `relay`.
  const server = http.createServer((req, res) => {
    if (refuseWith) {
      requests.push({ target: req.url ?? '', method: req.method ?? 'GET', tunnel: false, ...auth(req) });
      res.writeHead(refuseWith, { 'content-type': 'text/plain' });
      res.end(`the proxy refused: HTTP ${refuseWith}`);
      return;
    }
    relay(req, res, true);
  });

  // Never listened on: sockets from a CONNECT are handed to its parser instead.
  const tunneled = http.createServer((req, res) => relay(req, res, false));

  server.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    requests.push({ target: req.url ?? '', method: 'CONNECT', tunnel: true, ...auth(req) });
    if (refuseWith) {
      socket.write(`HTTP/1.1 ${refuseWith} ${statusText(refuseWith)}\r\ncontent-length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) socket.unshift(head);
    // The tunnel carries plain requests to a plain origin in these tests, which
    // is what the real thing carries to an `https://` one.
    tunneled.emit('connection', socket);
  });

  await new Promise<void>((resolve) => server.listen(0, options.host ?? '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const parsed = parseProxyEntry(`${USERNAME}:${PASSWORD}@127.0.0.1:${port}`)!;
  // Two fake proxies in one test share the address shape, so the label is given:
  // the pool keeps its health per label.
  const endpoint: ProxyEndpoint = options.name ? { ...parsed, label: options.name } : parsed;

  return {
    endpoint,
    requests,
    forwarded,
    refuse(status?: number) {
      refuseWith = status;
    },
    url() {
      return endpoint.url;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function auth(req: http.IncomingMessage): { authorization?: string } {
  const value = req.headers['proxy-authorization'];
  return value ? { authorization: String(value) } : {};
}

/** The `Proxy-Authorization` value these fake proxies expect to see. */
export const FAKE_PROXY_AUTHORIZATION = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
