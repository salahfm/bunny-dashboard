/**
 * Small TMDB client for the dashboard. It speaks the public v3 API with either
 * an API key or a v4 access token, and it can run against a canned dataset
 * (`mock: true`) so the whole dashboard is testable without a TMDB account.
 */

export interface TmdbAuth {
  apiKey?: string;
  accessToken?: string;
}

export interface TmdbSearchResult {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year?: string;
  overview: string;
  posterPath: string | null;
  voteAverage?: number;
}

export interface TmdbMovie {
  tmdbId: number;
  title: string;
  year?: string;
  overview: string;
  posterPath: string | null;
  runtime?: number;
  genres: string[];
}

export interface TmdbSeason {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  posterPath: string | null;
}

export interface TmdbShow {
  tmdbId: number;
  title: string;
  year?: string;
  overview: string;
  posterPath: string | null;
  seasons: TmdbSeason[];
}

export interface TmdbTopRated {
  results: TmdbSearchResult[];
  page: number;
  totalPages: number;
}

export interface TmdbEpisode {
  episodeNumber: number;
  name: string;
  overview: string;
  stillPath: string | null;
  airDate?: string;
}

export class TmdbError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TmdbError';
    if (status !== undefined) this.status = status;
  }
}

interface TmdbClientOptions {
  fetchImpl?: typeof fetch;
  mock?: boolean;
  baseUrl?: string;
}

interface RawMulti {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  vote_average?: number;
}

interface RawMovie {
  id?: number;
  title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  runtime?: number;
  genres?: Array<{ name?: string }>;
}

interface RawTv {
  id?: number;
  name?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  seasons?: Array<{ season_number?: number; name?: string; episode_count?: number; poster_path?: string | null }>;
}

interface RawSeason {
  episodes?: Array<{ episode_number?: number; name?: string; overview?: string; still_path?: string | null; air_date?: string | null }>;
}

function yearOf(date: string | null | undefined): string | undefined {
  if (!date) return undefined;
  const year = date.slice(0, 4);
  return /^\d{4}$/.test(year) ? year : undefined;
}

function normalizeMulti(item: RawMulti): TmdbSearchResult {
  return {
    tmdbId: Number(item.id),
    mediaType: 'movie',
    title: item.title ?? '',
    ...(yearOf(item.release_date) ? { year: yearOf(item.release_date) } : {}),
    overview: item.overview ?? '',
    posterPath: item.poster_path ?? null,
    ...(item.vote_average !== undefined ? { voteAverage: item.vote_average } : {}),
  };
}

function normalizeShowMulti(item: RawMulti): TmdbSearchResult {
  return {
    tmdbId: Number(item.id),
    mediaType: 'tv',
    title: item.name ?? '',
    ...(yearOf(item.first_air_date) ? { year: yearOf(item.first_air_date) } : {}),
    overview: item.overview ?? '',
    posterPath: item.poster_path ?? null,
    ...(item.vote_average !== undefined ? { voteAverage: item.vote_average } : {}),
  };
}

export class TmdbClient {
  private auth: TmdbAuth;
  private opts: TmdbClientOptions;

  constructor(auth: TmdbAuth, options: TmdbClientOptions = {}) {
    this.auth = auth;
    this.opts = options;
  }

  private async request<T>(pathname: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    if (this.opts.mock) return mockRequest(pathname, params) as T;
    const base = this.opts.baseUrl ?? 'https://api.themoviedb.org/3';
    const url = new URL(base + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.auth.accessToken) headers.authorization = `Bearer ${this.auth.accessToken}`;
    else if (this.auth.apiKey) url.searchParams.set('api_key', this.auth.apiKey);
    else throw new TmdbError('TMDB is not configured — add an API key or access token in Settings.', 401);

    const response = await (this.opts.fetchImpl ?? fetch)(url, { headers });
    if (!response.ok) {
      let detail = '';
      try {
        const body = (await response.json()) as { status_message?: string };
        detail = body.status_message ?? '';
      } catch {
        /* not every error is JSON */
      }
      const hint = response.status === 401 ? ' — check the credential in Settings' : '';
      throw new TmdbError(`TMDB request failed (${response.status})${detail ? `: ${detail}` : hint}`, response.status);
    }
    return (await response.json()) as T;
  }

  async search(query: string, page = 1): Promise<TmdbSearchResult[]> {
    const body = await this.request<{ results?: RawMulti[] }>('/search/multi', { query, page, include_adult: 'false' });
    const results: TmdbSearchResult[] = [];
    for (const item of body.results ?? []) {
      if (item.media_type === 'movie') results.push(normalizeMulti(item));
      else if (item.media_type === 'tv') results.push(normalizeShowMulti(item));
    }
    return results;
  }

