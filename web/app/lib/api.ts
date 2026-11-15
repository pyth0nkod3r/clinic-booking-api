// Thin client for the booking API (a separate origin from this site).
const BASE = import.meta.env.VITE_API_BASE ?? "https://clinic-booking-api-lwo2.onrender.com";
const KEY: string = import.meta.env.VITE_API_KEY ?? "";

export interface Booking {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: string;
}

export interface Slot {
  id: string;
  provider: string;
  start: string;
  end: string;
  available: boolean;
}

export class ApiError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(status: number, message: string, retryAfter: number | null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { "X-API-Key": KEY };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // empty body
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, Number(res.headers.get("Retry-After")) || null);
  }
  return data as T;
}

export const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
