/*
 * The dashboard UI. Plain DOM, no framework, no build step.
 *
 * Everything user-supplied or API-supplied (titles, file names, provider names,
 * error text) is written with textContent — there is no innerHTML anywhere in
 * this file, so a release name or a host's error message cannot become markup.
 */
(() => {
  'use strict';

  const state = {
    health: null,
    settings: null,
    providers: [],
    accounts: [],
    jobs: [],
    stats: null,
    target: null,
    episode: null,
    seasons: [],
    episodes: [],
    selectedJobId: null,
    /** The full job behind the selected row (candidates included), fetched on demand. */
    jobDetail: null,
    library: [],
    libraryStats: null,
    libraryMatched: null,
    /** What the subtitle backfill would work on, as `/api/subtitles/backfill` reports it. */
    backfill: null,
    /** The missing/has counts for the search and kind currently on screen. */
    librarySubtitles: null,
    librarySelectedKey: null,
    libraryEntry: null,
    /**
     * The R2 archive queue, by catalogue key.
     *
     * Archiving runs on the server's own queue, so this is the only place the
     * browser learns how far a title has got: seeded from `/api/archive` when the
     * Library is read, then kept current by the `archive` events on the stream.
     */
    archiveTasks: {},
    /** What R2 holds and could be re-checked, as `/api/archive` reports it. */
    archiveVerify: [],
    /** What R2 holds and could be put back into Bunny. */
    archiveRestore: [],
    /** What a check flagged and a targeted repair could mend. */
    archiveRepair: [],
    /** The scheduled re-check: when it next runs, and what the last sweep found. */
    archiveCheck: null,
    /** The shared watermark: one image and one placement, used by every account. */
    watermark: null,
    /** The last read-back report: what bunny.net holds, per library. */
    libraryCheck: null,
    tunnel: null,
    autopilot: null,
    only: new Set(),
    /** Whether the live event stream is connected — the queue's own indicator. */
    live: false,
    /** The open EventSource, so the stream is only ever connected once. */
    events: null,
    activeTab: 'titles',
    diagnosticsRan: false,
  };

  /* ---------------------------------------------------------------- dom */

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'html') throw new Error('innerHTML is not used in this UI');
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = String(value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const $ = (selector) => document.querySelector(selector);

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function toast(message, kind = '') {
    const node = $('#toast');
    node.className = `toast ${kind}`;
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.add('hidden'), kind === 'bad' ? 12000 : 5000);
  }

  function describeError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  /* ---------------------------------------------------------------- api */

  async function api(method, path, body, contentType) {
    const init = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      if (body instanceof Blob || typeof body === 'string') {
        init.body = body;
        if (contentType) init.headers['content-type'] = contentType;
      } else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    const response = await fetch(path, init);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* some responses are plain text */
    }
    if (!response.ok) throw new Error((json && json.error) || `${response.status} ${response.statusText}`);
    return json;
  }

  function bytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let index = 0;
    let size = n;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
  }

  function shortTime(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString();
  }

  /**
   * A timestamp as a person reads it: the clock time when it is today, the full
   * date when it is not. A weekly check's "next pass" is a week away, so a bare
   * time of day would read as "in a few minutes".
   */
  function whenLabel(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString() : date.toLocaleString();
  }

  function fmtDuration(ms) {
    const seconds = Math.max(0, Math.round(Number(ms) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  /* --------------------------------------------------------------- tabs */

  function showTab(name) {
    state.activeTab = name;
    for (const button of document.querySelectorAll('.nav-item')) {
      button.classList.toggle('is-active', button.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('is-active', panel.id === `tab-${name}`);
    }
    if (name === 'queue') void refreshJobs();
    if (name === 'autopilot') void refreshAutopilot();
    if (name === 'library') void refreshLibrary();
    if (name === 'accounts') void refreshAccounts();
    if (name === 'watch') void refreshWatch();
    if (name === 'source') void refreshTunnel();
    if (name === 'settings') {
      void refreshSettings();
      // The network check probes every host and takes seconds; do it once when
      // the tab is first opened and leave the rest to the button.
      if (!state.diagnosticsRan) {
        state.diagnosticsRan = true;
        void runNetworkCheck();
      }
    }
  }

  $('#nav').addEventListener('click', (event) => {
    const button = event.target.closest('.nav-item');
    if (button) showTab(button.dataset.tab);
  });

  /* ------------------------------------------------------------- search */

  async function runSearch() {
    const query = $('#search-input').value.trim();
    if (!query) return;
    const list = clear($('#search-results'));
    list.append(h('div', { class: 'list-item' }, h('span', { class: 'muted small', text: 'searching…' })));
    try {
      const looksLikeId = /^(tt\d+|\d+)$/i.test(query);
      const data = looksLikeId
        ? await api('GET', `/api/tmdb/lookup?q=${encodeURIComponent(query)}`)
        : await api('GET', `/api/tmdb/search?q=${encodeURIComponent(query)}`);
      clear(list);
      const results = data.results ?? [];
      if (!results.length) {
        list.append(h('div', { class: 'list-item' }, h('span', { class: 'muted small', text: 'nothing found' })));
        return;
      }
      for (const result of results) {
        list.append(
          h(
            'div',
            { class: 'list-item' },
            h(
              'div',
              { class: 'grow' },
              h('span', { class: 'title', text: `${result.title}${result.year ? ` (${result.year})` : ''}` }),
              h('span', { class: 'muted small', text: `${result.mediaType === 'tv' ? 'TV' : 'Movie'} · TMDB ${result.tmdbId}${result.voteAverage ? ` · ${result.voteAverage}` : ''}` }),
            ),
            h('button', { text: 'Select', onclick: () => selectTarget(result) }),
          ),
        );
      }
    } catch (error) {
      clear(list);
      list.append(h('div', { class: 'list-item' }, h('span', { class: 'small', text: describeError(error) })));
    }
  }

  $('#search-button').addEventListener('click', () => void runSearch());
  $('#search-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void runSearch();
  });

  async function selectTarget(result) {
    state.target = { mediaType: result.mediaType, tmdbId: result.tmdbId, title: result.title, year: result.year };
    state.episode = null;
    state.episodes = [];
    state.seasons = [];
    $('#target-panel').classList.remove('hidden');
    $('#target-title').textContent = `${result.title}${result.year ? ` (${result.year})` : ''}`;
    $('#target-meta').textContent = `${result.mediaType === 'tv' ? 'TV show' : 'Movie'} · TMDB ${result.tmdbId}`;

    const seasonPicker = $('#season-picker');
    const episodeList = clear($('#episode-list'));
    seasonPicker.classList.add('hidden');
    $('#preview-output').classList.add('hidden');
    $('#series-buttons').classList.toggle('hidden', result.mediaType !== 'tv');

    if (result.mediaType !== 'tv') {
      state.episode = null;
      episodeList.append(h('div', { class: 'list-item' }, h('span', { class: 'small', text: 'Movie selected — the publish buttons apply to it directly.' })));
      return;
    }

    try {
      const data = await api('GET', `/api/tmdb/tv/${result.tmdbId}`);
      state.seasons = data.show?.seasons ?? [];
      const select = clear($('#season-select'));
      for (const season of state.seasons) {
        select.append(h('option', { value: String(season.seasonNumber), text: `${season.name ?? `Season ${season.seasonNumber}`} · ${season.episodeCount} episodes` }));
      }
      seasonPicker.classList.remove('hidden');
      await loadSeason(Number(select.value));
    } catch (error) {
      episodeList.append(h('div', { class: 'list-item' }, h('span', { class: 'small', text: describeError(error) })));
    }
  }

  /**
   * Draws the episode picker from the season already loaded. Selecting an episode
   * only re-renders these rows — it must not refetch the season, and the
   * selection is keyed on season *and* episode so switching seasons cannot leave
   * a stale pick from the previous one in place.
   */
  function renderEpisodes(seasonNumber) {
    const list = clear($('#episode-list'));
    for (const episode of state.episodes) {
      const selected = state.episode?.season === seasonNumber && state.episode?.episode === episode.episodeNumber;
      list.append(
        h(
          'div',
          { class: 'list-item' },
          h(
            'div',
            { class: 'grow' },
            h('span', { class: 'title', text: `E${String(episode.episodeNumber).padStart(2, '0')} · ${episode.name}` }),
            h('span', { class: 'muted small', text: episode.airDate ?? '' }),
          ),
          h('button', {
            class: selected ? 'is-selected' : '',
            text: selected ? 'selected' : 'select',
            onclick: () => {
              state.episode = { season: seasonNumber, episode: episode.episodeNumber, name: episode.name };
              renderEpisodes(seasonNumber);
            },
          }),
        ),
      );
    }
  }

  async function loadSeason(seasonNumber) {
    if (!state.target) return;
    // A different season invalidates the episode picked from the old one.
    if (state.episode && state.episode.season !== seasonNumber) state.episode = null;
    const list = clear($('#episode-list'));
    list.append(h('div', { class: 'list-item' }, h('span', { class: 'muted small', text: 'loading episodes…' })));
    try {
      const data = await api('GET', `/api/tmdb/tv/${state.target.tmdbId}/season/${seasonNumber}`);
      state.episodes = data.episodes ?? [];
      if (!state.episode && state.episodes.length) {
        state.episode = { season: seasonNumber, episode: state.episodes[0].episodeNumber, name: state.episodes[0].name };
      }
      renderEpisodes(seasonNumber);
    } catch (error) {
      clear(list).append(h('div', { class: 'list-item' }, h('span', { class: 'small', text: describeError(error) })));
    }
  }

  $('#season-select').addEventListener('change', (event) => void loadSeason(Number(event.target.value)));
  $('#target-clear').addEventListener('click', () => {
    state.target = null;
    state.episode = null;
    $('#target-panel').classList.add('hidden');
  });

  /* ------------------------------------------------------- target helpers */

  function targetPayload() {
    if (!state.target) return undefined;
    const base = { kind: 'movie', tmdbId: state.target.tmdbId, title: state.target.title };
    if (state.target.year) base.year = state.target.year;
    if (state.target.mediaType === 'tv') {
      if (!state.episode) return undefined;
      return {
        kind: 'episode',
        tmdbId: state.target.tmdbId,
        title: state.target.title,
        ...(state.target.year ? { year: state.target.year } : {}),
        season: state.episode.season,
        episode: state.episode.episode,
        ...(state.episode.name ? { episodeTitle: state.episode.name } : {}),
      };
    }
    return base;
  }

  function scrapeOptions() {
    const only = [...state.only];
    return {
      ...(only.length ? { only } : {}),
      minHeight: Number($('#min-height').value) || 0,
    };
  }

  function publishTarget() {
    const payload = targetPayload();
    if (!payload) {
      toast('Pick a title first (and an episode, for a show).', 'bad');
      return undefined;
    }
    return payload;
  }

  /* ------------------------------------------------------------ scraping */

  $('#scrape-button').addEventListener('click', async () => {
    const target = publishTarget();
    if (!target) return;
    try {
      const data = await api('POST', '/api/jobs/source', { target, ...scrapeOptions() });
      toast(`queued: ${data.job?.target?.title ?? 'job'} — watching the queue`, 'ok');
      showTab('queue');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#preview-button').addEventListener('click', async () => {
    const target = publishTarget();
    if (!target) return;
    const output = $('#preview-output');
    output.classList.remove('hidden');
    output.textContent = 'probing sources…';
    try {
      const data = await api('POST', '/api/sources/preview', { target, ...scrapeOptions(), limit: 5 });
      const lines = [`pick: ${data.note}`];
      for (const candidate of data.candidates ?? []) {
        lines.push(
          `${candidate.chosen ? '*' : ' '} ${String(candidate.height || '?').padStart(4)}p  ${candidate.provider.padEnd(10)} ${candidate.quality.padEnd(8)} ${candidate.note ?? ''}`,
        );
      }
      for (const failure of data.failures ?? []) lines.push(`  ${failure.provider}: ${failure.reason}`);
      output.textContent = lines.join('\n');
    } catch (error) {
      output.textContent = describeError(error);
    }
  });

  $('#remote-button').addEventListener('click', async () => {
    const target = publishTarget();
    if (!target) return;
    const url = $('#remote-url').value.trim();
    if (!url) {
      toast('Paste a direct media URL for Bunny to fetch.', 'bad');
      return;
    }
    try {
      await api('POST', '/api/jobs/remote', { target, url });
      toast('Bunny will fetch that URL itself', 'ok');
      showTab('queue');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const target = publishTarget();
    if (!target) return;
    try {
      await api(
        'POST',
        `/api/jobs/upload?meta=${encodeURIComponent(JSON.stringify(target))}&name=${encodeURIComponent(file.name)}`,
        file,
        file.type || 'application/octet-stream',
      );
      toast(`uploading ${file.name}`, 'ok');
      showTab('queue');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  /* ------------------------------------------------------------ bulk add */

  function bulkReport(data) {
    const created = data.created ?? [];
    const skipped = data.skipped ?? [];
    const lines = [`queued ${created.length} job(s) — ${data.counts?.movies ?? 0} movie(s), ${data.counts?.episodes ?? 0} episode(s)`];
    if (data.truncated) lines.push('the list hit the per-paste cap — the rest was left alone');
    for (const skip of skipped.slice(0, 25)) lines.push(`  skipped “${skip.line}” — ${skip.reason}`);
    if (skipped.length > 25) lines.push(`  … and ${skipped.length - 25} more skipped`);
    return lines.join('\n');
  }

  $('#bulk-add').addEventListener('click', async () => {
    const text = $('#bulk-input').value.trim();
    if (!text) {
      toast('Paste a list first — one title, id or link per line.', 'bad');
      return;
    }
    const output = $('#bulk-output');
    output.classList.remove('hidden');
    output.textContent = 'resolving the list on TMDB…';
    try {
      const data = await api('POST', '/api/jobs/bulk', {
        text,
        minHeight: Number($('#bulk-min-height').value) || 0,
        expandSeries: $('#bulk-expand').checked,
        ...(state.only.size ? { only: [...state.only] } : {}),
      });
      output.textContent = bulkReport(data);
      const created = (data.created ?? []).length;
      toast(created ? `queued ${created} job(s)` : 'nothing new to queue', created ? 'ok' : '');
      if (created) showTab('queue');
    } catch (error) {
      output.textContent = describeError(error);
      toast(describeError(error), 'bad');
    }
  });

  async function queueSeries(scope) {
    if (!state.target || state.target.mediaType !== 'tv') {
      toast('Pick a TV show from the search results first.', 'bad');
      return;
    }
    const seasonNumber = Number($('#season-select').value);
    if (scope === 'season' && !Number.isFinite(seasonNumber)) {
      toast('Pick a season first.', 'bad');
      return;
    }
    try {
      const data = await api('POST', '/api/jobs/series', {
        target: {
          tmdbId: state.target.tmdbId,
          title: state.target.title,
          ...(state.target.year ? { year: state.target.year } : {}),
        },
        ...(scope === 'season' ? { seasons: [seasonNumber] } : {}),
        ...scrapeOptions(),
      });
      const created = (data.created ?? []).length;
      const skipped = (data.skipped ?? []).length;
      toast(`queued ${created} episode(s)${skipped ? ` — ${skipped} skipped (${data.skipped[0].reason})` : ''}`, 'ok');
      showTab('queue');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  $('#series-season-button').addEventListener('click', () => void queueSeries('season'));
  $('#series-all-button').addEventListener('click', () => void queueSeries('all'));

  /* --------------------------------------------------------- source input */

  $('#source-send').addEventListener('click', async () => {
    const url = $('#source-url').value.trim();
    if (!url) {
      toast('Paste a source URL first.', 'bad');
      return;
    }
    const title = $('#source-title').value.trim();
    const tmdbId = $('#source-tmdb').value.trim();
    const body = {
      url,
      minHeight: Number($('#source-min-height').value) || 0,
      ...(title ? { title } : {}),
      ...(/^\d+$/.test(tmdbId) ? { target: { kind: 'movie', tmdbId: Number(tmdbId), title: title || `TMDB ${tmdbId}` } } : {}),
    };
    try {
      const data = await api('POST', '/api/jobs/source', body);
      toast(`queued: ${data.job?.source?.name ?? 'source job'}`, 'ok');
      showTab('queue');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  async function refreshTunnel() {
    try {
      const data = await api('GET', '/api/tunnel');
      state.tunnel = data.status;
      const running = data.status?.state === 'running' && data.status?.url;
      $('#tunnel-badge').textContent = `tunnel: ${data.status?.state ?? 'unknown'}`;
      $('#tunnel-status').textContent = running
        ? `running · ${data.status.url}${data.status.external ? ' (from the environment)' : ''}`
        : `${data.status?.state ?? 'unknown'}${data.status?.detail ? ` — ${data.status.detail}` : ''}`;
      const output = clear($('#tunnel-output'));
      if (data.logs?.length) {
        output.classList.remove('hidden');
        output.textContent = data.logs.join('\n');
      }
    } catch (error) {
      $('#tunnel-status').textContent = describeError(error);
    }
  }

  $('#tunnel-start').addEventListener('click', async () => {
    toast('starting cloudflared…');
    await refreshTunnel();
    try {
      await api('POST', '/api/tunnel/start');
      await refreshTunnel();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#tunnel-stop').addEventListener('click', async () => {
    try {
      await api('POST', '/api/tunnel/stop');
      await refreshTunnel();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  /* ---------------------------------------------------------------- jobs */

  function statusBadge(status) {
    return h('span', { class: `status ${status}`, text: status });
  }

  function progressBar(job) {
    const percent = Math.max(0, Math.min(100, Number(job.progress) || 0));
    return h('div', { class: 'bar', title: `${percent}%` }, h('span', { style: `width:${percent}%` }), h('em', { text: `${percent}%` }));
  }

  function sourceCell(job) {
    const parts = [];
    if (job.source?.kind === 'stream') {
      parts.push(job.source.mode === 'scrape' ? 'scraped' : 'source URL');
      if (job.source.provider) parts.push(job.source.provider);
      if (job.source.quality) parts.push(job.source.quality);
      if (job.transport) parts.push(job.transport === 'tunnel' ? 'bunny pull' : 'direct upload');
    } else {
      parts.push(job.source?.kind ?? '—');
    }
    return h('span', { class: 'mono', text: parts.filter(Boolean).join(' · ') });
  }

  async function refreshJobs(options = {}) {
    const quiet = options.quiet === true;
    let data;
    try {
      data = await api('GET', `/api/jobs?limit=200${$('#queue-filter').value ? `&status=${$('#queue-filter').value}` : ''}`);
    } catch (error) {
      // A background refresh must not shout while the server restarts.
      if (!quiet) toast(describeError(error), 'bad');
      return;
    }
    state.stats = data.stats ?? null;
    applyJobsList(data.jobs ?? []);
    renderCounts();
    if (state.selectedJobId) void refreshSelectedDetail({ quiet: true });
  }

  /**
   * Reconciles the table with a fresh list, patching only what moved.
   *
   * The old code cleared the table and rebuilt every row on each refresh, which
   * is what made a long queue flicker and jump while one job was downloading.
   * Now a row that is still there keeps its element and its place.
   */
  function applyJobsList(list) {
    const seen = new Set();
    for (const job of list) {
      seen.add(job.id);
      upsertJobRow(job);
    }
    for (const job of [...state.jobs]) {
      if (!seen.has(job.id)) removeJobRow(job.id);
    }
    state.jobs = list;
    // A first load on an empty queue has no rows to remove, so the placeholder
    // is drawn here rather than only when the last row leaves.
    showEmptyQueue();
  }

  /**
   * The queue counters, without the job list. Polled while the Queue tab is not
   * on screen so the header badge stays live without downloading every row.
   */
  async function refreshStats() {
    try {
      state.stats = await api('GET', '/api/queue/stats');
      renderCounts();
    } catch {
      /* keep the last known counts while the server is unreachable */
    }
  }

  function renderCounts() {
    const stats = state.stats;
    const counts = stats?.counts ?? {};
    $('#queue-badge').textContent = `${stats?.active ?? 0} active · ${stats?.queued ?? 0} queued`;
    $('#queue-summary').textContent = stats
      ? `uploading ${counts.uploading ?? 0} · encoding ${counts.encoding ?? 0} · ready ${counts.ready ?? 0} · failed ${counts.failed ?? 0} · cancelled ${counts.cancelled ?? 0} · capacity ${stats.capacity}`
      : '';
  }

  /**
   * Every queue row currently on screen, by job id.
   *
   * Holding onto the element is what lets a change replace exactly one row
   * instead of the whole table.
   */
  const jobRows = new Map();

  /** The fields a row renders — a row is only rebuilt when one of them moves. */
  function jobRowSignature(job) {
    return JSON.stringify([
      job.status,
      job.progress,
      job.detail ?? '',
      job.stage ?? '',
      job.statusCode ?? '',
      job.source?.kind ?? '',
      job.source?.mode ?? '',
      job.source?.provider ?? '',
      job.source?.quality ?? '',
      job.transport ?? '',
      job.bytesIn ?? 0,
      job.bytesOut ?? 0,
      job.totalBytes ?? 0,
      job.accountName ?? '',
      job.error ?? '',
      job.playbackUrl ?? '',
    ]);
  }

  /** The queue table's body, with the "no jobs" placeholder cleared away. */
  function queueBody() {
    const body = $('#jobs-table tbody');
    // A real row is about to land, so the placeholder has no business staying.
    body.querySelector('tr.placeholder')?.remove();
    return body;
  }

  /** Puts the "no jobs" placeholder back once the last row has left. */
  function showEmptyQueue() {
    const body = $('#jobs-table tbody');
    if (jobRows.size > 0 || body.firstElementChild) return;
    body.append(h('tr', { class: 'placeholder' }, h('td', { colspan: '7', class: 'muted', text: 'no jobs' })));
  }

  /** One queue row, freshly built. */
  function jobRow(job) {
    const actions = h('td', { class: 'actions' });
    if (job.status === 'failed' || job.status === 'cancelled') {
      actions.append(h('button', { text: 'retry', onclick: () => void jobAction(job.id, 'retry') }));
    }
    if (['queued', 'uploading', 'encoding'].includes(job.status)) {
      actions.append(h('button', { text: 'cancel', onclick: () => void jobAction(job.id, 'cancel') }));
    } else {
      actions.append(h('button', { text: 'delete', onclick: () => void jobAction(job.id, 'delete') }));
    }
    if (job.playbackUrl) {
      actions.append(h('a', { href: job.playbackUrl, target: '_blank', rel: 'noreferrer', text: 'play' }));
    }

    const detail = job.status === 'failed' && job.error ? h('span', { class: 'small', style: 'color:var(--bad)', text: job.error }) : null;

    const row = h(
      'tr',
      { onclick: (event) => (event.target.closest('button,a') ? undefined : selectJob(job.id)) },
      h(
        'td',
        {},
        h('span', { text: job.target?.kind === 'episode' ? `${job.target.title} S${String(job.target.season).padStart(2, '0')}E${String(job.target.episode).padStart(2, '0')}` : `${job.target?.title ?? '—'}${job.target?.year ? ` (${job.target.year})` : ''}` }),
        detail,
      ),
      h('td', {}, statusBadge(job.status)),
      h('td', {}, progressBar(job), h('span', { class: 'small muted', text: job.detail ?? '' })),
      h('td', { class: 'mono' }, job.stage ?? (job.status === 'encoding' ? `encoding${job.statusCode !== undefined ? ` · bunny ${job.statusCode}` : ''}` : '—')),
      h('td', {}, sourceCell(job), h('span', { class: 'small muted', text: job.source?.kind === 'stream' ? `${bytes(job.bytesIn)} in · ${bytes(job.bytesOut)} out${job.totalBytes ? ` of ${bytes(job.totalBytes)}` : ''}` : '' })),
      h('td', { class: 'mono', text: job.accountName ?? '—' }),
      actions,
    );
    row.dataset.jobId = job.id;
    row.dataset.createdAt = job.createdAt ?? '';
    row.dataset.sig = jobRowSignature(job);
    if (job.id === state.selectedJobId) row.classList.add('is-selected');
    return row;
  }

  /** The whole table in one pass — the first paint, and the fallback path. */
  function renderJobs() {
    const body = clear($('#jobs-table tbody'));
    jobRows.clear();
    for (const job of state.jobs) {
      const row = jobRow(job);
      jobRows.set(job.id, row);
      body.append(row);
    }
    showEmptyQueue();
  }

  /**
   * Adds or refreshes one row, leaving every other row alone.
   *
   * A row whose rendered fields have not moved is left exactly as it is, so a
   * queue where one job is downloading only ever redraws that one job.
   */
  function upsertJobRow(job, options = {}) {
    const existing = jobRows.get(job.id);
    if (existing && existing.dataset.sig === jobRowSignature(job)) return;
    const row = jobRow(job);
    jobRows.set(job.id, row);
    if (existing) {
      existing.replaceWith(row);
      // Only a change that arrived from the live stream flashes; a plain
      // re-read of the list redraws quietly.
      if (options.flash === true) {
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 900);
      }
      return;
    }
    const body = queueBody();
    // Newest first, matching the order the API returns.
    for (const sibling of body.children) {
      if ((sibling.dataset.createdAt ?? '') < (job.createdAt ?? '')) {
        body.insertBefore(row, sibling);
        return;
      }
    }
    body.append(row);
  }

  function removeJobRow(id) {
    const row = jobRows.get(id);
    if (!row) return;
    row.remove();
    jobRows.delete(id);
    showEmptyQueue();
  }

  /* ------------------------------------------------------------ live queue */

  /** Whether a job belongs in the table as it is currently filtered. */
  function jobMatchesFilter(job) {
    const filter = $('#queue-filter').value;
    return !filter || job.status === filter;
  }

  /**
   * Applies one batch of changes from the live stream.
   *
   * A job that no longer matches the filter is treated as gone, so filtering to
   * "encoding" and watching a job finish removes its row the moment it does.
   */
  function applyJobsDelta(entries) {
    let added = false;
    let movedSelection = false;
    for (const entry of entries) {
      const job = entry.job;
      const index = state.jobs.findIndex((item) => item.id === job.id);
      if (entry.kind === 'removed' || !jobMatchesFilter(job)) {
        if (index >= 0) state.jobs.splice(index, 1);
        removeJobRow(job.id);
        if (job.id === state.selectedJobId) {
          state.selectedJobId = null;
          state.jobDetail = null;
          renderJobDetail();
        }
        continue;
      }
      if (index >= 0) state.jobs[index] = job;
      else {
        state.jobs.push(job);
        added = true;
      }
      upsertJobRow(job, { flash: true });
      if (job.id === state.selectedJobId) movedSelection = true;
    }
    if (added) state.jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (movedSelection && state.jobDetail) {
      // The open job's panel is fed by the same pushed row, keeping its stage
      // and byte counts current without a second request per progress tick.
      // What the one-off fetch added (the candidate ladder) is kept.
      const fresh = state.jobs.find((item) => item.id === state.selectedJobId);
      if (fresh) {
        state.jobDetail = { ...state.jobDetail, ...fresh };
        renderJobDetail();
      }
    }
  }

  function parseEvent(event) {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }

  /** Shows whether the live stream is up, in the queue's own header. */
  function setLive(live) {
    state.live = live;
    const badge = $('#queue-live');
    if (!badge) return;
    badge.classList.toggle('is-live', live);
    badge.classList.toggle('is-down', !live);
    badge.title = live
      ? 'connected — the queue updates itself as jobs move'
      : 'the live stream is reconnecting; the list is refreshed on a slow timer meanwhile';
    $('#queue-live-text').textContent = live ? 'live' : 'reconnecting…';
  }

  /**
   * The dashboard's one live connection.
   *
   * It replaces the old "refresh every 2 s" checkbox: the server pushes what
   * changed, whenever it changes, and the header badge stays right even while
   * another tab is on screen. `EventSource` reconnects by itself after a server
   * restart; while it is down, a slow poll covers the gap.
   */
  function connectEvents() {
    if (state.events) return;
    const source = new EventSource('/api/events');
    state.events = source;
    source.addEventListener('open', () => setLive(true));
    source.addEventListener('error', () => setLive(false));
    source.addEventListener('hello', (event) => {
      setLive(true);
      const payload = parseEvent(event);
      if (payload?.stats) {
        state.stats = payload.stats;
        renderCounts();
      }
    });
    source.addEventListener('stats', (event) => {
      const payload = parseEvent(event);
      if (payload) {
        state.stats = payload;
        renderCounts();
      }
    });
    source.addEventListener('jobs', (event) => {
      const payload = parseEvent(event);
      if (payload) applyJobsDelta(payload.jobs ?? []);
    });
    source.addEventListener('catalog', () => {
      // A title finished publishing — or an archive recorded what it did: the
      // Library tab should show it, not wait for the next click.
      if (state.activeTab === 'library') void refreshLibrary({ quiet: true });
    });
    source.addEventListener('archive', (event) => {
      const payload = parseEvent(event);
      if (!payload) return;
      applyArchiveDelta(payload.tasks ?? []);
    });
  }

  function selectJob(jobId) {
    if (state.selectedJobId === jobId) {
      state.selectedJobId = null;
      state.jobDetail = null;
      renderJobs();
      renderJobDetail();
      return;
    }
    state.selectedJobId = jobId;
    state.jobDetail = null;
    renderJobs();
    renderJobDetail();
    void refreshSelectedDetail({ quiet: true });
  }

  /** Fetches the selected job's full record (its candidate ladder included). */
  async function refreshSelectedDetail(options = {}) {
    const jobId = state.selectedJobId;
    if (!jobId) return;
    try {
      const data = await api('GET', `/api/jobs/${jobId}`);
      if (state.selectedJobId !== jobId) return;
      state.jobDetail = data.job ?? null;
      renderJobDetail();
    } catch (error) {
      if (options.quiet !== true) toast(describeError(error), 'bad');
    }
  }

  /** The subtitle tracks a job or a catalogue record was published with. */
  function subtitlesTable(tracks) {
    return h(
      'table',
      { class: 'table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: 'Lang' }),
          h('th', { text: 'Label' }),
          h('th', { text: 'State' }),
          h('th', { text: 'Cues' }),
          h('th', { text: 'Came from' }),
          h('th', { text: 'Note' }),
        ),
      ),
      h(
        'tbody',
        {},
        ...tracks.map((track) =>
          h(
            'tr',
            {},
            h('td', { class: 'mono', text: track.srclang ?? '—' }),
            h('td', { text: track.label ?? '—' }),
            h('td', { class: 'small', text: track.uploaded ? (track.translated ? 'translated' : 'uploaded') : 'not attached' }),
            h('td', { class: 'mono small', text: track.cues !== undefined ? String(track.cues) : '—' }),
            h('td', { class: 'mono small', text: track.translatedFrom ? `${track.translatedFrom} → ${track.srclang}` : track.url ? 'scraped' : '—' }),
            h('td', { class: 'muted small', text: track.note ?? '' }),
          ),
        ),
      ),
    );
  }

  function renderJobDetail() {
    const box = clear($('#job-detail'));
    const loaded = state.jobDetail && state.jobDetail.id === state.selectedJobId ? state.jobDetail : null;
    const job = loaded ?? state.jobs.find((entry) => entry.id === state.selectedJobId);
    if (!job) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.append(
      h('div', { class: 'box-head' }, h('strong', { text: `${job.target?.title ?? 'job'} · ${job.id}` }), h('button', { class: 'link', text: 'close', onclick: () => selectJob(job.id) })),
      h('div', { class: 'muted small', text: `created ${shortTime(job.createdAt)} · updated ${shortTime(job.updatedAt)}${job.finishedAt ? ` · finished ${shortTime(job.finishedAt)}` : ''}` }),
    );
    const rows = [
      ['status', job.status + (job.error ? ` — ${job.error}` : '')],
      ['library name', job.libraryName ?? '—'],
      ['stage', job.stage ?? '—'],
      ['detail', job.detail ?? '—'],
      ['source', job.source?.url ?? job.source?.input ?? job.source?.tempPath ?? '—'],
      ['input', job.source?.input ?? '—'],
      ['transport', job.transport ? `${job.transport}${job.transport === 'tunnel' ? ' (Bunny pulls this machine through the tunnel)' : ' (uploaded by this dashboard)'}` : '—'],
      ['bytes', `in ${bytes(job.bytesIn)} · out ${bytes(job.bytesOut)} · total ${bytes(job.totalBytes)}`],
      ['relay', job.relayToken ? `live (token ${job.relayToken.slice(0, 8)}…)` : 'not published'],
      ['attempts', String(job.attempts ?? 0)],
    ];
    box.append(
      h(
        'table',
        { class: 'table' },
        h('tbody', {}, ...rows.map(([label, value]) => h('tr', {}, h('th', { text: label }), h('td', { class: 'mono', text: String(value) })))),
      ),
    );
    if (!loaded) box.append(h('div', { class: 'muted small', text: 'loading the full job…' }));
    if (Array.isArray(job.candidates) && job.candidates.length) {
      box.append(h('h2', { text: 'Sources found' }));
      box.append(
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Tier' }), h('th', { text: 'Host' }), h('th', { text: 'Note' }), h('th', { text: 'URL' }))),
          h(
            'tbody',
            {},
            ...job.candidates.map((candidate) =>
              h(
                'tr',
                {},
                h('td', { text: candidate.chosen ? 'chosen' : '' }),
                h('td', { class: 'mono', text: candidate.height ? `${candidate.height}p` : candidate.quality }),
                h('td', { text: candidate.provider }),
                h('td', { class: 'muted small', text: candidate.note ?? '' }),
                h('td', { class: 'mono small', text: candidate.url.length > 90 ? `${candidate.url.slice(0, 90)}…` : candidate.url }),
              ),
            ),
          ),
        ),
      );
    }
    const subtitles = Array.isArray(job.subtitles) ? job.subtitles : [];
    box.append(h('h2', { text: `Subtitles${subtitles.length ? ` (${subtitles.length})` : ''}` }));
    if (subtitles.length) box.append(subtitlesTable(subtitles));
    else box.append(h('div', { class: 'muted small', text: 'no subtitle track was carried for this job' }));
  }

  async function jobAction(jobId, action) {
    try {
      if (action === 'delete') await api('DELETE', `/api/jobs/${jobId}`);
      else await api('POST', `/api/jobs/${jobId}/${action}`);
      if (action === 'delete' && state.selectedJobId === jobId) {
        state.selectedJobId = null;
        state.jobDetail = null;
      }
      await refreshJobs();
      renderJobDetail();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  $('#queue-filter').addEventListener('change', () => void refreshJobs());

  $('#queue-retry-failed').addEventListener('click', async () => {
    try {
      const data = await api('POST', '/api/jobs/retry-failed', {});
      toast(data.retried ? `retrying ${data.retried} failed job(s)` : 'no failed jobs', data.retried ? 'ok' : '');
      await refreshJobs();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  /* ------------------------------------------------------------- library */

  /** The size that best describes a published title (declared, or the bytes that moved). */
  function librarySize(entry) {
    return entry.bytes?.declared ?? entry.bytes?.file ?? entry.bytes?.downloaded ?? 0;
  }

  function formatHeaders(headers) {
    const entries = Object.entries(headers ?? {});
    if (!entries.length) return '—';
    return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
  }

  async function refreshLibrary(options = {}) {
    const quiet = options.quiet === true;
    const params = new URLSearchParams();
    const query = $('#library-search').value.trim();
    const kind = $('#library-kind').value;
    const subtitles = $('#library-subtitles').value;
    if (query) params.set('q', query);
    if (kind) params.set('kind', kind);
    if (subtitles) params.set('subtitles', subtitles);
    let data;
    try {
      data = await api('GET', `/api/catalog${params.toString() ? `?${params}` : ''}`);
    } catch (error) {
      if (!quiet) toast(describeError(error), 'bad');
      return;
    }
    state.library = data.items ?? [];
    state.libraryStats = data.stats ?? null;
    state.libraryMatched = typeof data.matched === 'number' ? data.matched : null;
    state.librarySubtitles = data.subtitles ?? null;
    // The archive queue lives on the server, so a fresh page (or a reconnect)
    // has to read it once before the `archive` events can keep it current.
    try {
      const queue = await api('GET', '/api/archive');
      seedArchiveTasks(queue?.tasks ?? []);
      state.archiveVerify = queue?.verify ?? [];
      state.archiveRestore = queue?.restore ?? [];
      state.archiveRepair = queue?.repair ?? [];
    } catch {
      /* the archive is optional: a failure to read it must not blank the Library */
    }
    renderLibrary();
    renderLibraryDetail();
    // The backfill count is the same list, read the same way, so it is refreshed
    // with the tab rather than on a timer of its own.
    if (!quiet) void refreshBackfill();
  }

  /**
   * Closes the open record.
   *
   * Called when the list is *deliberately* narrowed — not on every refresh: a
   * title that just left the filter (because it was filled in, say) should keep
   * its record on screen, and the slow background poll must not close it.
   */
  function closeLibraryDetail() {
    state.librarySelectedKey = null;
    state.libraryEntry = null;
    renderLibraryDetail();
  }

  /* ------------------------------------------------- subtitle backfill */

  /**
   * What the backfill would do: which published titles have no caption in the
   * target language yet. Purely a report — no title is touched until the button
   * is pressed.
   */
  async function refreshBackfill() {
    try {
      state.backfill = await api('GET', '/api/subtitles/backfill');
    } catch {
      /* the button keeps whatever it last said */
      return;
    }
    renderBackfill();
    // The rows' own fill-in buttons come from the same report, so the table is
    // redrawn once it arrives rather than left a moment behind.
    if (state.library.length) renderLibrary();
  }

  function renderBackfill() {
    const button = $('#library-backfill');
    const data = state.backfill;
    const total = data?.total ?? 0;
    const targets = subtitleTargets();
    const named = targets.join(', ');
    const runnable = (data?.candidates ?? []).filter((candidate) => !candidate.note).length;
    button.disabled = total === 0;
    // The button names the languages rather than saying "targets": what one
    // press would attach is exactly what it should say.
    button.textContent = total ? `fill in ${named || 'the target languages'} (${total})` : 'nothing to fill in';
    button.title = total
      ? `Translate ${named} onto ${runnable} published title(s) that can be worked on, a batch of ${BACKFILL_BATCH} at a time. The videos are not re-downloaded or published again.`
      : 'every published title already has every target-language subtitle';
    $('#library-missing').textContent = total
      ? `${total} published title(s) are missing one of ${named}${runnable < total ? ` · ${total - runnable} cannot be tried` : ''}` +
        (state.settings?.subtitles?.autoFill === false ? '' : ' · a publish that comes up short is filled in automatically')
      : '';
    // The filter names the languages once they are known rather than saying "target".
    for (const [value, prefix] of [['missing', 'missing'], ['has', 'has']]) {
      const option = document.querySelector(`#library-subtitles option[value="${value}"]`);
      if (option && named) option.textContent = `${prefix} ${named} subtitles`;
    }
  }

  /** One click's worth of titles: each one costs a fetch, a translation and an upload. */
  const BACKFILL_BATCH = 10;

  /**
   * One click's worth of archives. Deliberately smaller than the backfill
   * batch: every title here is several gigabytes of download and upload, so the
   * button walks through them rather than opening a dozen at once.
   */
  const ARCHIVE_BATCH = 5;

  /**
   * One click's worth of checks. Bigger than the archive batch because a check
   * only reads: nothing is uploaded and nothing is deleted, so the whole bucket
   * can be walked in one pass.
   */
  const VERIFY_BATCH = 25;

  /** The languages being filled in — known from settings, or from the preview itself. */
  function subtitleTargets() {
    return state.backfill?.targets ?? state.settings?.subtitles?.targets ?? [];
  }

  /** The configured languages this record has no uploaded caption for, in order. */
  function entryMissing(entry) {
    return subtitleTargets().filter(
      (target) => !(entry.subtitles ?? []).some((track) => track.srclang === target && track.uploaded),
    );
  }

  /**
   * The per-record fill-in button, or nothing when the record already has every
   * language: it names exactly the languages that one press would attach.
   */
  function fillInButton(entry, label) {
    const missing = entryMissing(entry);
    if (!missing.length) return null;
    return h('button', {
      text: `fill in ${missing.join(', ')}`,
      title: backfillNoteFor(entry.key) ?? `Translate the missing ${missing.join(', ')} onto this title without re-downloading the video`,
      onclick: () => void backfillEntry(entry.key, label),
    });
  }

  /** Why the backfill cannot touch this title, when the preview said so. */
  function backfillNoteFor(key) {
    return (state.backfill?.candidates ?? []).find((candidate) => candidate.key === key)?.note;
  }

  /**
   * The batch's engine, aimed at one title: the same request with a single key.
   *
   * A title the preview already ruled out is refused with its reason rather than
   * being sent to the server to fail there.
   */
  async function backfillEntry(key, label) {
    const note = backfillNoteFor(key);
    if (note) {
      toast(`${label}: ${note}`, 'bad');
      return;
    }
    try {
      const report = await api('POST', '/api/subtitles/backfill', { keys: [key], limit: 1 });
      const outcome = (report.results ?? [])[0];
      if (outcome?.status !== 'translated') {
        toast(`${label}: ${outcome?.note ?? 'nothing was filled in'}`, 'bad');
        return;
      }
      const attached = (outcome.languages ?? []).join(', ') || (report.targets ?? []).join(', ');
      toast(
        `${label}: ${attached} attached (${outcome.cues ?? 0} cues)${outcome.note ? ` — ${outcome.note}` : ''}`,
        outcome.note ? 'bad' : 'ok',
      );
      await refreshLibrary();
      // The row may have just left a "missing" filter, so the record is reopened
      // by key: the new track is the thing the click was for.
      state.librarySelectedKey = key;
      await refreshLibraryDetail(key);
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  async function runBackfill() {
    const button = $('#library-backfill');
    const data = state.backfill;
    if (!data?.total) return;
    const runnable = (data.candidates ?? []).filter((candidate) => !candidate.note);
    if (!runnable.length) {
      toast(`nothing can be filled in — ${data.candidates?.[0]?.note ?? 'no usable source was recorded'}`, 'bad');
      return;
    }
    const batch = runnable.slice(0, BACKFILL_BATCH).map((candidate) => candidate.key);
    button.disabled = true;
    button.textContent = `translating ${batch.length}…`;
    try {
      const report = await api('POST', '/api/subtitles/backfill', { keys: batch, limit: batch.length });
      const parts = [`translated ${report.translated} of ${report.attempted}`];
      if (report.failed) parts.push(`${report.failed} failed`);
      if (report.skipped) parts.push(`${report.skipped} skipped`);
      toast(`${parts.join(' · ')}${report.remaining ? ` — ${report.remaining} still missing, press again` : ''}`, report.failed ? 'bad' : 'ok');
      await refreshLibrary();
      if (state.librarySelectedKey) await refreshLibraryDetail(state.librarySelectedKey);
    } catch (error) {
      toast(describeError(error), 'bad');
    } finally {
      button.disabled = false;
      renderBackfill();
    }
  }

  /** A signed playback URL's life, as a person reads it. */
  function archiveTtlLabel(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '5 min';
    if (value < 90) return `${Math.round(value)} s`;
    if (value < 5400) return `${Math.round(value / 60)} min`;
    return `${Math.round(value / 3600)} h`;
  }

  /* ------------------------------------------------ the R2 archive queue */

  /** The task the archive queue has for a title, while it is still worth showing. */
  function archiveTaskFor(entry) {
    const task = state.archiveTasks?.[entry.key];
    if (!task) return null;
    if (task.status === 'queued' || task.status === 'active') return task;
    // A finished task matters only until the catalogue catches up: once the
    // record itself carries the archive, the row shows that instead.
    return entry.archive ? null : task;
  }

  /** Replaces what is known about a set of titles (a fresh page, or a reconnect). */
  function seedArchiveTasks(tasks) {
    for (const task of tasks) if (task?.key) state.archiveTasks[task.key] = task;
  }

  /**
   * Applies the deltas the stream pushes.
   *
   * Archive tasks move by the byte, so the server coalesces them and sends each
   * task's *latest* state; this only has to store it and redraw.
   */
  function applyArchiveDelta(deltas) {
    let touched = false;
    for (const delta of deltas) {
      const task = delta?.task;
      if (!task?.key) continue;
      if (delta.kind === 'removed') delete state.archiveTasks[task.key];
      else state.archiveTasks[task.key] = task;
      touched = true;
    }
    if (touched && state.activeTab === 'library') renderLibrary();
  }

  /** One line describing what an archive task is doing right now. */
  function archiveStageLabel(task) {
    switch (task.stage) {
      case 'queued':
        return task.position ? `queued (#${task.position})` : 'queued';
      case 'checking':
        if (task.operation === 'verify') return 'reading the index out of R2';
        if (task.operation === 'restore') return 'reading the archive record';
        return 'reading the video back from Bunny';
      case 'scanning':
        return task.assets ? `measuring ${task.assets} file(s)` : 'measuring the folder';
      case 'verifying':
        return `re-hashing ${task.stored ?? 0}/${task.assets ?? 0} object(s) against the manifest`;
      case 'downloading':
        // A restore reads the bucket and hands the bytes on in the same pass, so
        // its first half is the whole trip rather than just the download.
        if (task.operation === 'restore') return `streaming ${task.asset ?? 'the rendition'} out of R2 into Bunny`;
        return `downloading ${task.asset ?? 'the rendition'} from R2`;
      case 'repairing':
        return task.assets ? `mending ${task.stored ?? 0}/${task.assets} flagged object(s)` : 'mending the flagged objects';
      case 'uploading':
        return task.operation === 'restore'
          ? `uploading ${task.asset ?? 'the rendition'} to Bunny`
          : `${task.asset ?? 'uploading'} · ${task.stored}/${task.assets} file(s)`;
      case 'manifest':
        return 'writing the index';
      case 'deleting':
        return 'removing it from Bunny';
      case 'done':
        if (task.operation === 'verify') return task.bad?.length ? 'checked · problems found' : 'checked · every object matches';
        if (task.operation === 'restore') return 'restored into Bunny';
        if (task.operation === 'repair') return `mended ${(task.repaired ?? []).length} object(s)${(task.dropped ?? []).length ? `, dropped ${(task.dropped ?? []).length}` : ''}`;
        return task.removedFromBunny ? 'done · removed from Bunny' : 'done · Bunny kept the video';
      case 'failed':
        if (task.operation === 'verify') return 'check failed';
        if (task.operation === 'restore') return 'restore failed';
        if (task.operation === 'repair') return 'repair could not mend it';
        return 'failed';
      default:
        return task.stage;
    }
  }

  /** The archive detail row: what the queue is doing now, or what it did. */
  function archiveDetailLine(entry) {
    const task = archiveTaskFor(entry);
    if (task) {
      const size = task.totalBytes ? ` (${bytes(task.bytes)} of ${bytes(task.totalBytes)})` : '';
      return `${archiveStageLabel(task)} · ${task.percent ?? 0}%${size}${task.note ? ` · ${task.note}` : ''}`;
    }
    if (!entry.archive) return 'not archived';
    const verify = entry.archive.verify;
    return (
      `${entry.archive.bucket}/${entry.archive.prefix} · ${(entry.archive.objects ?? []).length} object(s) · ${bytes(entry.archive.bytes)}` +
      `${entry.archive.videos !== undefined ? ` (${entry.archive.videos} rendition(s), ${bytes(entry.archive.videoBytes)})` : ''}` +
      `${entry.archive.complete ? '' : ' · INCOMPLETE'} · ${entry.archive.removedFromBunny ? 'removed from Bunny' : 'Bunny still holds it'}` +
      (entry.archive.mediaKey
        ? ` · plays ${entry.archive.base ? 'from the bucket directly' : `through the dashboard with a signed URL (${archiveTtlLabel(state.settings?.archive?.urlTtl)})`}`
        : '') +
      `${entry.archive.restoredAt ? ` · put back into Bunny ${whenLabel(entry.archive.restoredAt)}` : ''}` +
      `${
        entry.archive.verifiedAt || verify
          ? ` · checked ${whenLabel(entry.archive.verifiedAt ?? verify?.at)}${verify && !verify.ok ? ` (${(verify.missing ?? []).length} missing, ${(verify.mismatched ?? []).length} changed)` : ''}`
          : ''
      }` +
      `${
        entry.archive.repairedAt
          ? ` · mended ${whenLabel(entry.archive.repairedAt)} (${entry.archive.repair?.recopied?.length ?? 0} re-copied` +
            `${entry.archive.repair?.drifted?.length ? `, ${entry.archive.repair.drifted.length} changed` : ''}` +
            `${entry.archive.repair?.dropped?.length ? `, ${entry.archive.repair.dropped.length} dropped` : ''}` +
            `${entry.archive.repair?.switchedTo ? `, now playing ${entry.archive.repair.switchedTo}` : ''})`
          : ''
      }` +
      `${entry.archive.note ? ` · ${entry.archive.note}` : ''}`
    );
  }

  /**
   * The archive column of a Library row: a bar while a title is moving, and the
   * plain marker for one that is already in R2.
   */
  function archiveCell(entry) {
    const task = archiveTaskFor(entry);
    if (!task) {
      return h('span', {
        class: 'muted small',
        text: entry.archive ? (entry.archive.complete ? 'R2' : 'R2 partial') : '—',
        title: entry.archive
          ? `${entry.archive.bucket}/${entry.archive.prefix} · ${(entry.archive.objects ?? []).length} object(s)` +
            `${entry.archive.verify ? (entry.archive.verify.ok ? ' · verified' : ' · CHECK FAILED') : ''}` +
            `${entry.archive.restoredAt ? ' · also back in Bunny' : ''}`
          : 'still only on Bunny',
      });
    }
    const moving = task.status === 'active';
    const percent = Math.max(0, Math.min(100, task.percent ?? 0));
    return h(
      'span',
      {
        class: 'archive-progress',
        title: `${archiveStageLabel(task)}${task.totalBytes ? ` — ${bytes(task.bytes)} of ${bytes(task.totalBytes)}` : ''}${task.note ? ` — ${task.note}` : ''}`,
      },
      h('span', { class: `bar${task.status === 'failed' ? ' is-failed' : moving ? ' is-active' : ''}`, style: `width:${moving ? Math.max(3, percent) : 100}%` }),
      h('span', { class: 'label mono small', text: moving ? `${percent}%` : task.status === 'failed' ? 'failed' : 'queued' }),
    );
  }

  /**
   * Queues one title into R2 and lets Bunny forget it.
   *
   * The request only puts the title in line — the copying happens on the
   * server's archive queue and its progress arrives on the event stream — so
   * this returns as soon as the title is queued, however big it is.
   */
  async function archiveEntry(key, label) {
    try {
      const report = await api('POST', '/api/archive', { keys: [key], limit: 1 });
      seedArchiveTasks(report.queued ?? []);
      const skipped = (report.skipped ?? [])[0];
      if (skipped && !(report.queued ?? []).length) {
        toast(`${label}: ${skipped.reason}`, 'bad');
        return;
      }
      toast(`${label}: queued — the copy runs in the background, and its progress is in the row`, 'ok');
      renderLibrary();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  /**
   * The batch above: whatever the current filter lists, a few titles at a time.
   *
   * Since the work is queued rather than done here, the button is free again as
   * soon as the titles are in line.
   */
  async function runArchive() {
    const button = $('#library-archive');
    if (!state.settings?.archive?.configured) {
      toast('no R2 destination is configured', 'bad');
      return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'queueing…';
    try {
      const report = await api('POST', '/api/archive', { limit: ARCHIVE_BATCH });
      seedArchiveTasks(report.queued ?? []);
      const queuedCount = (report.queued ?? []).length;
      const skipped = report.skipped ?? [];
      if (!queuedCount) {
        toast(skipped.length ? `nothing queued — ${skipped[0]?.reason ?? 'nothing to do'}` : 'nothing is waiting to be archived', 'bad');
      } else {
        toast(`queued ${queuedCount} title(s) — they copy in the background${skipped.length ? `, ${skipped.length} skipped` : ''}`, 'ok');
      }
      renderLibrary();
    } catch (error) {
      toast(describeError(error), 'bad');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  /** What a targeted repair would do for this title, as a tooltip. */
  function repairHint(entry) {
    const verify = entry.archive?.verify ?? {};
    const flagged = (verify.missing ?? []).length + (verify.mismatched ?? []).length;
    const candidate = (state.archiveRepair ?? []).find((item) => item.key === entry.key);
    const route = candidate?.fromBunny
      ? 'each one is fetched again from Bunny and put back only if it still hashes to the manifest'
      : 'Bunny no longer holds the video, so playback moves onto the intact rendition and what nothing can supply is dropped';
    return `${flagged} object(s) failed the last check — ${route}. Nothing is re-archived.`;
  }

  /**
   * Mends just the objects the last check flagged.
   *
   * The alternative — archiving the title again — would re-download gigabytes to
   * fix one file, and would not be possible at all once Bunny has let the video
   * go. This touches only what is broken.
   */
  async function repairEntry(key, label) {
    try {
      const report = await api('POST', '/api/archive/repair', { keys: [key], limit: 1 });
      seedArchiveTasks(report.queued ?? []);
      const skipped = (report.skipped ?? [])[0];
      if (skipped && !(report.queued ?? []).length) {
        toast(`${label}: ${skipped.reason}`, 'bad');
        return;
      }
      toast(`${label}: mending the flagged objects — the result lands in the row`, 'ok');
      renderLibrary();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  /**
   * Queues one title for a re-check: the manifest is re-read from R2 and every
   * object it lists is re-hashed against the bucket.
   */
  async function verifyEntry(key, label) {
    try {
      const report = await api('POST', '/api/archive/verify', { keys: [key], limit: 1 });
      seedArchiveTasks(report.queued ?? []);
      const skipped = (report.skipped ?? [])[0];
      if (skipped && !(report.queued ?? []).length) {
        toast(`${label}: ${skipped.reason}`, 'bad');
        return;
      }
      toast(`${label}: checking R2 against its manifest — the result lands in the row`, 'ok');
      renderLibrary();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  /**
   * Puts one title back into Bunny from its R2 archive.
   *
   * The archive is left where it is — this is a copy, not a move — so the title
   * ends up in both places and can be archived again later.
   */
  async function restoreEntry(key, label) {
    if (!confirm(`Put “${label}” back into Bunny from R2? The archive copy stays where it is.`)) return;
    try {
      const report = await api('POST', '/api/archive/restore', { keys: [key], limit: 1 });
      seedArchiveTasks(report.queued ?? []);
      const skipped = (report.skipped ?? [])[0];
      if (skipped && !(report.queued ?? []).length) {
        toast(`${label}: ${skipped.reason}`, 'bad');
        return;
      }
      toast(`${label}: restoring into Bunny — the row shows how far it has got`, 'ok');
      renderLibrary();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  /**
   * The batch: re-check every archive the bucket holds.
   *
   * Reading is cheap next to copying, so this walks up to [VERIFY_BATCH] titles
   * per press; the queue does the work and the rows report what it found.
   */
  async function runVerify() {
    const button = $('#library-verify');
    if (!state.settings?.archive?.configured) {
      toast('no R2 destination is configured', 'bad');
      return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'queueing…';
    try {
      const report = await api('POST', '/api/archive/verify', { limit: VERIFY_BATCH });
      seedArchiveTasks(report.queued ?? []);
      const queuedCount = (report.queued ?? []).length;
      const skipped = report.skipped ?? [];
      if (!queuedCount) {
        toast(skipped.length ? `nothing queued — ${skipped[0]?.reason ?? 'nothing to do'}` : 'nothing in R2 to check', 'bad');
      } else {
        toast(`checking ${queuedCount} archive(s) — the rows report what the hashes say${skipped.length ? `, ${skipped.length} skipped` : ''}`, 'ok');
      }
      renderLibrary();
    } catch (error) {
      toast(describeError(error), 'bad');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  function titleCell(entry, index) {
    if (index === 0 && entry.kind === 'episode') {
      return `${entry.title} S${String(entry.season ?? 0).padStart(2, '0')}E${String(entry.episode ?? 0).padStart(2, '0')}`;
    }
    return `${entry.title}${entry.year ? ` (${entry.year})` : ''}`;
  }

  function renderLibrary() {
    const stats = state.libraryStats;
    const scoped = state.librarySubtitles;
    // The missing count is only worth showing once the list itself is narrowed:
    // unfiltered, the heading's own hint already says it.
    const narrowed = Boolean($('#library-search').value.trim() || $('#library-kind').value || $('#library-subtitles').value);
    const archiving = Object.values(state.archiveTasks ?? {}).filter((task) => task.status === 'queued' || task.status === 'active').length;
    $('#library-summary').textContent = stats
      ? `${stats.total} title(s) · ${stats.movies} movie(s) · ${stats.episodes} episode(s) · ${bytes(stats.bytes)} published` +
        (stats.archived ? ` · ${stats.archived} in R2 (${bytes(stats.archivedBytes)})` : '') +
        (archiving ? ` · ${archiving} copying to R2` : '') +
        (state.libraryMatched !== null && state.libraryMatched !== stats.total ? ` · ${state.libraryMatched} match the filter` : '') +
        (narrowed && scoped ? ` · ${scoped.missing} of them have no ${(scoped.targets ?? []).join(', ')}` : '')
      : '';
    const body = clear($('#library-table tbody'));
    if (!state.library.length) {
      // An empty list means two different things: nothing published, or nothing
      // matching the search and the subtitle filter.
      const narrowed = Boolean($('#library-search').value.trim() || $('#library-kind').value || $('#library-subtitles').value);
      body.append(h('tr', {}, h('td', { colspan: '10', class: 'muted', text: narrowed ? 'nothing matches the filter' : 'nothing published yet' })));
      return;
    }
    for (const entry of state.library) {
      const row = h(
        'tr',
        { onclick: (event) => (event.target.closest('a,button') ? undefined : selectLibraryEntry(entry.key)) },
        h(
          'td',
          {},
          h('span', { text: titleCell(entry, 0) }),
          entry.episodeTitle ? h('div', { class: 'muted small', text: entry.episodeTitle }) : null,
        ),
        h('td', { class: 'mono small', text: entry.kind }),
        h('td', { class: 'mono', text: entry.quality ?? '—' }),
        h('td', { class: 'mono small', text: entry.tiers?.length ? entry.tiers.map((tier) => tier.label).join(', ') : '—' }),
        h('td', { class: 'mono small', text: String(entry.sourceCount ?? 0) }),
        h('td', { class: 'mono small', text: bytes(librarySize(entry)) }),
        h('td', { class: 'mono small', text: entry.accountName ?? '—' }),
        h(
          'td',
          {},
          entry.playbackUrl
            ? h('a', { href: entry.playbackUrl, target: '_blank', rel: 'noreferrer', text: 'play' })
            : h('span', { class: 'muted small', text: '—' }),
          // Where the bytes are now, and how far the copy has got: a bar while
          // the archive is moving this title, then the plain R2 marker.
          archiveCell(entry),
        ),
        h('td', { class: 'mono small', text: shortTime(entry.updatedAt) }),
        h(
          'td',
          { class: 'actions' },
          // A per-title version of the batch above, so one title can be picked out
          // of a filtered list instead of running the whole lot.
          fillInButton(entry, titleCell(entry, 0)),
          state.settings?.archive?.configured
            ? h('button', {
                text: 'to R2',
                title: 'Queue every rendition, still and caption for Cloudflare R2, verify it, then remove the video from Bunny. It runs in the background.',
                ...(archiveTaskFor(entry) ? { disabled: true } : {}),
                onclick: () => void archiveEntry(entry.key, titleCell(entry, 0)),
              })
            : null,
          // A title already in R2 can be re-checked (its manifest re-read and
          // every object re-hashed) and, once whole, put back into Bunny.
          state.settings?.archive?.configured && entry.archive
            ? h('button', {
                text: entry.archive.verify && !entry.archive.verify.ok ? 're-check' : 'check',
                title: 'Re-read this title’s manifest from R2 and re-hash every object it lists against the bucket. It runs in the background.',
                ...(archiveTaskFor(entry) ? { disabled: true } : {}),
                onclick: () => void verifyEntry(entry.key, titleCell(entry, 0)),
              })
            : null,
          // A check that failed is the one signal a repair needs: the flagged
          // objects are the work list, so the button only appears after one.
          state.settings?.archive?.configured && entry.archive?.verify && !entry.archive.verify.ok
            ? h('button', {
                text: 'repair',
                title: repairHint(entry),
                ...(archiveTaskFor(entry) ? { disabled: true } : {}),
                onclick: () => void repairEntry(entry.key, titleCell(entry, 0)),
              })
            : null,
          state.settings?.archive?.configured && entry.archive?.complete
            ? h('button', {
                text: 'restore',
                title: 'Stream the best archived rendition back out of R2 into a fresh Bunny video, captions included. The archive stays where it is.',
                ...(archiveTaskFor(entry) ? { disabled: true } : {}),
                onclick: () => void restoreEntry(entry.key, titleCell(entry, 0)),
              })
            : null,
          h('button', { text: 'forget', onclick: () => void forgetLibraryEntry(entry.key, titleCell(entry, 0)) }),
        ),
      );
      if (entry.key === state.librarySelectedKey) row.classList.add('is-selected');
      body.append(row);
    }
  }

  function selectLibraryEntry(key) {
    if (state.librarySelectedKey === key) {
      state.librarySelectedKey = null;
      state.libraryEntry = null;
      renderLibrary();
      renderLibraryDetail();
      return;
    }
    state.librarySelectedKey = key;
    state.libraryEntry = null;
    renderLibrary();
    renderLibraryDetail();
    void refreshLibraryDetail(key);
  }

  async function refreshLibraryDetail(key) {
    try {
      const data = await api('GET', `/api/catalog/${encodeURIComponent(key)}`);
      if (state.librarySelectedKey !== key) return;
      state.libraryEntry = data.entry ?? null;
      renderLibraryDetail();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  async function forgetLibraryEntry(key, label) {
    if (!confirm(`Forget “${label}” in the library? Bunny keeps the video; only this record is removed.`)) return;
    try {
      await api('DELETE', `/api/catalog/${encodeURIComponent(key)}`);
      if (state.librarySelectedKey === key) {
        state.librarySelectedKey = null;
        state.libraryEntry = null;
      }
      toast('record removed', 'ok');
      await refreshLibrary();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  function renderLibraryDetail() {
    const box = clear($('#library-detail'));
    const entry = state.libraryEntry && state.libraryEntry.key === state.librarySelectedKey ? state.libraryEntry : null;
    if (!state.librarySelectedKey) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    if (!entry) {
      box.append(h('div', { class: 'muted small', text: 'loading the full record…' }));
      return;
    }
    box.append(
      h(
        'div',
        { class: 'box-head' },
        h('strong', { text: `${titleCell(entry, 0)}${entry.episodeTitle ? ` · ${entry.episodeTitle}` : ''}` }),
        fillInButton(entry, titleCell(entry, 0)),
        h('button', { class: 'link', text: 'close', onclick: () => selectLibraryEntry(entry.key) }),
      ),
      h('div', {
        class: 'muted small',
        text:
          `key ${entry.key} · first published ${shortTime(entry.firstPublishedAt)}` +
          ` · published ${entry.publishes} time(s) · updated ${shortTime(entry.updatedAt)}`,
      }),
    );

    const rows = [
      ['playback', entry.playbackUrl ?? '—'],
      ['video id', entry.videoId ?? '—'],
      ['account', entry.accountName ? `${entry.accountName} (library ${entry.libraryId ?? '—'})` : '—'],
      ['pull zone', entry.pullZoneHost ?? '—'],
      ['transport', entry.transport ?? '—'],
      ['bunny status', entry.bunnyStatus !== undefined ? String(entry.bunnyStatus) : '—'],
      ['quality', entry.quality ?? '—'],
      ['provider', entry.provider ?? '—'],
      ['source url', entry.sourceUrl ?? '—'],
      ['source headers', formatHeaders(entry.sourceHeaders)],
      ['sizes', `declared ${bytes(entry.bytes?.declared)} · downloaded ${bytes(entry.bytes?.downloaded)} · handed over ${bytes(entry.bytes?.handedOver)}${entry.bytes?.file ? ` · file ${bytes(entry.bytes.file)}` : ''}`],
      ['origin', `${entry.origin?.kind ?? '—'}${entry.origin?.mode ? ` (${entry.origin.mode})` : ''} · ${entry.origin?.name ?? '—'}${entry.origin?.input ? ` · input ${entry.origin.input}` : ''}`],
      ['scrape options', `min tier ${entry.origin?.minHeight !== undefined ? `${entry.origin.minHeight || 'any'}p` : 'default'}${entry.origin?.only?.length ? ` · hosts ${entry.origin.only.join(', ')}` : ' · every host'}`],
      ['subtitles', entry.subtitles?.length ? entry.subtitles.map((track) => `${track.srclang}${track.translated ? ' (translated)' : ''}${track.uploaded ? '' : ' (not attached)'}`).join(', ') : 'none carried'],
      ['R2 archive', archiveDetailLine(entry)],
      ['job', entry.jobId],
    ];
    box.append(
      h(
        'table',
        { class: 'table' },
        h('tbody', {}, ...rows.map(([label, value]) => h('tr', {}, h('th', { text: label }), h('td', { class: 'mono small', text: String(value) })))),
      ),
    );

    box.append(h('h2', { text: `Qualities the source offered${entry.tiers?.length ? ` (${entry.tiers.length})` : ''}` }));
    if (entry.tiers?.length) {
      box.append(
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Tier' }), h('th', { text: 'Height' }), h('th', { text: 'Bandwidth' }), h('th', { text: 'URL' }))),
          h(
            'tbody',
            {},
            ...entry.tiers.map((tier) =>
              h(
                'tr',
                {},
                h('td', { text: tier.label === entry.quality ? 'published' : '' }),
                h('td', { class: 'mono', text: tier.label }),
                h('td', { class: 'mono small', text: tier.height ? `${tier.height}p` : '—' }),
                h('td', { class: 'mono small', text: tier.bandwidth ? `${Math.round(tier.bandwidth / 1000)} kbps` : '—' }),
                h('td', { class: 'mono small', text: tier.url }),
              ),
            ),
          ),
        ),
      );
    } else {
      box.append(h('div', { class: 'muted small', text: 'this job was not a scrape, so no ladder was recorded' }));
    }

    box.append(h('h2', { text: `Sources found${entry.sources?.length ? ` (${entry.sources.length})` : ''}` }));
    if (entry.sources?.length) {
      box.append(
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Host' }), h('th', { text: 'Quality' }), h('th', { text: 'Type' }), h('th', { text: 'URL' }), h('th', { text: 'Headers' }), h('th', { text: 'Note' }))),
          h(
            'tbody',
            {},
            ...entry.sources.map((source) =>
              h(
                'tr',
                {},
                h('td', { text: source.chosen ? 'chosen' : '' }),
                h('td', { text: source.provider }),
                h('td', { class: 'mono small', text: `${source.quality}${source.height ? ` (${source.height}p)` : ''}` }),
                h('td', { class: 'mono small', text: source.directFile ? 'file' : (source.type ?? '—') }),
                h('td', { class: 'mono small', text: source.url }),
                h('td', { class: 'mono small', text: formatHeaders(source.headers) }),
                h('td', { class: 'muted small', text: source.note ?? '' }),
              ),
            ),
          ),
        ),
      );
    } else {
      box.append(h('div', { class: 'muted small', text: 'no candidate ladder was recorded for this job' }));
    }

    box.append(h('h2', { text: `Subtitles carried${entry.subtitles?.length ? ` (${entry.subtitles.length})` : ''}` }));
    if (entry.subtitles?.length) box.append(subtitlesTable(entry.subtitles));
    else box.append(h('div', { class: 'muted small', text: 'none — this title was published without subtitle tracks' }));
  }

  $('#library-refresh').addEventListener('click', () => void refreshLibrary());
  $('#library-backfill').addEventListener('click', () => void runBackfill());
  $('#library-archive').addEventListener('click', () => void runArchive());
  $('#library-verify').addEventListener('click', () => void runVerify());
  $('#library-kind').addEventListener('change', () => {
    closeLibraryDetail();
    void refreshLibrary();
  });
  $('#library-subtitles').addEventListener('change', () => {
    closeLibraryDetail();
    void refreshLibrary();
  });
  let librarySearchTimer;
  $('#library-search').addEventListener('input', () => {
    closeLibraryDetail();
    clearTimeout(librarySearchTimer);
    librarySearchTimer = setTimeout(() => void refreshLibrary({ quiet: true }), 250);
  });

  /* ------------------------------------------------------------ accounts */

  async function refreshAccounts() {
    try {
      const data = await api('GET', '/api/accounts');
      state.accounts = data.accounts ?? [];
      const usage = new Map((data.usage ?? []).map((entry) => [entry.id, entry]));
      const body = clear($('#accounts-table tbody'));
      for (const account of state.accounts) {
        const use = usage.get(account.id) ?? { active: 0, capacity: data.perAccountConcurrency };
        body.append(
          h(
            'tr',
            {},
            h('td', { text: account.name }),
            h('td', { class: 'mono', text: account.libraryId }),
            h('td', { class: 'mono', text: account.pullZoneHost ?? '—' }),
            h('td', { class: 'mono', text: account.apiKeyMasked ?? '—' }),
            // The account key is what lets the watermark be re-applied without
            // pasting it again; an account without one says so here.
            h('td', {
              class: 'mono',
              text: account.accountApiKeyMasked ?? '—',
              title: account.hasAccountKey ? 'stored — the watermark can be re-applied' : 'not stored: the watermark cannot be applied to this library',
            }),
            h('td', { class: 'mono', text: `${use.active}/${use.capacity}` }),
            h(
              'td',
              { class: 'actions' },
              h('button', { text: 'test', onclick: () => void testAccount(account.id) }),
              h('button', { text: 'watermark', onclick: () => void watermarkAccount(account) }),
              h('button', { text: account.enabled ? 'disable' : 'enable', onclick: () => void toggleAccount(account) }),
              h('button', { text: 'delete', onclick: () => void removeAccount(account) }),
            ),
          ),
        );
      }
      if (!state.accounts.length) body.append(h('tr', {}, h('td', { colspan: '7', class: 'muted', text: 'no accounts yet' })));
      $('#account-limit').textContent = `${state.accounts.length} of ${data.maxAccounts} accounts · ${data.perAccountConcurrency} uploads each`;
      // The read-back report is a snapshot of the accounts as they were when it
      // ran; adding, removing or changing one makes it stale, so it goes with
      // them rather than lingering over a list it no longer describes.
      clear($('#accounts-verify-report')).classList.add('hidden');
      $('#accounts-verify-state').textContent = '';
      state.libraryCheck = null;
    } catch (error) {
      toast(describeError(error), 'bad');
    }
    void refreshWatermark();
  }

  /**
   * The shared watermark, as the Accounts tab shows it.
   *
   * Read through /api/watermark rather than out of the settings payload, so the
   * panel the upload happens in is also the panel that reflects it.
   */
  async function refreshWatermark() {
    try {
      const data = await api('GET', '/api/watermark');
      state.watermark = data;
      const settings = data.settings ?? {};
      $('#watermark-corner').value = settings.corner ?? 'bottom-right';
      $('#watermark-width').value = String(settings.width ?? 12);
      $('#watermark-height').value = String(settings.height ?? 8);
      $('#watermark-margin').value = String(settings.margin ?? 2);
      const placement = data.placement ?? {};
      $('#watermark-state').textContent = data.hasImage
        ? `${bytes(data.bytes)} ${data.contentType ?? 'image'} · ${fmtPercent(placement.left)} from the left, ${fmtPercent(placement.top)} from the top`
        : 'no image yet — the position and size are saved, but nothing shows until one is uploaded';
      $('#watermark-remove').disabled = !data.hasImage;
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  function fmtPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number * 100) / 100}%` : '—';
  }

  /**
   * Read every configured library back from bunny.net and show the differences.
   *
   * Read-only on both sides: nothing is written to Bunny and nothing is stored
   * here, because the point is to see the libraries as they actually are. A
   * library that has drifted looks exactly like one that has not until this
   * runs, so the report is the only place it can turn up.
   */
  async function verifyLibraries() {
    const button = $('#accounts-verify');
    button.disabled = true;
    $('#accounts-verify-state').textContent = 'reading every library from bunny.net…';
    try {
      const report = await api('POST', '/api/accounts/verify');
      state.libraryCheck = report;
      renderLibraryCheck(report);
    } catch (error) {
      toast(describeError(error), 'bad');
      $('#accounts-verify-state').textContent = '';
    } finally {
      button.disabled = false;
    }
  }

  function renderLibraryCheck(report) {
    const box = clear($('#accounts-verify-report'));
    box.classList.remove('hidden');
    const results = report.results ?? [];
    const placement = report.expected?.placement;
    $('#accounts-verify-state').textContent =
      `${report.total} account(s) · ${report.inSync} in sync · ${report.drifted} drifted · ${report.skipped} without an account key` +
      (report.unreachable ? ` · ${report.unreachable} could not be read` : '') +
      (placement
        ? ` · checked against a watermark at ${placement.left}% / ${placement.top}%, ${placement.width}% × ${placement.height}%`
        : '');

    const body = h('tbody');
    if (!results.length) body.append(h('tr', {}, h('td', { colspan: '3', class: 'muted', text: 'no accounts to check' })));
    for (const result of results) {
      const verdict = result.ok ? 'in sync' : result.checked ? 'drifted' : 'not checked';
      const cls = result.ok ? 'in-sync' : result.checked ? 'drifted' : 'skipped';
      const detail = result.checked
        ? (result.findings ?? []).map((finding) => finding.message).join(' · ') || 'everything matches the settings'
        : result.error ?? '—';
      // Only a library that was read can be written back to, and only one that
      // differs is worth a fix button — kept beside the verdict rather than in
      // a column of its own, so a narrow window never hides the action.
      const fix = result.checked && !result.ok ? h('button', { text: 'fix', onclick: () => void fixLibrary(result) }) : undefined;
      body.append(
        h(
          'tr',
          {},
          h('td', { text: result.name }),
          h('td', { class: 'actions' }, h('span', { class: `status ${cls}`, text: verdict }), fix),
          h('td', { class: 'small', text: detail }),
        ),
      );
    }
    box.append(
      h(
        'table',
        { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Account' }), h('th', { text: 'Verdict' }), h('th', { text: 'What Bunny holds' }))),
        body,
      ),
    );
  }

  /** Put every setting this dashboard owns back onto one library, then re-check. */
  async function fixLibrary(result) {
    try {
      const fixed = await api('POST', `/api/accounts/${result.id}/settings`);
      if (fixed.ok) {
        toast(`“${result.name}” now matches the settings`, 'ok');
      } else {
        toast(`“${result.name}” still differs: ${(fixed.findings ?? []).map((finding) => finding.message).join(' · ') || fixed.error}`, 'bad');
      }
      await verifyLibraries();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  $('#accounts-verify').addEventListener('click', () => void verifyLibraries());

  /** Put the saved watermark onto one library straight away. */
  async function watermarkAccount(account) {
    try {
      const result = await api('POST', `/api/accounts/${account.id}/watermark`);
      toast(`watermark applied to “${account.name}”${result.imageUploaded ? '' : ' (no image uploaded yet)'}`, 'ok');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  async function testAccount(id) {
    try {
      const data = await api('POST', `/api/accounts/${id}/test`);
      toast(data.ok ? `library reachable · ${data.totalItems} videos` : `failed: ${data.error}`, data.ok ? 'ok' : 'bad');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  async function toggleAccount(account) {
    try {
      await api('PATCH', `/api/accounts/${account.id}`, { enabled: !account.enabled });
      await refreshAccounts();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  async function removeAccount(account) {
    if (!confirm(`Delete the account “${account.name}”?`)) return;
    try {
      await api('DELETE', `/api/accounts/${account.id}`);
      await refreshAccounts();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  /**
   * One account API key in, a configured library out.
   *
   * The server does the four Bunny calls; the browser only has to say what the
   * library should be called. The response names what was made so the toast is
   * worth reading.
   */
  $('#account-provision').addEventListener('click', async () => {
    const name = $('#account-name').value.trim();
    const accountApiKey = $('#account-apikey').value.trim();
    if (!name) return void toast('give the account a name', 'bad');
    if (!accountApiKey) return void toast('the account API key is required', 'bad');
    const button = $('#account-provision');
    button.disabled = true;
    try {
      const data = await api('POST', '/api/accounts/provision', { name, accountApiKey });
      $('#account-name').value = '';
      $('#account-apikey').value = '';
      const library = data.library ?? {};
      const mark = data.watermark?.applied ? 'watermark applied' : 'watermark placement saved (no image yet)';
      toast(
        `library ${library.id} created for “${name}” · ${(library.resolutions ?? []).length} resolutions · ${mark}`,
        'ok',
      );
      await refreshAccounts();
    } catch (error) {
      toast(describeError(error), 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('#account-toggle-manual').addEventListener('click', () => {
    $('#account-manual').classList.toggle('hidden');
  });

  $('#account-add').addEventListener('click', async () => {
    const body = {
      name: $('#account-name').value.trim(),
      libraryId: $('#account-library').value.trim(),
      apiKey: $('#account-key').value.trim(),
      accountApiKey: $('#account-manual-apikey').value.trim(),
      pullZoneHost: $('#account-pullzone').value.trim(),
    };
    try {
      await api('POST', '/api/accounts', body);
      $('#account-name').value = '';
      $('#account-library').value = '';
      $('#account-key').value = '';
      $('#account-manual-apikey').value = '';
      $('#account-pullzone').value = '';
      toast('account added', 'ok');
      await refreshAccounts();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  /* ------------------------------------------------------------ watermark */

  $('#watermark-save').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/watermark', {
        corner: $('#watermark-corner').value,
        width: Number($('#watermark-width').value),
        height: Number($('#watermark-height').value),
        margin: Number($('#watermark-margin').value),
      });
      toast('watermark saved — apply it to put it on your libraries', 'ok');
      await refreshWatermark();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  // The image goes up as raw bytes with its own content type: a watermark is a
  // file, and base64 inside JSON would just be a third more bytes to move.
  $('#watermark-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await api('PUT', '/api/watermark/image', file, file.type || 'image/png');
      toast(`watermark image saved (${bytes(file.size)})`, 'ok');
      await refreshWatermark();
    } catch (error) {
      toast(describeError(error), 'bad');
    } finally {
      event.target.value = '';
    }
  });

  $('#watermark-remove').addEventListener('click', async () => {
    if (!confirm('Remove the watermark image? Libraries keep the placement, but the mark stops showing.')) return;
    try {
      await api('DELETE', '/api/watermark/image');
      toast('watermark image removed', 'ok');
      await refreshWatermark();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#watermark-apply').addEventListener('click', async () => {
    const button = $('#watermark-apply');
    button.disabled = true;
    try {
      const report = await api('POST', '/api/watermark/apply', {});
      const failed = (report.results ?? []).filter((result) => !result.ok);
      const many = (count) => `${count} librar${count === 1 ? 'y' : 'ies'}`;
      if (report.failed) {
        // A partial result is a failure worth the long-lived toast: the names
        // are what the operator has to act on.
        toast(`${report.applied} of ${many(report.total)} took the watermark — ${failed.map((result) => result.name).join(', ')} did not`, 'bad');
      } else {
        toast(`watermark applied to ${many(report.total)}`, 'ok');
      }
      await refreshAccounts();
    } catch (error) {
      toast(describeError(error), 'bad');
    } finally {
      button.disabled = false;
    }
  });

  /* --------------------------------------------------------------- watch */

  async function refreshWatch() {
    try {
      const data = await api('GET', '/api/watch');
      $('#watch-dir').value = data.dir ?? state.settings?.watchDir ?? '';
      $('#watch-enabled').checked = data.enabled !== false;
      const counts = data.counts ?? {};
      $('#watch-state').textContent =
        `last scan ${data.lastScanAt ? shortTime(data.lastScanAt) : 'never'}` +
        ` · ${data.files?.length ?? 0} file(s) tracked (waiting ${counts.waiting ?? 0} · queued ${counts.queued ?? 0} · unmatched ${counts.unmatched ?? 0} · error ${counts.error ?? 0})` +
        (data.folderError ? ` · folder: ${data.folderError}` : '');
      const body = clear($('#watch-table tbody'));
      for (const file of data.files ?? []) {
        body.append(
          h(
            'tr',
            {},
            h('td', { class: 'mono small', text: file.name }),
            h('td', {}, statusBadge(file.status ?? 'seen')),
            h('td', { class: 'small', text: file.target ? `${file.target.title}${file.target.year ? ` (${file.target.year})` : ''}` : file.error ?? '—' }),
            h('td', { class: 'mono small', text: file.jobId ? file.jobId.slice(0, 8) : '—' }),
          ),
        );
      }
      if (!(data.files ?? []).length) body.append(h('tr', {}, h('td', { colspan: '4', class: 'muted', text: 'nothing scanned yet' })));
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  $('#watch-save').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/settings', { watchDir: $('#watch-dir').value.trim(), watchEnabled: $('#watch-enabled').checked });
      toast('watched folder saved', 'ok');
      await refreshWatch();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#watch-scan').addEventListener('click', async () => {
    try {
      await api('POST', '/api/watch/scan', {});
      await refreshWatch();
      await refreshJobs();
      toast('scan finished', 'ok');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  /* ---------------------------------------------------------- diagnostics */

  async function runNetworkCheck() {
    const body = clear($('#diagnostics-table tbody'));
    $('#diagnostics-summary').textContent = 'probing hosts…';
    body.append(h('tr', {}, h('td', { colspan: '5', class: 'muted small', text: 'probing hosts…' })));
    try {
      const report = await api('GET', '/api/diagnostics');
      clear(body);
      $('#diagnostics-summary').textContent = report.summary ?? '';
      if (report.skipped) {
        body.append(h('tr', {}, h('td', { colspan: '5', class: 'muted small', text: report.summary })));
        return;
      }
      for (const check of report.checks ?? []) {
        body.append(
          h(
            'tr',
            {},
            h('td', {}, h('span', { class: `status ${check.ok ? 'ready' : 'failed'}`, text: check.ok ? 'ok' : 'down' }), ' ', check.label),
            h('td', { class: 'mono small', text: check.ok ? (check.status !== undefined ? `HTTP ${check.status}` : 'reachable') : check.error ?? 'no answer' }),
            h('td', { class: 'mono small', text: `${check.ms} ms` }),
            h('td', { class: 'mono small', text: check.address ?? '—' }),
            h('td', { class: 'small muted', text: `${check.role}${check.detail ? ` · ${check.detail}` : ''}` }),
          ),
        );
      }
    } catch (error) {
      clear(body);
      $('#diagnostics-summary').textContent = describeError(error);
    }
  }

  $('#diagnostics-run').addEventListener('click', () => void runNetworkCheck());

  /* ------------------------------------------------------------ settings */

  const HOW = {
    movy: 'one-hop JSON catalogue (vidrack)',
    aurora: 'one-hop JSON catalogue (vidrack)',
    rigel: 'movish.to player sources, with the vidrack mirror',
    vidlink: 'JSON API behind an enc-dec.id encoder',
    vidfast: 'enc-dec route check, then a page scan',
    cinesrc: 'page scan (DDoS-Guard may refuse)',
  };

  async function refreshSettings() {
    try {
      state.settings = await api('GET', '/api/settings');
      state.health = await api('GET', '/api/health');
    } catch (error) {
      toast(describeError(error), 'bad');
      return;
    }
    const settings = state.settings;
    $('#settings-concurrency').value = String(settings.perAccountConcurrency);
    $('#settings-maxaccounts').value = String(settings.maxAccounts);
    $('#settings-autofill').checked = settings.subtitles?.autoFill !== false;
    // The R2 archive can only be switched on when there is somewhere to put it;
    // a checkbox that cannot work is worse than one that explains why.
    const archive = settings.archive ?? {};
    $('#settings-archive').checked = Boolean(archive.configured) && archive.auto !== false;
    $('#settings-archive').disabled = !archive.configured;
    $('#settings-archive-note').textContent = archive.configured
      ? `${archive.bucket} · ${archive.prefix}${archive.keepBunny ? ' · keeps the Bunny copy' : ' · removes the Bunny copy'}` +
        ` · plays with signed URLs (${archiveTtlLabel(archive.urlTtl)})`
      : 'not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET';
    $('#library-archive').disabled = !archive.configured;
    $('#library-archive').title = archive.configured
      ? `Copy the titles below into ${archive.bucket} and remove them from Bunny`
      : 'no R2 destination is configured';
    $('#library-verify').disabled = !archive.configured;
    $('#library-verify').title = archive.configured
      ? `Re-read every manifest in ${archive.bucket} and re-hash the objects it lists`
      : 'no R2 destination is configured';
    // The scheduled pass is its own little form, below the settings it belongs
    // to; it is read and written through /api/archive/check.
    void refreshCheck();
    $('#mode-badge').textContent = settings.mock ? 'MOCK providers' : 'live providers';

    const runtime = clear($('#runtime-table tbody'));
    const rows = [
      ['TMDB credential', settings.tmdbConfigured ? settings.tmdbCredentialSource : 'not configured'],
      ['upload transport', `${settings.uploadMode}${settings.tusChunkBytes ? ` · ${bytes(settings.tusChunkBytes)} chunks` : ''}`],
      ['segment downloads', `${settings.streamConcurrency} at a time`],
      ['tunnel', settings.source?.tunnelEnabled ? settings.source.tunnelPublicUrl ?? 'quick tunnel (cloudflared)' : 'disabled'],
      ['scrape floor', `${settings.source?.minHeight ?? 1080}p`],
      [
        'subtitles',
        settings.subtitles?.enabled
          ? `carried to Bunny` +
            (settings.subtitles.translate
              ? ` · DeepL fills in ${(settings.subtitles.targets ?? []).join(', ')} (${settings.subtitles.endpoint ?? 'deepl.com'})`
              : ` · translation off, so ${(settings.subtitles.targets ?? []).join(', ')} is never invented`)
          : 'off',
      ],
      [
        'subtitle repair',
        settings.subtitles?.translate === false
          ? 'off — translation is off, so nothing can be filled in'
          : settings.subtitles?.autoFill === false
            ? 'off — fill in a language by hand from the Library'
            : `on — a publish that left ${(settings.subtitles?.targets ?? []).join(', ')} missing is filled in automatically`,
      ],
      [
        'R2 archive',
        settings.archive?.configured
          ? `${settings.archive.bucket}/${settings.archive.prefix}${settings.archive.keepBunny ? ' · keeps the Bunny copy' : ' · removes the Bunny copy'}` +
            ` · plays through the dashboard with signed URLs (${archiveTtlLabel(settings.archive.urlTtl)}, R2_URL_TTL)` +
            `${settings.archive.publicBase ? ` · also served at ${settings.archive.publicBase}` : ' · no public base needed'}`
          : 'not configured',
      ],
      [
        'archive check',
        settings.archive?.configured
          ? (settings.archive.check?.enabled === false ? 'off' : checkIntervalLabel(settings.archive.check?.intervalMs)) +
            ` · ${settings.archive.check?.totals?.checked ?? 0} of ${settings.archive.check?.totals?.archived ?? 0} title(s) checked` +
            `${settings.archive.check?.totals?.failing ? ` · ${settings.archive.check.totals.failing} stopped matching` : ' · nothing has stopped matching'}`
          : 'not configured',
      ],
      ['scrape pace', `${settings.source?.minIntervalMs ?? 350} ms between hits to one host · first cooldown ${fmtDuration(settings.source?.cooldownMs ?? 60_000)}`],
      [
        'scrape egress',
        Object.keys(settings.source?.egress ?? {}).length
          ? Object.entries(settings.source.egress).map(([host, base]) => `${host} → ${base}`).join(', ')
          : 'direct (no proxy)',
      ],
      ['watched folder', settings.watchEnabled ? settings.watchDir || '(not set)' : 'off'],
      ['limits', `≤${settings.limits.maxAccounts} accounts · ≤${settings.limits.perAccountConcurrency} uploads each · ${bytes(settings.limits.maxUploadBytes)} per file`],
      ['network calls', `${settings.network?.timeoutMs ?? 30000} ms per attempt · ${settings.network?.retries ?? 3} retries`],
      ['library', `${settings.catalogEntries ?? 0} published title(s) · ${settings.catalogPath ?? '—'}`],
    ];
    for (const [label, value] of rows) {
      runtime.append(h('tr', {}, h('th', { text: label }), h('td', { class: 'mono', text: String(value) })));
    }

    const providers = clear($('#providers-table tbody'));
    for (const provider of state.providers) {
      providers.append(
        h('tr', {}, h('td', { text: provider.name }), h('td', { class: 'mono small', text: provider.kind }), h('td', { class: 'small', text: HOW[provider.id] ?? '—' })),
      );
    }

    const cooling = clear($('#cooling-table tbody'));
    const coolingList = settings.source?.cooling ?? [];
    if (!coolingList.length) {
      cooling.append(h('tr', {}, h('td', { colspan: '3', class: 'muted small', text: 'every host is answering' })));
    } else {
      for (const entry of coolingList) {
        cooling.append(
          h(
            'tr',
            {},
            h('td', { class: 'mono small', text: entry.host }),
            h('td', { class: 'small', text: entry.reason }),
            h('td', { class: 'mono small', text: `in ${fmtDuration(entry.until - Date.now())} · ${entry.failures} refusal(s)` }),
          ),
        );
      }
    }
  }

  $('#settings-save').addEventListener('click', async () => {
    const body = {
      perAccountConcurrency: Number($('#settings-concurrency').value),
      maxAccounts: Number($('#settings-maxaccounts').value),
      subtitleAutoFill: $('#settings-autofill').checked,
      // Only sent when there is a destination: the server rejects switching an
      // archive on with nowhere to write it.
      ...(state.settings?.archive?.configured ? { archiveToR2: $('#settings-archive').checked } : {}),
    };
    const key = $('#settings-key').value.trim();
    const token = $('#settings-token').value.trim();
    if (key) body.tmdbApiKey = key;
    if (token) body.tmdbAccessToken = token;
    try {
      await api('PUT', '/api/settings', body);
      $('#settings-key').value = '';
      $('#settings-token').value = '';
      toast('settings saved', 'ok');
      await refreshSettings();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#settings-clear').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/settings', { clearTmdb: true });
      toast('TMDB credential forgotten', 'ok');
      await refreshSettings();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  /* ----------------------------------------------------------- autopilot */

  function autopilotPatch() {
    const kinds = [];
    if ($('#autopilot-movies').checked) kinds.push('movie');
    if ($('#autopilot-tv').checked) kinds.push('tv');
    return {
      enabled: $('#autopilot-enabled').checked,
      minRating: Number($('#autopilot-minrating').value),
      minHeight: Number($('#autopilot-minheight').value),
      maxJobsPerCycle: Number($('#autopilot-maxjobs').value),
      maxAttempts: Number($('#autopilot-maxattempts').value),
      maxQueueDepth: Number($('#autopilot-maxdepth').value),
      intervalMs: Math.round(Number($('#autopilot-interval').value) * 60_000),
      expandSeries: $('#autopilot-expand').checked,
      kinds,
    };
  }

  function renderAutopilot(ap, options = {}) {
    const badge = $('#autopilot-state');
    badge.textContent = ap.running ? 'running a cycle…' : ap.config.enabled ? 'on' : 'off';

    const status = clear($('#autopilot-status-table tbody'));
    const statusRows = [
      ['state', ap.config.enabled ? (ap.running ? 'a cycle is running' : 'on') : 'off'],
      ['cycles run', String(ap.cycle)],
      ['titles already queued or published', String(ap.done)],
      ['unfinished jobs right now', String(ap.queueDepth)],
      ['page cursor', `movies ${ap.cursors.movie} · shows ${ap.cursors.tv}`],
      ['last cycle', ap.lastRunAt ? shortTime(ap.lastRunAt) : 'never'],
      ['next cycle', !ap.config.enabled ? '—' : ap.running ? 'after this one' : shortTime(ap.nextRunAt)],
    ];
    for (const [label, value] of statusRows) status.append(h('tr', {}, h('th', { text: label }), h('td', { class: 'mono', text: value })));

    // A background refresh (the 10 s poll) must not clobber a half-typed form.
    if (!options.skipConfig) {
      $('#autopilot-enabled').checked = ap.config.enabled;
      $('#autopilot-minrating').value = String(ap.config.minRating);
      $('#autopilot-minheight').value = String(ap.config.minHeight);
      $('#autopilot-maxjobs').value = String(ap.config.maxJobsPerCycle);
      $('#autopilot-maxattempts').value = String(ap.config.maxAttempts);
      $('#autopilot-maxdepth').value = String(ap.config.maxQueueDepth);
      $('#autopilot-interval').value = String(Math.round((ap.config.intervalMs / 60_000) * 100) / 100);
      $('#autopilot-expand').checked = ap.config.expandSeries;
      $('#autopilot-movies').checked = ap.config.kinds.includes('movie');
      $('#autopilot-tv').checked = ap.config.kinds.includes('tv');
    }

    const report = ap.lastReport;
    $('#autopilot-report-head').textContent = report ? `cycle ${report.cycle} · ${shortTime(report.finishedAt)}` : '';
    const body = clear($('#autopilot-report-table tbody'));
    if (!report) {
      body.append(h('tr', {}, h('td', { class: 'muted', text: 'no cycle has run yet' })));
    } else {
      const rows = [
        ['queued', String(report.created)],
        ['titles scanned', String(report.scanned)],
        ['below the rating floor', String(report.belowRating)],
        ['already done', String(report.alreadyDone)],
        ['failed jobs retried', String(report.retried)],
        ['given up on', String(report.abandoned)],
        ['list restarted', report.wrapped ? 'yes' : 'no'],
      ];
      rows.push(report.paused ? ['paused', report.note] : ['note', report.note || '—']);
      for (const [label, value] of rows) body.append(h('tr', {}, h('th', { text: label }), h('td', { class: 'mono small', text: value })));
    }

    const skipped = clear($('#autopilot-skipped'));
    if (report?.skipped?.length) {
      skipped.append(h('div', { text: 'stepped over:' }));
      for (const item of report.skipped) skipped.append(h('div', { class: 'mono small', text: `· ${item.title} — ${item.reason}` }));
    }

    const log = clear($('#autopilot-log'));
    log.textContent = ap.log?.length ? ap.log.join('\n') : 'nothing logged yet';
  }

  async function refreshAutopilot(options = {}) {
    const quiet = options.quiet === true;
    let data;
    try {
      data = await api('GET', '/api/autopilot');
    } catch (error) {
      if (!quiet) toast(describeError(error), 'bad');
      return;
    }
    state.autopilot = data;
    renderAutopilot(data, { skipConfig: quiet });
  }

  $('#autopilot-save').addEventListener('click', async () => {
    try {
      const data = await api('PUT', '/api/autopilot', autopilotPatch());
      state.autopilot = data;
      renderAutopilot(data);
      toast(data.config.enabled ? 'autopilot saved and switched on' : 'autopilot saved', 'ok');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#autopilot-run').addEventListener('click', async () => {
    const button = $('#autopilot-run');
    button.disabled = true;
    button.textContent = 'running…';
    try {
      const data = await api('POST', '/api/autopilot/run');
      state.autopilot = data.state;
      renderAutopilot(data.state);
      const report = data.report;
      toast(report.paused ? `paused: ${report.note}` : `cycle ${report.cycle}: queued ${report.created}, retried ${report.retried}`, 'ok');
      await refreshJobs({ quiet: true });
    } catch (error) {
      toast(describeError(error), 'bad');
    } finally {
      button.disabled = false;
      button.textContent = 'Run a cycle now';
    }
  });

  $('#autopilot-reset').addEventListener('click', async () => {
    try {
      state.autopilot = await api('POST', '/api/autopilot/reset');
      renderAutopilot(state.autopilot);
      toast('cursors reset to page 1', 'ok');
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#autopilot-clear').addEventListener('click', async () => {
    try {
      state.autopilot = await api('POST', '/api/autopilot/log/clear');
      renderAutopilot(state.autopilot);
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  /* ------------------------------------------------------- archive check */

  /** "every 7 days", "every 12 h" — the interval as a person would say it. */
  function checkIntervalLabel(ms) {
    const hours = Math.max(1, Math.round(Number(ms) / 3_600_000));
    if (hours % 24 !== 0) return `every ${hours} h`;
    const days = hours / 24;
    return days === 1 ? 'every day' : `every ${days} days`;
  }

  function renderCheck(check, options = {}) {
    if (!check) return;
    state.archiveCheck = check;
    const configured = Boolean(state.settings?.archive?.configured);
    // A background refresh (the slow poll, or a sweep landing mid-edit) must not
    // clobber a half-typed interval.
    if (!options.skipConfig) {
      $('#check-enabled').checked = check.config.enabled;
      $('#check-interval').value = String(Math.round((check.config.intervalMs / 3_600_000) * 100) / 100);
      $('#check-batch').value = String(check.config.batchSize);
    }
    $('#check-enabled').disabled = !configured;
    $('#check-interval').disabled = !configured;
    $('#check-batch').disabled = !configured;
    $('#check-run').disabled = !configured;

    const totals = check.totals ?? {};
    const failing = check.lastSweep?.failingKeys ?? [];
    const named = failing.slice(0, 3).join(', ') + (failing.length > 3 ? ` and ${failing.length - 3} more` : '');
    const parts = [
      check.running ? 'a sweep is under way' : null,
      `${totals.archived ?? 0} archived`,
      `${totals.checked ?? 0} checked`,
      totals.failing ? `${totals.failing} stopped matching${named ? ` — ${named}` : ''}` : 'nothing has stopped matching',
      totals.never ? `${totals.never} never checked` : null,
    ].filter(Boolean);
    if (check.config.enabled) {
      parts.push(check.running ? 'the next pass follows this one' : check.nextRunAt ? `next pass ${whenLabel(check.nextRunAt)}` : 'no pass scheduled');
    } else {
      parts.push('switched off');
    }
    parts.push(check.lastRunAt ? `last pass ${whenLabel(check.lastRunAt)}` : 'no pass has run yet');
    $('#check-status').textContent = configured ? parts.join(' · ') : 'not configured — there is no archive to check';
    $('#check-log').textContent = check.log?.length ? check.log.join('\n') : 'nothing logged yet';
  }

  async function refreshCheck(options = {}) {
    const quiet = options.quiet === true;
    try {
      const data = await api('GET', '/api/archive/check');
      renderCheck(data, { skipConfig: quiet });
    } catch (error) {
      if (!quiet) toast(describeError(error), 'bad');
    }
  }

  $('#check-save').addEventListener('click', async () => {
    try {
      const data = await api('PUT', '/api/archive/check', {
        enabled: $('#check-enabled').checked,
        intervalMs: Math.round(Number($('#check-interval').value) * 3_600_000),
        batchSize: Number($('#check-batch').value),
      });
      renderCheck(data);
      toast(data.config.enabled ? `archive checks saved — ${checkIntervalLabel(data.config.intervalMs)}` : 'archive checks switched off', 'ok');
      // The Runtime table carries the same setting; keep it from going stale.
      void refreshSettings();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  $('#check-run').addEventListener('click', async () => {
    const button = $('#check-run');
    button.disabled = true;
    button.textContent = 'checking…';
    try {
      const data = await api('POST', '/api/archive/check/run');
      renderCheck(data);
      toast(data.running ? 'a check is under way — the Library shows it on each row' : data.lastSweep?.note ?? 'nothing was in R2 to check', 'ok');
      await refreshLibrary({ quiet: true });
    } catch (error) {
      toast(describeError(error), 'bad');
    } finally {
      button.disabled = false;
      button.textContent = 'Check now';
    }
  });

  $('#check-clear').addEventListener('click', async () => {
    try {
      renderCheck(await api('POST', '/api/archive/check/log/clear'));
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  });

  /* ------------------------------------------------------------ host list */

  function renderHosts() {
    const node = clear($('#host-list'));
    for (const provider of state.providers) {
      const box = h('input', { type: 'checkbox' });
      box.checked = state.only.has(provider.id);
      box.addEventListener('change', () => {
        if (box.checked) state.only.add(provider.id);
        else state.only.delete(provider.id);
      });
      node.append(h('label', {}, box, provider.name));
    }
    node.append(h('span', { class: 'muted small', text: 'none ticked = every host' }));
  }

  /* ---------------------------------------------------------------- boot */

  async function refreshHealth() {
    try {
      const data = await api('GET', '/api/health');
      state.health = data;
      $('#mode-badge').textContent = data.mock ? 'MOCK providers' : 'live providers';
      $('#tunnel-badge').textContent = `tunnel: ${data.tunnel?.state ?? 'unknown'}`;
    } catch {
      $('#mode-badge').textContent = 'offline';
    }
  }

  async function boot() {
    await refreshHealth();
    try {
      const data = await api('GET', '/api/sources/providers');
      state.providers = data.providers ?? [];
      $('#min-height').value = String(data.minHeight ?? 1080);
      $('#source-min-height').value = String(data.minHeight ?? 1080);
      renderHosts();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
    await refreshJobs();
    await refreshSettings();
    await refreshTunnel();
    connectEvents();
    // The stream carries every change, so these timers only cover what it does
    // not: the health/tunnel badge, the tabs that are not event-driven, and the
    // gaps while the stream is reconnecting.
    let tick = 0;
    setInterval(() => {
      tick += 1;
      if (!state.live) {
        // While the stream is down, the list is the fallback: re-read it.
        if (state.activeTab === 'queue') void refreshJobs({ quiet: true });
        else void refreshStats();
      }
      // Health (and with it the tunnel badge) moves slowly — about every 10 s.
      if (tick % 2 === 0) void refreshHealth();
      if (tick % 3 === 0) {
        // A title published while the Library tab is open should appear without a click.
        if (state.activeTab === 'library') void refreshLibrary({ quiet: true });
        // The autopilot's own cycle is minutes apart; a slow poll keeps the
        // status and the queue it just filled current.
        if (state.activeTab === 'autopilot') void refreshAutopilot({ quiet: true });
        // A sweep runs in the background, so the Settings panel follows it.
        if (state.activeTab === 'settings') void refreshCheck({ quiet: true });
      }
    }, 5000);
  }

  void boot();
})();
