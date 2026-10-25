import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameHandler } from '../lib/game-api.mjs';
import { PROMPTS } from '../lib/game-core.mjs';

class MemoryBlobs {
  entries = new Map();
  version = 0;
  conditionalWrites = 0;
  strongReads = 0;

  async getWithMetadata(key, options) {
    await Promise.resolve();
    assert.equal(options.consistency, 'strong');
    this.strongReads += 1;
    const entry = this.entries.get(key);
    return entry ? { data: structuredClone(entry.data), etag: entry.etag } : null;
  }

  async setJSON(key, value, options = {}) {
    await Promise.resolve();
    const current = this.entries.get(key);
    if (options.onlyIfNew || options.onlyIfMatch) this.conditionalWrites += 1;
    if (options.onlyIfNew && current) return { modified: false };
    if (options.onlyIfMatch && (!current || current.etag !== options.onlyIfMatch)) return { modified: false };
    const etag = `"v${++this.version}"`;
    this.entries.set(key, { data: structuredClone(value), etag });
    return { modified: true, etag };
  }
}

const responseJson = async (response) => ({ status: response.status, body: await response.json() });

test('two players complete three rounds with correct scoring and winner', async () => {
  const blobs = new MemoryBlobs();
  let now = 1_800_000_000_000;
  const handler = createGameHandler({
    getStore(options) {
      assert.equal(options.name, 'odd-one-out-games');
      assert.equal(options.consistency, 'strong');
      return blobs;
    },
    rounds: 3,
    random: () => 0,
    now: () => now,
    codeFactory: () => 'ABC123',
  });

  const post = async (action, data = {}) => responseJson(await handler(new Request('https://game.test/.netlify/functions/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...data }),
  })));
  const get = async (session) => responseJson(await handler(new Request(
    `https://game.test/.netlify/functions/game?code=${session.code}&token=${session.token}`,
  )));

  const created = await post('create', { name: 'Host' });
  assert.equal(created.status, 200);
  const host = { code: created.body.code, token: created.body.token };
  const joined = await post('join', { code: host.code, name: 'Guest' });
  assert.equal(joined.status, 200);
  const guest = { code: host.code, token: joined.body.token };
  assert.equal((await post('start', host)).body.phase, 'answer');

  for (let round = 1; round <= 3; round += 1) {
    const hostPrompt = (await get(host)).body.prompt;
    const guestPrompt = (await get(guest)).body.prompt;
    assert.equal(hostPrompt, PROMPTS[(round - 1) % PROMPTS.length][1]);
    assert.equal(guestPrompt, PROMPTS[(round - 1) % PROMPTS.length][0]);
    assert.equal((await get(host)).body.answers.length, 0, 'secret answers stay hidden');

    const answers = await Promise.all([
      post('answer', { ...host, answer: `host-${round}` }),
      post('answer', { ...guest, answer: `guest-${round}` }),
    ]);
    assert.deepEqual(answers.map((item) => item.status), [200, 200]);
    const discussion = await get(host);
    assert.equal(discussion.body.phase, 'discuss');
    assert.equal(discussion.body.answers.length, 2);

    const firstVote = await post('vote', { ...host, target: 'Guest' });
    assert.equal(firstVote.body.phase, 'vote');
    assert.deepEqual(firstVote.body.players.map((p) => p.score), [(round - 1) * 2, round - 1]);
    const results = await post('vote', { ...guest, target: 'Host' });
    assert.equal(results.body.phase, 'results');
    assert.equal(results.body.escaped, true, 'a tied vote lets the odd player escape');
    assert.deepEqual(results.body.players.map((p) => p.score), [round * 2, round]);

    now += 1_000;
    if (round < 3) assert.equal((await post('advance', host)).body.phase, 'answer');
  }

  const final = await post('advance', host);
  assert.equal(final.body.phase, 'done');
  assert.deepEqual(final.body.winners, ['Host']);
  assert.deepEqual(final.body.players.map((p) => p.score), [6, 3]);
  assert.ok(blobs.strongReads > 0);
  assert.ok(blobs.conditionalWrites >= 10);
});





