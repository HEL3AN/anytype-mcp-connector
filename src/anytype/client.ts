export class AnytypeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const msg =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : typeof body === "string"
          ? body
          : "request failed";
    super(`Anytype API ${status}: ${msg}`);
  }
}

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
  etag?: string;
}

type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Thin client for the Anytype JSON API v2. */
export class AnytypeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 30_000,
  ) {}

  get<T = unknown>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, body: unknown, query?: Query) {
    return this.request<T>("POST", path, { body, query });
  }

  patch<T = unknown>(path: string, body: unknown, opts: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("PATCH", path, { ...opts, body });
  }

  delete<T = unknown>(path: string, query?: Query) {
    return this.request<T>("DELETE", path, { query });
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    let data: unknown = text;
    if (text && res.headers.get("content-type")?.includes("json")) {
      try {
        data = JSON.parse(text);
      } catch {
        // keep raw text
      }
    }

    if (!res.ok) throw new AnytypeApiError(res.status, data);
    return { status: res.status, data: data as T, etag: res.headers.get("etag") ?? undefined };
  }
}

/**
 * Encodes one path segment. "." and ".." are refused: URL parsing would resolve them as dot segments
 * (also when percent-encoded), so an id like ".." could turn an object route into a space route.
 */
export function seg(value: string): string {
  if (!value || /^(\.|%2e){1,2}$/i.test(value)) throw new Error(`Invalid id: ${JSON.stringify(value)}`);
  return encodeURIComponent(value);
}
