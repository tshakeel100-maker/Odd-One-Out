import { applyAction, expireAnswer, GameError, makeRoom, publicState } from './game-core.mjs';

const STORE_NAME = 'odd-one-out-games';
const MAX_CAS_RETRIES = 10;
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const normalizeCode = (value) => String(value || '').trim().toUpperCase();
const cleanName = (value) => String(value || '').trim().slice(0, 18);
const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)))
  .map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 6).toUpperCase();
const makeToken = () => crypto.randomUUID().replaceAll('-', '');

export function createGameHandler({ getStore, rounds = 5, random = Math.random, now = () => Date.now(), codeFactory = makeCode, tokenFactory = makeToken }) {
  return async function gameHandler(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { allow: 'GET, POST, OPTIONS' } });
    }
    if (!['GET', 'POST'].includes(request.method)) {
      return jsonResponse({ error: 'Use GET or POST.' }, 405);
    }

    try {
      const store = getStore({ name: STORE_NAME, consistency: 'strong' });
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const code = normalizeCode(url.searchParams.get('code'));
        const token = url.searchParams.get('token') || '';
        if (!code || !token) throw new GameError(400, 'Room code and player session are required.');
        const current = await readRoom(store, code, now());
        if (!current) throw new GameError(404, 'Room not found. Check the code or create a new room.');
        return jsonResponse(publicState(current.room, token));
      }

      let body;
      try { body = await request.json(); } catch { throw new GameError(400, 'Request body must be JSON.'); }
      const action = String(body.action || '');
      if (action === 'create') {
        const name = cleanName(body.name);
        if (!name) throw new GameError(400, 'Enter your name.');
        const token = tokenFactory();
        for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
          const code = normalizeCode(codeFactory());
          const room = makeRoom({ code, token, name, now: now(), rounds });
          const result = await store.setJSON(code, room, { onlyIfNew: true });
          if (result.modified) return jsonResponse({ code, token });
        }
        throw new GameError(503, 'Could not reserve a room code. Please try again.');
      }

      const code = normalizeCode(body.code);
      if (!code) throw new GameError(400, 'Room code is required.');
      if (action === 'join') {
        const newToken = tokenFactory();
        await mutateRoom(store, code, '', action, { ...body, newToken }, { now, random });
        return jsonResponse({ code, token: newToken });
      }
      const token = String(body.token || '');
      if (!token) throw new GameError(400, 'Player session is required.');
      const room = await mutateRoom(store, code, token, action, body, { now, random });
      return jsonResponse(publicState(room, token));
    } catch (error) {
      if (error instanceof GameError) return jsonResponse({ error: error.message }, error.status);
      return jsonResponse({ error: 'The game service could not save this move. Please retry.' }, 500);
    }
  };
}

async function readRoom(store, code, timestamp) {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const entry = await store.getWithMetadata(code, { type: 'json', consistency: 'strong' });
    if (!entry) return null;
    const room = entry.data;
    if (!expireAnswer(room, timestamp)) return { room, etag: entry.etag };
    const result = await store.setJSON(code, room, { onlyIfMatch: entry.etag });
    if (result.modified) return { room, etag: result.etag };
  }
  throw new GameError(409, 'The room changed at the same time. Please retry.');
}

async function mutateRoom(store, code, token, action, body, options) {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const current = await readRoom(store, code, options.now());
    if (!current) throw new GameError(404, 'Room not found. Check the code or create a new room.');
    const draft = structuredClone(current.room);
    applyAction(draft, action, token, body, { now: options.now(), random: options.random });
    const result = await store.setJSON(code, draft, { onlyIfMatch: current.etag });
    if (result.modified) return draft;
  }
  throw new GameError(409, 'The room changed at the same time. Please retry.');
}

