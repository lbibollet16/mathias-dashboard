/**
 * Amazon SP-API client — LWA token exchange + authenticated fetch.
 *
 * Env vars requis (à ajouter à .env.local + Vercel) :
 *   LWA_CLIENT_ID
 *   LWA_CLIENT_SECRET
 *   SP_API_REFRESH_TOKEN
 *   SP_API_ENDPOINT       e.g. https://sellingpartnerapi-na.amazon.com (prod)
 *   LWA_TOKEN_ENDPOINT    e.g. https://api.amazon.com/auth/o2/token
 *   SP_API_SELLER_ID
 *
 * Ces valeurs sont identiques à celles de mathias-power-parts — copie-les
 * depuis Vercel mathias-power-parts → Settings → Environment Variables.
 *
 * Docs: https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api
 */

import 'server-only';

const USER_AGENT = 'MathiasDashboard/1.0 (Language=TypeScript; Platform=Node)';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[sp-api] missing env var: ${name}`);
  return v;
}

// ---------- LWA access token cache ----------

let cachedToken: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.value;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch(env('LWA_TOKEN_ENDPOINT'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: env('SP_API_REFRESH_TOKEN'),
        client_id: env('LWA_CLIENT_ID'),
        client_secret: env('LWA_CLIENT_SECRET'),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[sp-api] LWA ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return json.access_token;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// ---------- SP-API fetch ----------

export class SPAPIError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
    public body: unknown,
    /**
     * Seconds to wait before retrying. Only populated for 429 — derived
     * from `x-amzn-ratelimit-limit` (Amazon publishes the per-endpoint
     * refill rate in req/sec; reciprocal = seconds per token). When
     * the header is absent we default to 60s for `POST /reports/...`
     * which is the strictest documented limit (0.0167 req/s).
     */
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SPAPIError';
  }

  /** True for 429 — useful for route handlers to surface a friendly response. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * Builds a structured JSON body + HTTP status for a route catching an
 * SP-API error. Surfaces 429s with `rate_limited: true` and a wait time,
 * so the frontend can show "réessayer dans X min" with a countdown
 * instead of the raw `"POST /reports/... -> 429"` string.
 */
export function spApiErrorResponse(err: unknown): {
  body: {
    ok: false;
    error: string;
    rate_limited?: true;
    retry_after_seconds?: number;
    retry_at?: string;
    endpoint?: string;
  };
  status: number;
} {
  if (err instanceof SPAPIError && err.isRateLimited) {
    const seconds = err.retryAfterSeconds ?? 60;
    const retryAt = new Date(Date.now() + seconds * 1000).toISOString();
    return {
      body: {
        ok: false,
        error: `Amazon SP-API t'a rate-limité sur ${err.message.replace(/ -> 429$/, '')}. Réessaye dans ${seconds}s (vers ${new Date(retryAt).toLocaleTimeString('fr-CA')}). C'est normal après plusieurs tirs rapprochés — le bucket Amazon se remplit lentement.`,
        rate_limited: true,
        retry_after_seconds: seconds,
        retry_at: retryAt,
        endpoint: err.message,
      },
      status: 429,
    };
  }
  if (err instanceof SPAPIError) {
    return {
      body: { ok: false, error: err.message, endpoint: err.message },
      status: err.status >= 400 && err.status < 600 ? err.status : 502,
    };
  }
  return {
    body: { ok: false, error: err instanceof Error ? err.message : String(err) },
    status: 500,
  };
}

export interface SPAPIRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
  /** Max retries on 429/5xx. Default 3. */
  retries?: number;
  /** Skip Authorization header — used to fetch the signed report download URL. */
  noAuth?: boolean;
}

function buildUrl(path: string, query?: SPAPIRequest['query']): string {
  const base = env('SP_API_ENDPOINT').replace(/\/+$/, '');
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) qs.set(k, v.join(','));
      else qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return `${base}${path.startsWith('/') ? path : '/' + path}${s ? '?' + s : ''}`;
}

export async function spApiCall<T = unknown>(req: SPAPIRequest): Promise<T> {
  const retries = req.retries ?? 3;
  const url = req.path.startsWith('http')
    ? req.path
    : buildUrl(req.path, req.query);
  const method = req.method ?? 'GET';

  let attempt = 0;
  while (true) {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
    };
    if (!req.noAuth) {
      headers['x-amz-access-token'] = await getAccessToken();
    }
    if (req.body) headers['content-type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: req.body ? JSON.stringify(req.body) : undefined,
    });

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        return (await res.json()) as T;
      }
      // Pour les downloads de reports (TSV/CSV/JSON files), on retourne le texte brut.
      return (await res.text()) as unknown as T;
    }

    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep raw */
    }

    const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
    const rlHeader = res.headers.get('x-amzn-ratelimit-limit');
    const rl = rlHeader ? Number.parseFloat(rlHeader) : NaN;
    if (retriable && attempt < retries) {
      const baseDelay = Number.isFinite(rl) && rl > 0 ? 1000 / rl : 500 * 2 ** attempt;
      const delay = Math.min(baseDelay + Math.random() * 250, 10_000);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
      continue;
    }

    const code =
      typeof parsed === 'object' && parsed !== null && 'errors' in parsed
        ? (parsed as { errors?: Array<{ code?: string }> }).errors?.[0]?.code
        : undefined;

    // For 429 we compute how long the caller should wait before retrying.
    // Amazon publishes the refill rate (tokens/sec) in `x-amzn-ratelimit-limit`.
    // The reciprocal is the seconds-per-token; if we burned the burst, we
    // need at minimum that many seconds for a single token to come back.
    // Round UP and add 5s jitter so the user never retries at the exact
    // boundary. Fallback to 60s — the documented worst case for
    // `POST /reports/2021-06-30/reports`.
    let retryAfter: number | undefined;
    if (res.status === 429) {
      const secondsPerToken = Number.isFinite(rl) && rl > 0 ? 1 / rl : 60;
      retryAfter = Math.ceil(secondsPerToken) + 5;
    }
    throw new SPAPIError(
      res.status,
      code,
      `${method} ${req.path} -> ${res.status}`,
      parsed,
      retryAfter,
    );
  }
}
