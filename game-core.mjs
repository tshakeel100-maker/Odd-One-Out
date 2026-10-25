export const PROMPTS = [
  ['Name a fruit', 'Name a vegetable'],
  ['Name an animal', 'Name a sea animal'],
  ['Name something in a kitchen', 'Name something in a bathroom'],
  ['Name a sport', 'Name a board game'],
  ['Name a hot drink', 'Name a cold drink'],
  ['Name something you wear', 'Name something you carry'],
  ['Name a city', 'Name a country'],
  ['Name something that flies', 'Name something that floats'],
];

export class GameError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function makePlayer(token, name) {
  return { token, name, score: 0, answer: '', vote: null, odd: false };
}

export function makeRoom({ code, token, name, now = Date.now(), rounds = 5 }) {
  return {
    code,
    host: token,
    players: [makePlayer(token, name)],
    phase: 'lobby',
    round: 0,
    totalRounds: rounds,
    prompts: [],
    answerDeadlineAt: null,
    createdAt: now,
    updatedAt: now,
    escaped: false,
  };
}

function startRound(room, random, now) {
  room.round += 1;
  room.prompts = PROMPTS[(room.round - 1) % PROMPTS.length];
  for (const player of room.players) {
    player.answer = '';
    player.vote = null;
    player.odd = false;
  }
  room.players[Math.floor(random() * room.players.length)].odd = true;
  room.phase = 'answer';
  room.answerDeadlineAt = now + 120_000;
}

export function expireAnswer(room, now) {
  if (room.phase !== 'answer' || !room.answerDeadlineAt || now < room.answerDeadlineAt) return false;
  room.phase = 'discuss';
  room.answerDeadlineAt = null;
  room.updatedAt = now;
  return true;
}

function finishRound(room) {
  const counts = new Map();
  for (const player of room.players) {
    if (player.vote) counts.set(player.vote, (counts.get(player.vote) || 0) + 1);
  }
  const highest = Math.max(0, ...counts.values());
  const tiedForLead = [...counts.values()].filter((count) => count === highest).length > 1;
  const odd = room.players.find((player) => player.odd);
  const escaped = (counts.get(odd.token) || 0) < highest || (highest > 0 && tiedForLead);
  room.escaped = escaped;
  for (const player of room.players) {
    if (player.odd) {
      if (escaped) player.score += 2;
    } else if (player.vote === odd.token) {
      player.score += 1;
    }
  }
  room.phase = 'results';
  room.answerDeadlineAt = null;
}

export function applyAction(room, action, token, data, { now = Date.now(), random = Math.random } = {}) {
  if (action === 'join') {
    const name = String(data.name || '').trim().slice(0, 18);
    if (!name) throw new GameError(400, 'Enter your name.');
    if (room.phase !== 'lobby') throw new GameError(400, 'This game has already started.');
    if (room.players.length >= 8) throw new GameError(400, 'This room is full (8 players).');
    if (room.players.some((candidate) => candidate.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError(400, 'That name is already in this room.');
    }
    room.players.push(makePlayer(data.newToken, name));
    room.updatedAt = now;
    return room;
  }

  const player = room.players.find((candidate) => candidate.token === token);
  if (!player) throw new GameError(403, 'Player session not found. Rejoin the room.');

  if (action === 'start') {
    if (player.token !== room.host) throw new GameError(403, 'Only the host can start.');
    if (room.phase !== 'lobby' || room.players.length < 2) {
      throw new GameError(400, 'At least two players are needed.');
    }
    for (const candidate of room.players) candidate.score = 0;
    room.round = 0;
    startRound(room, random, now);
    room.updatedAt = now;
    return room;
  }

  if (action === 'answer') {
    if (room.phase !== 'answer') throw new GameError(400, 'Answer time is over.');
    if (player.answer) throw new GameError(400, 'Your answer is already locked in.');
    const answer = String(data.answer || '').trim().slice(0, 36);
    if (!answer) throw new GameError(400, 'Add an answer first.');
    player.answer = answer;
    if (room.players.every((candidate) => candidate.answer)) {
      room.phase = 'discuss';
      room.answerDeadlineAt = null;
    }
    room.updatedAt = now;
    return room;
  }

  if (action === 'vote') {
    if (!['discuss', 'vote'].includes(room.phase)) throw new GameError(400, 'Voting is not open.');
    if (player.vote) throw new GameError(400, 'Your vote is already locked in.');
    const target = room.players.find((candidate) => candidate.token === data.target || candidate.name === data.target);
    if (!target || target.token === player.token) throw new GameError(400, 'Choose another player.');
    player.vote = target.token;
    room.phase = 'vote';
    if (room.players.every((candidate) => candidate.vote)) finishRound(room);
    room.updatedAt = now;
    return room;
  }

  if (action === 'advance') {
    if (player.token !== room.host || !['results', 'done'].includes(room.phase)) {
      throw new GameError(403, 'The host can continue after the results.');
    }
    if (room.phase === 'done') {
      room.phase = 'lobby';
      room.round = 0;
      room.answerDeadlineAt = null;
      for (const candidate of room.players) {
        candidate.score = 0;
        candidate.answer = '';
        candidate.vote = null;
        candidate.odd = false;
      }
    } else if (room.round >= room.totalRounds) {
      room.phase = 'done';
    } else {
      startRound(room, random, now);
    }
    room.updatedAt = now;
    return room;
  }

  throw new GameError(404, 'Unknown game action.');
}

export function publicState(room, token) {
  const me = room.players.find((player) => player.token === token);
  if (!me) throw new GameError(403, 'Player session not found. Rejoin the room.');
  const reveal = ['discuss', 'vote', 'results', 'done'].includes(room.phase);
  const showRole = ['results', 'done'].includes(room.phase);
  const topScore = Math.max(...room.players.map((player) => player.score));
  const winners = room.phase === 'done'
    ? room.players.filter((player) => player.score === topScore).map((player) => player.name)
    : [];
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    maxRounds: room.totalRounds,
    host: me.token === room.host,
    players: room.players.map((player) => ({
      name: player.name,
      score: player.score,
      submitted: Boolean(player.answer),
      voted: Boolean(player.vote),
      isMe: player.token === token,
    })),
    prompt: room.phase === 'answer' ? (me.odd ? room.prompts[1] : room.prompts[0]) : null,
    odd: showRole ? room.players.find((player) => player.odd)?.name : null,
    prompts: showRole ? room.prompts : null,
    answers: reveal ? room.players.map((player) => ({
      name: player.name,
      answer: player.answer || '—',
      odd: showRole && player.odd,
    })) : [],
    myAnswer: me.answer,
    myVote: room.players.find((player) => player.token === me.vote)?.name || null,
    canStart: room.phase === 'lobby' && room.players.length >= 2,
    canAdvance: me.token === room.host && ['results', 'done'].includes(room.phase),
    winner: winners[0] || null,
    winners,
    escaped: room.escaped,
    answerDeadlineAt: room.answerDeadlineAt,
  };
}
