import { useEffect, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/my-bookings";
import { api, ApiError, fmt, type Booking, type Slot } from "../lib/api";

interface LookupData {
  bookings: Booking[];
  nextCursor: string | null;
  error?: string;
  lookedUp: boolean;
}

// Browser-only lookup (SPA mode). Email comes from the query string so a
// lookup is a shareable URL like /my-bookings?email=ada@example.com.
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const email = new URL(request.url).searchParams.get("email")?.trim() ?? "";
  if (!email) return { bookings: [], nextCursor: null, lookedUp: false } satisfies LookupData;
  try {
    const data = await api<{ bookings: Booking[]; next_cursor: string | null }>(
      `/bookings?email=${encodeURIComponent(email)}`,
    );
    return { bookings: data.bookings, nextCursor: data.next_cursor, lookedUp: true } satisfies LookupData;
  } catch (e) {
    return {
      bookings: [],
      nextCursor: null,
      lookedUp: true,
      error: e instanceof Error ? e.message : "Lookup failed",
    } satisfies LookupData;
  }
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  if (String(form.get("intent")) !== "cancel") throw new Response("unknown intent", { status: 400 });
  const id = String(form.get("id") ?? "");
  try {
    await api<Booking>(`/bookings/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { cancelled: id, error: null };
  } catch (e) {
    return { cancelled: null, error: e instanceof Error ? e.message : "Cancel failed" };
  }
}

interface Page {
  bookings: Booking[];
  nextCursor: string | null;
}

export default function MyBookings({ loaderData }: Route.ComponentProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof clientAction>();
  const emailParam = searchParams.get("email") ?? "";
  const [emailInput, setEmailInput] = useState(emailParam);
  const [pages, setPages] = useState<Page[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  // Reset the accumulated pages whenever a new lookup happens.
  useEffect(() => {
    setEmailInput(emailParam);
    setPages(loaderData.lookedUp ? [{ bookings: loaderData.bookings, nextCursor: loaderData.nextCursor }] : []);
  }, [loaderData, emailParam]);

  const cancelError = fetcher.state === "idle" && fetcher.data && !fetcher.data.cancelled ? fetcher.data.error : null;
  const justCancelled = fetcher.state === "idle" ? fetcher.data?.cancelled : undefined;

  const allBookings = pages.flatMap((p) => p.bookings);
  const nextCursor = pages.length ? pages[pages.length - 1].nextCursor : null;

  async function loadMore() {
    if (!nextCursor || !emailParam) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const data = await api<{ bookings: Booking[]; next_cursor: string | null }>(
        `/bookings?email=${encodeURIComponent(emailParam)}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setPages((prev) => [...prev, { bookings: data.bookings, nextCursor: data.next_cursor }]);
    } catch (e) {
      setMoreError(e instanceof ApiError ? e.message : "Could not load more");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="mx-auto max-w-2xl rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="font-semibold text-gray-900 dark:text-gray-100">My bookings</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Look up everything booked with an email address, oldest first.
      </p>

      <form
        method="get"
        onSubmit={(e) => {
          e.preventDefault();
          const v = emailInput.trim();
          setSearchParams(v ? { email: v } : {});
        }}
        className="mt-4 flex flex-wrap gap-2"
      >
        <input
          name="email"
          type="email"
          required
          value={emailInput}
          onChange={(e) => setEmailInput(e.target.value)}
          placeholder="ada@example.com"
          className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
        <button
          type="submit"
          className="rounded-lg border border-cyan-700 px-4 py-2 text-sm font-semibold text-cyan-700 hover:bg-cyan-50 dark:hover:bg-cyan-950"
        >
          Find bookings
        </button>
      </form>

      {loaderData.error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {loaderData.error}
        </p>
      )}
      {cancelError && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {cancelError}
        </p>
      )}
      {moreError && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {moreError}
        </p>
      )}

      {loaderData.lookedUp && (
        <ul className="mt-4 space-y-2">
          {allBookings.length === 0 && (
            <li className="text-sm text-gray-500">No bookings found for that email.</li>
          )}
          {allBookings.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-4 py-2.5 text-sm dark:border-gray-800"
            >
              <div className="min-w-0">
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {b.name} · slot {b.slot_id}
                </div>
                <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {b.id} · booked {fmt(b.created_at)}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    b.status === "confirmed"
                      ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                  }`}
                >
                  {b.status}
                </span>
                {b.status === "confirmed" && (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <input type="hidden" name="id" value={b.id} />
                    <button
                      type="submit"
                      disabled={fetcher.state !== "idle"}
                      className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
                    >
                      {fetcher.state !== "idle" ? "Cancelling…" : "Cancel"}
                    </button>
                  </fetcher.Form>
                )}
                {justCancelled === b.id && (
                  <span className="text-xs text-gray-400">Slot freed again</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-4 rounded-lg border border-cyan-700 px-4 py-2 text-sm font-semibold text-cyan-700 hover:bg-cyan-50 disabled:opacity-50 dark:hover:bg-cyan-950"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
