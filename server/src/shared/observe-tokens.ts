/**
 * Shared observe token store.
 * Lobby server creates tokens, game server validates them.
 */

interface ObserveTokenData {
  gameClientWs: any;  // WebSocket of the game client being observed
  createdAt: number;
}

const tokens: Map<string, ObserveTokenData> = new Map();

export function createObserveToken(gameClientWs: any): string {
  const token = `observe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  tokens.set(token, { gameClientWs, createdAt: Date.now() });
  return token;
}

export function validateObserveToken(token: string): any | null {
  const data = tokens.get(token);
  if (!data) return null;
  // Tokens expire after 1 hour
  if (Date.now() - data.createdAt > 3600000) {
    tokens.delete(token);
    return null;
  }
  return data.gameClientWs;
}

export function removeObserveToken(token: string): void {
  tokens.delete(token);
}
