// The desktop app only imports cardLive.ts for its message format; its server-side Redis helpers are never bundled.
// This stands in for @upstash/redis's type so the app type-checks where that package isn't installed (public repo).
export type Redis = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
};
