/**
 * Loaded inside the spawned dashboard (`node --import tsx --import …`) when the
 * crash-resume test runs it. Bunny's public base URL is rewritten to the local
 * fake server, so the dashboard runs its real code — real HTTP, real TUS
 * requests — against a Bunny that survives a kill. No production code changes.
 */
const target = process.env.FAKE_BUNNY_URL;
const BUNNY = 'https://video.bunnycdn.com';

if (target) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === BUNNY || url.startsWith(`${BUNNY}/`)) {
      return original(target + url.slice(BUNNY.length), init);
    }
    return original(input as string | URL | Request, init);
  }) as typeof fetch;
}
