import { vi } from "vitest";
import { GraphAuth } from "../src/graph.ts";

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
export function graphFixture(route: (url: URL) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) return json({ access_token: "access", expires_in: 3600 });
    return route(url);
  });
  const g = new GraphAuth({ get: () => "refresh", set: () => {}, clear: () => {} }, fetcher as typeof fetch);
  return { g, fetcher };
}
