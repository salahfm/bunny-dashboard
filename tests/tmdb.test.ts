import assert from 'node:assert/strict';
import test from 'node:test';
import { TmdbClient, TmdbError, lookupTmdb } from '../src/tmdb';

test('mock mode answers search, ids, IMDb ids and seasons', async () => {
  const client = new TmdbClient({}, { mock: true });

  const results = await client.search('inception');
  assert.equal(results[0]?.title, 'Inception');
  assert.equal(results[0]?.mediaType, 'movie');

  const movie = await client.movie(27205);
  assert.equal(movie.title, 'Inception');
  assert.equal(movie.year, '2010');

  const show = await client.tv(1396);
  assert.equal(show.title, 'Breaking Bad');
  assert.equal(show.seasons.length, 5);

  const episodes = await client.season(1396, 1);
  assert.equal(episodes.length, 7);
  assert.equal(episodes[0]?.episodeNumber, 1);

  const found = await client.find('tt0903747');
  assert.equal(found[0]?.mediaType, 'tv');
  assert.equal(found[0]?.tmdbId, 1396);
});

test('lookupTmdb resolves bare ids, IMDb ids and TMDB links', async () => {
  const client = new TmdbClient({}, { mock: true });

  const byId = await lookupTmdb(client, '1396');
  assert.ok(byId.some((entry) => entry.mediaType === 'tv' && entry.tmdbId === 1396));

  const byImdb = await lookupTmdb(client, 'tt1375666');
  assert.equal(byImdb[0]?.title, 'Inception');

  const byUrl = await lookupTmdb(client, 'https://www.themoviedb.org/movie/27205-inception');
  assert.equal(byUrl[0]?.tmdbId, 27205);

  const byTitle = await lookupTmdb(client, 'breaking bad');
  assert.ok(byTitle.some((entry) => entry.mediaType === 'tv'));
});

test('the API key travels as a query parameter', async () => {
  let seen = '';
  let headers: Record<string, string> = {};
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new TmdbClient({ apiKey: 'abc123' }, { fetchImpl });
  await client.search('test');
  assert.ok(seen.includes('api_key=abc123'));
  assert.equal(headers.authorization, undefined);
});

test('an access token travels as a bearer header', async () => {
  let headers: Record<string, string> = {};
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new TmdbClient({ accessToken: 'token-xyz' }, { fetchImpl });
  await client.search('test');
  assert.equal(headers.authorization, 'Bearer token-xyz');
});

test('missing credentials and 401 responses produce clear errors', async () => {
  const bare = new TmdbClient({}, { fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch });
  await assert.rejects(bare.search('x'), (error: unknown) => error instanceof TmdbError && error.status === 401);

  const unauthorized = new TmdbClient(
    { apiKey: 'nope' },
    { fetchImpl: (async () => new Response(JSON.stringify({ status_message: 'Invalid API key' }), { status: 401 })) as typeof fetch },
  );
  await assert.rejects(unauthorized.search('x'), (error: unknown) => error instanceof TmdbError && error.status === 401);
});