  /**
   * TMDB's top-rated list for movies or shows, highest rating first.
   *
   * The endpoint is already ordered by its weighted score, but the results are
   * sorted again by `voteAverage` here so the caller's "process the best first"
   * rule is guaranteed by this client rather than assumed of the API.
   */
  async topRated(mediaType: 'movie' | 'tv', page = 1): Promise<TmdbTopRated> {
    const safePage = Math.max(1, Math.floor(page) || 1);
    const body = await this.request<{ results?: RawMulti[]; page?: number; total_pages?: number }>(
      mediaType === 'movie' ? '/movie/top_rated' : '/tv/top_rated',
      { page: safePage },
    );
    const results: TmdbSearchResult[] = [];
    for (const item of body.results ?? []) {
      results.push(mediaType === 'movie' ? normalizeMulti(item) : normalizeShowMulti(item));
    }
    results.sort((a, b) => (b.voteAverage ?? 0) - (a.voteAverage ?? 0));
    const totalPages = Number(body.total_pages);
    return {
      results,
      page: Number.isFinite(Number(body.page)) ? Number(body.page) : safePage,
      totalPages: Number.isFinite(totalPages) && totalPages > 0 ? Math.floor(totalPages) : 1,
    };
  }

  async movie(id: number): Promise<TmdbMovie> {
    const raw = await this.request<RawMovie>(`/movie/${id}`, { append_to_response: 'external_ids' });
    return {
      tmdbId: Number(raw.id ?? id),
      title: raw.title ?? `Movie ${id}`,
      ...(yearOf(raw.release_date) ? { year: yearOf(raw.release_date) } : {}),
      overview: raw.overview ?? '',
      posterPath: raw.poster_path ?? null,
      ...(raw.runtime !== undefined ? { runtime: raw.runtime } : {}),
      genres: (raw.genres ?? []).flatMap((genre) => (genre.name ? [genre.name] : [])),
    };
  }

