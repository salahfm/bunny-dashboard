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
    tunnel: null,
    only: new Set(),
    autoRefresh: true,
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

  /* --------------------------------------------------------------- tabs */

  function showTab(name) {
    for (const button of document.querySelectorAll('.nav-item')) {
      button.classList.toggle('is-active', button.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('is-active', panel.id === `tab-${name}`);
    }
    if (name === 'queue') void refreshJobs();
    if (name === 'accounts') void refreshAccounts();
    if (name === 'watch') void refreshWatch();
    if (name === 'settings') void refreshSettings();
    if (name === 'settings') void runNetworkCheck();
    if (name === 'source') void refreshTunnel();
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
    $('#target-panel').classList.remove('hidden');
    $('#target-title').textContent = `${result.title}${result.year ? ` (${result.year})` : ''}`;
    $('#target-meta').textContent = `${result.mediaType === 'tv' ? 'TV show' : 'Movie'} · TMDB ${result.tmdbId}`;

    const seasonPicker = $('#season-picker');
    const episodeList = clear($('#episode-list'));
    seasonPicker.classList.add('hidden');
    $('#preview-output').classList.add('hidden');

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

  async function loadSeason(seasonNumber) {
    const list = clear($('#episode-list'));
    if (!state.target) return;
    try {
      const data = await api('GET', `/api/tmdb/tv/${state.target.tmdbId}/season/${seasonNumber}`);
      state.episodes = data.episodes ?? [];
      for (const episode of state.episodes) {
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
              text: state.episode?.episode === episode.episodeNumber ? 'selected' : 'select',
              onclick: () => {
                state.episode = { season: seasonNumber, episode: episode.episodeNumber, name: episode.name };
                void loadSeason(seasonNumber);
              },
            }),
          ),
        );
      }
      if (!state.episode && state.episodes.length) {
        state.episode = { season: seasonNumber, episode: state.episodes[0].episodeNumber, name: state.episodes[0].name };
        void loadSeason(seasonNumber);
      }
    } catch (error) {
      list.append(h('div', { class: 'list-item' }, h('span', { class: 'small', text: describeError(error) })));
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

  async function refreshJobs() {
    try {
      const data = await api('GET', `/api/jobs?limit=200${$('#queue-filter').value ? `&status=${$('#queue-filter').value}` : ''}`);
      state.jobs = data.jobs ?? [];
      state.stats = data.stats ?? null;
    } catch (error) {
      toast(describeError(error), 'bad');
      return;
    }
    renderJobs();
    renderCounts();
  }

  function renderCounts() {
    const stats = state.stats;
    const counts = stats?.counts ?? {};
    $('#queue-badge').textContent = `${stats?.active ?? 0} active · ${stats?.queued ?? 0} queued`;
    $('#queue-summary').textContent = stats
      ? `uploading ${counts.uploading ?? 0} · encoding ${counts.encoding ?? 0} · ready ${counts.ready ?? 0} · failed ${counts.failed ?? 0} · cancelled ${counts.cancelled ?? 0} · capacity ${stats.capacity}`
      : '';
  }

  function renderJobs() {
    const body = clear($('#jobs-table tbody'));
    if (!state.jobs.length) {
      body.append(h('tr', {}, h('td', { colspan: '7', class: 'muted', text: 'no jobs' })));
      return;
    }
    for (const job of state.jobs) {
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

      body.append(
        h(
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
        ),
      );
    }
  }

  function selectJob(jobId) {
    state.selectedJobId = state.selectedJobId === jobId ? null : jobId;
    renderJobDetail();
  }

  function renderJobDetail() {
    const box = clear($('#job-detail'));
    const job = state.jobs.find((entry) => entry.id === state.selectedJobId);
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
  }

  async function jobAction(jobId, action) {
    try {
      if (action === 'delete') await api('DELETE', `/api/jobs/${jobId}`);
      else await api('POST', `/api/jobs/${jobId}/${action}`);
      await refreshJobs();
      renderJobDetail();
    } catch (error) {
      toast(describeError(error), 'bad');
    }
  }

  $('#queue-filter').addEventListener('change', () => void refreshJobs());

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
            h('td', { class: 'mono', text: `${use.active}/${use.capacity}` }),
            h(
              'td',
              { class: 'actions' },
              h('button', { text: 'test', onclick: () => void testAccount(account.id) }),
              h('button', { text: account.enabled ? 'disable' : 'enable', onclick: () => void toggleAccount(account) }),
              h('button', { text: 'delete', onclick: () => void removeAccount(account) }),
            ),
          ),
        );
      }
      if (!state.accounts.length) body.append(h('tr', {}, h('td', { colspan: '6', class: 'muted', text: 'no accounts yet' })));
      $('#account-limit').textContent = `${state.accounts.length} of ${data.maxAccounts} accounts · ${data.perAccountConcurrency} uploads each`;
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

  $('#account-add').addEventListener('click', async () => {
    const body = {
      name: $('#account-name').value.trim(),
      libraryId: $('#account-library').value.trim(),
      apiKey: $('#account-key').value.trim(),
      pullZoneHost: $('#account-pullzone').value.trim(),
    };
    try {
      await api('POST', '/api/accounts', body);
      $('#account-name').value = '';
      $('#account-library').value = '';
      $('#account-key').value = '';
      $('#account-pullzone').value = '';
      toast('account added', 'ok');
      await refreshAccounts();
    } catch (error) {
      toast(describeError(error), 'bad');
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
    $('#mode-badge').textContent = settings.mock ? 'MOCK providers' : 'live providers';

    const runtime = clear($('#runtime-table tbody'));
    const rows = [
      ['TMDB credential', settings.tmdbConfigured ? settings.tmdbCredentialSource : 'not configured'],
      ['upload transport', `${settings.uploadMode}${settings.tusChunkBytes ? ` · ${bytes(settings.tusChunkBytes)} chunks` : ''}`],
      ['segment downloads', `${settings.streamConcurrency} at a time`],
      ['tunnel', settings.source?.tunnelEnabled ? settings.source.tunnelPublicUrl ?? 'quick tunnel (cloudflared)' : 'disabled'],
      ['scrape floor', `${settings.source?.minHeight ?? 1080}p`],
      ['watched folder', settings.watchEnabled ? settings.watchDir || '(not set)' : 'off'],
      ['limits', `≤${settings.limits.maxAccounts} accounts · ≤${settings.limits.perAccountConcurrency} uploads each · ${bytes(settings.limits.maxUploadBytes)} per file`],
      ['network calls', `${settings.network?.timeoutMs ?? 30000} ms per attempt · ${settings.network?.retries ?? 3} retries`],
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
  }

  $('#settings-save').addEventListener('click', async () => {
    const body = {
      perAccountConcurrency: Number($('#settings-concurrency').value),
      maxAccounts: Number($('#settings-maxaccounts').value),
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
    setInterval(() => {
      if (!state.autoRefresh) return;
      void refreshJobs();
      void refreshHealth();
    }, 2000);
  }

  $('#queue-autorefresh').addEventListener('change', (event) => {
    state.autoRefresh = event.target.checked;
  });

  void boot();
})();
