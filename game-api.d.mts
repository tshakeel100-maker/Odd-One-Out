export function createGameHandler(options: {
  getStore: (options: { name: string; consistency: "strong" }) => unknown;
  rounds?: number;
  random?: () => number;
  now?: () => number;
  codeFactory?: () => string;
  tokenFactory?: () => string;
}): (request: Request) => Promise<Response>;