  async tv(id: number): Promise<TmdbShow> {
    const raw = await this.request<RawTv>(`/tv/${id}`);
    const seasons: TmdbSeason[] = (raw.seasons ?? [])
      .filter((season) => (season.season_number ?? 0) > 0)
      .map((season) => ({
        seasonNumber: Number(season.season_number),
        name: season.name ?? `Season ${season.season_number}`,
        episodeCount: Number(season.episode_count ?? 0),
        posterPath: season.poster_path ?? null,
      }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
    return {
      tmdbId: Number(raw.id ?? id),
      title: raw.name ?? `Show ${id}`,
      ...(yearOf(raw.first_air_date) ? { year: yearOf(raw.first_air_date) } : {}),
      overview: raw.overview ?? '',
      posterPath: raw.poster_path ?? null,
      seasons,
    };
  }

  async season(tvId: number, seasonNumber: number): Promise<TmdbEpisode[]> {
    const raw = await this.request<RawSeason>(`/tv/${tvId}/season/${seasonNumber}`);
    return (raw.episodes ?? []).map((episode) => ({
      episodeNumber: Number(episode.episode_number ?? 0),
      name: episode.name ?? `Episode ${episode.episode_number}`,
      overview: episode.overview ?? '',
      stillPath: episode.still_path ?? null,
      ...(episode.air_date ? { airDate: episode.air_date } : {}),
    }));
  }

  /** Resolve an IMDb id (tt…) to whatever TMDB knows about it. */
  async find(externalId: string): Promise<TmdbSearchResult[]> {
    const body = await this.request<{ movie_results?: RawMovie[]; tv_results?: RawTv[] }>(
      `/find/${encodeURIComponent(externalId)}`,
      { external_source: 'imdb_id' },
    );
    const results: TmdbSearchResult[] = [];
    for (const raw of body.movie_results ?? []) {
      results.push({
        tmdbId: Number(raw.id),
        mediaType: 'movie',
        title: raw.title ?? '',
        ...(yearOf(raw.release_date) ? { year: yearOf(raw.release_date) } : {}),
        overview: raw.overview ?? '',
        posterPath: raw.poster_path ?? null,
      });
    }
    for (const raw of body.tv_results ?? []) {
      results.push({
        tmdbId: Number(raw.id),
        mediaType: 'tv',
        title: raw.name ?? '',
        ...(yearOf(raw.first_air_date) ? { year: yearOf(raw.first_air_date) } : {}),
        overview: raw.overview ?? '',
        posterPath: raw.poster_path ?? null,
      });
    }
    return results;
  }
}

/* ------------------------------------------------------------------ */
/* Lookup helpers                                                      */
/* ------------------------------------------------------------------ */

async function entryFromId(client: TmdbClient, id: number, mediaType: 'movie' | 'tv'): Promise<TmdbSearchResult> {
  if (mediaType === 'movie') {
    const movie = await client.movie(id);
    return { tmdbId: movie.tmdbId, mediaType: 'movie', title: movie.title, year: movie.year, overview: movie.overview, posterPath: movie.posterPath };
  }
  const show = await client.tv(id);
  return { tmdbId: show.tmdbId, mediaType: 'tv', title: show.title, year: show.year, overview: show.overview, posterPath: show.posterPath };
}

/** Accepts a title, a bare TMDB id (movie or show), an IMDb id, or a themoviedb.org URL. */
export async function lookupTmdb(client: TmdbClient, query: string): Promise<TmdbSearchResult[]> {
  const urlMatch = query.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
  if (urlMatch) {
    return [await entryFromId(client, Number(urlMatch[2]), urlMatch[1]?.toLowerCase() === 'tv' ? 'tv' : 'movie')];
  }
  if (/^tt\d+$/i.test(query)) return client.find(query);
  if (/^\d+$/.test(query)) {
    const id = Number(query);
    const results: TmdbSearchResult[] = [];
    for (const mediaType of ['movie', 'tv'] as const) {
      try {
        results.push(await entryFromId(client, id, mediaType));
      } catch {
        /* the id belongs to the other media type */
      }
    }
    if (results.length === 0) throw new TmdbError(`TMDB has no movie or show with id ${id}`, 404);
    return results;
  }
  return client.search(query);
}

/* ------------------------------------------------------------------ */
/* Canned dataset used when the server runs with --mock                */
/* ------------------------------------------------------------------ */

const MOCK_MOVIES: Array<{ data: TmdbMovie; votes: number }> = [
  { votes: 8.4, data: { tmdbId: 27205, title: 'Inception', year: '2010', overview: 'A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea.', posterPath: null, runtime: 148, genres: ['Action', 'Science Fiction', 'Adventure'] } },
  { votes: 8.4, data: { tmdbId: 157336, title: 'Interstellar', year: '2014', overview: 'Explorers travel through a wormhole in an attempt to ensure humanity’s survival.', posterPath: null, runtime: 169, genres: ['Adventure', 'Drama', 'Science Fiction'] } },
  { votes: 8.2, data: { tmdbId: 603, title: 'The Matrix', year: '1999', overview: 'A hacker learns the true nature of his reality and his role in the war against its controllers.', posterPath: null, runtime: 136, genres: ['Action', 'Science Fiction'] } },
  { votes: 8.4, data: { tmdbId: 550, title: 'Fight Club', year: '1999', overview: 'An insomniac office worker and a soap salesman build an underground fight club.', posterPath: null, runtime: 139, genres: ['Drama', 'Thriller'] } },
  { votes: 8.5, data: { tmdbId: 680, title: 'Pulp Fiction', year: '1994', overview: 'The lives of two mob hitmen, a boxer and a pair of diner bandits intertwine.', posterPath: null, runtime: 154, genres: ['Thriller', 'Crime'] } },
];

const MOCK_SHOWS: Array<{ votes: number; episodes: number[]; data: Omit<TmdbShow, 'seasons'> }> = [
  { votes: 8.9, episodes: [7, 13, 13, 13, 16], data: { tmdbId: 1396, title: 'Breaking Bad', year: '2008', overview: 'A chemistry teacher diagnosed with cancer turns to manufacturing methamphetamine.', posterPath: null } },
  { votes: 8.6, episodes: [8, 9, 8, 9], data: { tmdbId: 66732, title: 'Stranger Things', year: '2016', overview: 'When a boy vanishes, a small town uncovers a mystery of secret experiments and supernatural forces.', posterPath: null } },
  { votes: 8.7, episodes: [9, 9], data: { tmdbId: 94605, title: 'Arcane', year: '2021', overview: 'Amid the stark discord of twin cities, two sisters fight on rival sides of a war.', posterPath: null } },
  { votes: 8.7, episodes: [10, 10, 10, 10, 10, 13], data: { tmdbId: 60059, title: 'Better Call Saul', year: '2015', overview: 'The trials and tribulations of criminal lawyer Jimmy McGill in the years before Breaking Bad.', posterPath: null } },
];

const MOCK_IMDB: Record<string, TmdbSearchResult> = {
  tt1375666: { tmdbId: 27205, mediaType: 'movie', title: 'Inception', year: '2010', overview: 'A thief who steals corporate secrets through dream-sharing technology.', posterPath: null },
  tt0816692: { tmdbId: 157336, mediaType: 'movie', title: 'Interstellar', year: '2014', overview: 'Explorers travel through a wormhole.', posterPath: null },
  tt0903747: { tmdbId: 1396, mediaType: 'tv', title: 'Breaking Bad', year: '2008', overview: 'A chemistry teacher turns to manufacturing methamphetamine.', posterPath: null },
  tt4574334: { tmdbId: 66732, mediaType: 'tv', title: 'Stranger Things', year: '2016', overview: 'A small town uncovers a mystery.', posterPath: null },
};

function mockSeasons(show: { episodes: number[]; data: Omit<TmdbShow, 'seasons'> }): TmdbSeason[] {
  return show.episodes.map((count, index) => ({
    seasonNumber: index + 1,
    name: `Season ${index + 1}`,
    episodeCount: count,
    posterPath: null,
  }));
}

function mockShow(id: number): TmdbShow {
  const match = MOCK_SHOWS.find((show) => show.data.tmdbId === id);
  if (match) return { ...match.data, seasons: mockSeasons(match) };
  return {
    tmdbId: id,
    title: `Library show ${id}`,
    year: '2026',
    overview: 'A synthetic show generated by the mock provider.',
    posterPath: null,
    seasons: [
      { seasonNumber: 1, name: 'Season 1', episodeCount: 8, posterPath: null },
      { seasonNumber: 2, name: 'Season 2', episodeCount: 8, posterPath: null },
    ],
  };
}

function hash(input: string): number {
  let value = 5381;
  for (let index = 0; index < input.length; index += 1) value = ((value << 5) + value + input.charCodeAt(index)) >>> 0;
  return value;
}

function mockSearch(query: string): TmdbSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: TmdbSearchResult[] = [];
  for (const movie of MOCK_MOVIES) {
    if (movie.data.title.toLowerCase().includes(needle)) {
      results.push({ tmdbId: movie.data.tmdbId, mediaType: 'movie', title: movie.data.title, year: movie.data.year, overview: movie.data.overview, posterPath: movie.data.posterPath, voteAverage: movie.votes });
    }
  }
  for (const show of MOCK_SHOWS) {
    if (show.data.title.toLowerCase().includes(needle)) {
      results.push({ tmdbId: show.data.tmdbId, mediaType: 'tv', title: show.data.title, year: show.data.year, overview: show.data.overview, posterPath: show.data.posterPath, voteAverage: show.votes });
    }
  }
  if (results.length === 0) {
    results.push({
      tmdbId: 900000 + (hash(needle) % 99999),
      mediaType: 'movie',
      title: query.trim(),
      year: '2026',
      overview: 'A synthetic result, because the mock provider has no catalogue match. Run without --mock for the real TMDB.',
      posterPath: null,
    });
  }
  return results;
}

const MOCK_TOP_RATED_PAGE_SIZE = 20;

/**
 * A synthetic top-rated list: the canned titles plus filler, best rated first.
 *
 * One generated entry deliberately carries no rating so the offline autopilot
 * exercises the "no rating" rule, and the list is long enough to page.
 */
function mockTopRated(mediaType: 'movie' | 'tv', page: number): { results: unknown[]; page: number; total_pages: number } {
  const base: Array<{ tmdbId: number; title: string; year?: string; overview: string; rating?: number }> =
    mediaType === 'movie'
      ? MOCK_MOVIES.map((entry) => ({ tmdbId: entry.data.tmdbId, title: entry.data.title, year: entry.data.year, overview: entry.data.overview, rating: entry.votes }))
      : MOCK_SHOWS.map((entry) => ({ tmdbId: entry.data.tmdbId, title: entry.data.title, year: entry.data.year, overview: entry.data.overview, rating: entry.votes }));
  const all = [...base];
  for (let index = 0; index < 45; index += 1) {
    all.push({
      tmdbId: (mediaType === 'movie' ? 810_000 : 710_000) + index,
      title: `${mediaType === 'movie' ? 'Top movie' : 'Top show'} ${index + 1}`,
      year: '2026',
      overview: 'A synthetic top-rated entry generated by the mock provider.',
      ...(index === 3 ? {} : { rating: Math.max(0, 9.5 - index * 0.2) }),
    });
  }
  all.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const start = Math.max(0, (page - 1) * MOCK_TOP_RATED_PAGE_SIZE);
  const results = all.slice(start, start + MOCK_TOP_RATED_PAGE_SIZE).map((entry) => ({
    id: entry.tmdbId,
    ...(mediaType === 'movie'
      ? { media_type: 'movie', title: entry.title, release_date: `${entry.year ?? '2026'}-01-01` }
      : { media_type: 'tv', name: entry.title, first_air_date: `${entry.year ?? '2026'}-01-01` }),
    overview: entry.overview,
    poster_path: null,
    ...(entry.rating !== undefined ? { vote_average: entry.rating } : {}),
  }));
  return { results, page, total_pages: Math.max(1, Math.ceil(all.length / MOCK_TOP_RATED_PAGE_SIZE)) };
}

function mockRequest(pathname: string, params: Record<string, string | number | undefined>): unknown {
  const topRated = /^\/(movie|tv)\/top_rated$/.exec(pathname);
  if (topRated) return mockTopRated(topRated[1] === 'tv' ? 'tv' : 'movie', Math.max(1, Math.floor(Number(params.page ?? 1)) || 1));
  const seasonMatch = pathname.match(/^\/tv\/(\d+)\/season\/(\d+)$/);
  if (seasonMatch) {
    const tvId = Number(seasonMatch[1]);
    const seasonNumber = Number(seasonMatch[2]);
    const show = MOCK_SHOWS.find((entry) => entry.data.tmdbId === tvId);
    const episodeCount = show?.episodes[seasonNumber - 1] ?? 8;
    return {
      episodes: Array.from({ length: episodeCount }, (_, index) => ({
        episode_number: index + 1,
        name: `Episode ${index + 1}`,
        overview: `Mock episode ${index + 1} of show ${tvId}, season ${seasonNumber}.`,
        still_path: null,
        air_date: null,
      })),
    };
  }
  const movieMatch = pathname.match(/^\/movie\/(\d+)$/);
  if (movieMatch) {
    const id = Number(movieMatch[1]);
    const match = MOCK_MOVIES.find((movie) => movie.data.tmdbId === id);
    if (match) {
      return {
        id: match.data.tmdbId,
        title: match.data.title,
        release_date: match.data.year ? `${match.data.year}-01-01` : undefined,
        overview: match.data.overview,
        poster_path: match.data.posterPath,
        runtime: match.data.runtime,
        genres: match.data.genres.map((name) => ({ name })),
      };
    }
    return { id, title: `Library movie ${id}`, release_date: '2026-01-01', overview: 'A synthetic movie generated by the mock provider.', poster_path: null, runtime: 100, genres: [{ name: 'Drama' }] };
  }
  const tvMatch = pathname.match(/^\/tv\/(\d+)$/);
  if (tvMatch) {
    const show = mockShow(Number(tvMatch[1]));
    return { id: show.tmdbId, name: show.title, first_air_date: `${show.year}-01-01`, overview: show.overview, poster_path: show.posterPath, seasons: show.seasons.map((season) => ({ season_number: season.seasonNumber, name: season.name, episode_count: season.episodeCount, poster_path: null })) };
  }
  const findMatch = pathname.match(/^\/find\/(.+)$/);
  if (findMatch) {
    const found = MOCK_IMDB[decodeURIComponent(findMatch[1] as string)];
    if (!found) return { movie_results: [], tv_results: [] };
    return found.mediaType === 'movie'
      ? { movie_results: [{ id: found.tmdbId, title: found.title, release_date: `${found.year}-01-01`, overview: found.overview, poster_path: null }], tv_results: [] }
      : { movie_results: [], tv_results: [{ id: found.tmdbId, name: found.title, first_air_date: `${found.year}-01-01`, overview: found.overview, poster_path: null }] };
  }
  if (pathname === '/search/multi') {
    const raw = mockSearch(String(params.query ?? ''));
    return {
      results: raw.map((item) =>
        item.mediaType === 'movie'
          ? { id: item.tmdbId, media_type: 'movie', title: item.title, release_date: `${item.year}-01-01`, overview: item.overview, poster_path: null, vote_average: item.voteAverage }
          : { id: item.tmdbId, media_type: 'tv', name: item.title, first_air_date: `${item.year}-01-01`, overview: item.overview, poster_path: null, vote_average: item.voteAverage },
      ),
    };
  }
  throw new TmdbError(`mock provider does not know ${pathname}`, 404);
}
