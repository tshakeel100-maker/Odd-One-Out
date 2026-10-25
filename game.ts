import { getStore } from '@netlify/blobs';
import { createGameHandler } from '../../lib/game-api.mjs';

const handler = createGameHandler({ getStore });

export default async function game(request: Request): Promise<Response> {
  return handler(request);
}
