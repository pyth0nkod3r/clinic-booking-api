import { useEffect, useMemo, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/home";
import { api, ApiError, fmt, type Booking, type Slot } from "../lib/api";

interface HomeData {
  slots: Slot[];
  error?: string;
}

// Browser-only data loading (SPA mode): the API lives on another origin.
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const provider = new URL(request.url).searchParams.get("provider");
  try {
    const data = await api<{ slots: Slot[] }>(
      "/slots" + (provider ? `?provider=${encodeURIComponent(provider)}` : ""),
    );
    return { slots: data.slots } satisfies HomeData;
  } catch (e) {
    return { slots: [], error: e instanceof Error ? e.message : "Failed to load slots" } satisfies HomeData;
  }
}

interface ActionData {
  ok: boolean;
  booking?: Booking;
  error?: string;
  retryAfter?: number | null;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "book");

  if (intent === "book") {
    const body = {
      slot_id: String(form.get("slot_id") ?? ""),
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
    };
    // Same key for retries of this exact submission -> the API replays the
    // original response instead of double-booking (spec level 4).
    const idempotencyKey = String(form.get("idempotency_key") ?? "");
    try {
      const booking = await api<Booking>("/bookings", {
        method: "POST",
        body,
        idempotencyKey,
      });
      return { ok: true, booking } satisfies ActionData;
    } catch (e) {
      if (e instanceof ApiError) {
        return { ok: false, error: e.message, retryAfter: e.retryAfter } satisfies ActionData;
      }
      throw e;
    }
  }
  throw new Response("unknown intent", { status: 400 });
}

function newIdempotencyKey() {
  return crypto.randomUUID();
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof clientAction>();
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const [deletedSlots, setDeletedSlots] = useState<Set<string>>(new Set());

  const slots = loaderData.slots;
  const providers = useMemo(() => [...new Set(slots.map((s) => s.provider))], [slots]);
  const busy = fetcher.state !== "idle";
  const booking = fetcher.state === "idle" && fetcher.data?.ok ? fetcher.data.booking : undefined;
  const failure = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data : undefined;

  // After a successful booking, refresh availability and start a fresh key so
  // the next booking is a genuinely new request.
  useEffect(() => {
    if (booking) {
      setDeletedSlots((prev) => {
        const next = new Set(prev);
        next.add(booking.slot_id);
        return next;
      });
      setIdemKey(newIdempotencyKey());
    }
  }, [booking]);

  const available = (s: Slot) => s.available && !deletedSlots.has(s.id);

  return (
    <div className="grid gap-6 md:grid-cols-[1.2fr_0.8fr]">
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">Available appointments</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">Earliest first.</p>
          </div>
          <select
            value={searchParams.get("provider") ?? ""}
            onChange={(e) => setSearchParams(e.target.value ? { provider: e.target.value } : {})}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        {loaderData.error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {loaderData.error}
          </p>
        )}

        <ul className="mt-4 space-y-2">
          {slots.length === 0 && !loaderData.error && (
            <li className="text-sm text-gray-500">No slots configured yet.</li>
          )}
          {slots.map((s) => (
            <li
              key={s.id}
              className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm ${
                available(s)
                  ? "border-gray-200 dark:border-gray-800"
                  : "border-gray-200 opacity-50 dark:border-gray-800"
              }`}
            >
              <div>
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {fmt(s.start)} – {fmt(s.end).split(", ").pop()}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {s.provider} · id {s.id}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    available(s)
                      ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                      : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                  }`}
                >
                  {available(s) ? "Available" : "Booked"}
                </span>
                <button
                  type="button"
                  disabled={!available(s) || busy}
                  onClick={() => {
                    const el = document.getElementById("booking-form");
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                    (el?.querySelector<HTMLInputElement>('select[name="slot_id"]') ?? { value: "" }).value = s.id;
                  }}
                  className="rounded-lg bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-40"
                >
                  Book
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section id="booking-form" className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="font-semibold text-gray-900 dark:text-gray-100">Book a slot</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">Leave your details and confirm.</p>

        <fetcher.Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="book" />
          <input type="hidden" name="idempotency_key" value={idemKey} />
          <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400">
            Time slot
            <select
              name="slot_id"
              defaultValue=""
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="" disabled>
                {slots.some(available) ? "Select a time slot…" : "No available slots right now"}
              </option>
              {slots.map((s) => (
                <option key={s.id} value={s.id} disabled={!available(s)}>
                  {fmt(s.start)} — {s.provider}
                  {available(s) ? "" : " (booked)"}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400">
            Full name
            <input
              name="name"
              autoComplete="name"
              placeholder="e.g. Ada Obi"
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </label>
          <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400">
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="ada@example.com"
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
          >
            {busy ? "Booking…" : "Confirm booking"}
          </button>
        </fetcher.Form>

        {booking && (
          <div className="mt-4 rounded-xl border-l-4 border-green-600 bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950 dark:text-green-200">
            <b>✅ Appointment confirmed!</b>
            <div className="mt-1">
              Confirmation code: <code className="rounded bg-green-100 px-1.5 dark:bg-green-900">{booking.id}</code>
            </div>
            <div className="mt-1 text-xs">
              Booked for <b>{booking.name}</b> ({booking.email}) at {fmt(booking.created_at)}.
            </div>
          </div>
        )}
        {failure && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {failure.error}
            {failure.retryAfter ? ` — try again in ${failure.retryAfter}s` : ""}
          </p>
        )}
      </section>
    </div>
  );
}
