'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { MyBooking, StateView, ToiletView } from '@/lib/types';

type Props = { email: string; isAdmin: boolean; csrfToken: string; vapidPublicKey: string | null };
type Action = 'book' | 'cancel' | 'claim' | 'done' | 'still-here';
type Api = (path: string, method: string, body?: unknown) => Promise<Response>;
type Mutate = (path: string, method?: string, body?: unknown) => Promise<StateView | null>;
type Card = { tone: keyof typeof TONES; headline: string; detail: string | null; actions: [Action, string][] };

// Every tone comes with a text headline, so colour is never the only signal.
const TONES = {
  free: 'border-emerald-600 bg-emerald-50',
  occupied: 'border-rose-600 bg-rose-50',
  attention: 'border-amber-500 bg-amber-50',
  closed: 'border-slate-300 bg-slate-100 text-slate-600',
};

export default function LooApp({ email, isAdmin, csrfToken, vapidPublicKey }: Props) {
  const [view, setView] = useState<StateView | null>(null);
  const [live, setLive] = useState<boolean | null>(null); // null until the first connection
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const mine = view?.myBooking ?? null;
  const now = useClock(Boolean(mine?.deadline));

  // The server sends the caller's full view on connect and again whenever it changes.
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onopen = () => setLive(true);
    events.onmessage = (e: MessageEvent<string>) => setView(JSON.parse(e.data) as StateView);
    events.onerror = () => setLive(false); // EventSource reconnects by itself
    return () => events.close();
  }, []);

  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);

  // Announce (screen readers) and buzz (phones) when the user has to act.
  const cue = mine?.status === 'NOTIFIED' ? "It's your turn! Tap “I'm going in”." : mine?.stillThere ? 'Are you still there?' : '';
  useEffect(() => {
    if (!cue) return;
    setNotice(cue);
    navigator.vibrate?.(300);
  }, [cue]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 8000);
    return () => clearTimeout(id);
  }, [notice]);

  const api: Api = (path, method, body) =>
    fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const mutate: Mutate = async (path, method = 'POST', body) => {
    setBusy(true);
    try {
      const res = await api(path, method, body);
      const data = (await res.json()) as StateView & { error?: string };
      if (!res.ok) {
        setNotice(data.error ?? 'Something went wrong.');
        return null;
      }
      setView(data);
      return data;
    } catch {
      setNotice('Network problem. Please try again.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  async function act(toilet: ToiletView, action: Action) {
    if (busy) return;
    const next = await mutate(action === 'book' ? `/api/toilets/${toilet.id}/book` : `/api/bookings/${mine?.id}/${action}`);
    // Ask for notification permission only once the user actually has to wait.
    if (next?.myBooking?.status === 'WAITING') void enablePush(api, vapidPublicKey);
  }

  async function signOut() {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
    await api('/auth/logout', 'POST', { endpoint: subscription?.endpoint });
    location.reload();
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl font-bold">Loo Queue</h1>
        <div className="flex min-w-0 items-center gap-3 text-sm text-slate-600">
          <span className={live ? 'text-emerald-700' : ''}>{live ? 'Live' : live === null ? 'Connecting…' : 'Reconnecting…'}</span>
          <span className="truncate">{email}</span>
          <button type="button" onClick={signOut} className="rounded underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-sky-700">
            Sign out
          </button>
        </div>
      </header>

      <p role="status" className={notice ? 'mt-4 rounded-xl bg-slate-900 px-4 py-3 text-white' : 'sr-only'}>
        {notice}
      </p>

      {!view ? (
        <p className="mt-8 text-slate-600">Loading…</p>
      ) : view.toilets.length === 0 ? (
        <p className="mt-8 text-slate-600">No toilets have been added yet.</p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {view.toilets.map((toilet) => (
            <ToiletCard
              key={toilet.id}
              toilet={toilet}
              card={describe(toilet, mine?.toiletId === toilet.id ? mine : null, !mine, now)}
              busy={busy}
              onAction={(action) => act(toilet, action)}
            />
          ))}
        </ul>
      )}

      {isAdmin && view && <AdminPanel toilets={view.toilets} mutate={mutate} />}

      <p className="mt-10 text-center text-xs text-slate-500">Nobody can see who is inside or who is waiting, only how many.</p>
    </main>
  );
}

/** What a card says and offers, from the caller's point of view. */
function describe(toilet: ToiletView, mine: MyBooking | null, canBook: boolean, now: number): Card {
  const waiting = toilet.waiting > 0 ? `${toilet.waiting} waiting` : null;
  if (mine?.status === 'WAITING') {
    return { tone: 'occupied', headline: `You're #${mine.position} in line`, detail: `About ${mine.estimatedWaitMin} min · ${waiting}`, actions: [['cancel', 'Leave queue']] };
  }
  if (mine?.status === 'NOTIFIED') {
    return { tone: 'attention', headline: "It's your turn", detail: `Held for you for ${countdown(mine.deadline, now)}`, actions: [['claim', "I'm going in"], ['cancel', 'Leave queue']] };
  }
  if (mine?.stillThere) {
    return { tone: 'attention', headline: 'Are you still there?', detail: `Signing you out in ${countdown(mine.deadline, now)}`, actions: [['still-here', "I'm still here"], ['done', "I'm done"]] };
  }
  if (mine) return { tone: 'occupied', headline: "You're in", detail: waiting, actions: [['done', "I'm done"]] };

  const book: Card['actions'] = canBook ? [['book', 'Book']] : [];
  if (toilet.status === 'closed') return { tone: 'closed', headline: 'Closed', detail: null, actions: [] };
  if (toilet.status === 'free') return { tone: 'free', headline: 'Free', detail: canBook ? null : 'Leave your current booking to book this one.', actions: book };
  return { tone: 'occupied', headline: 'Occupied', detail: waiting, actions: book };
}

function ToiletCard({ toilet, card, busy, onAction }: { toilet: ToiletView; card: Card; busy: boolean; onAction: (action: Action) => void }) {
  const titleId = `toilet-${toilet.id}`;
  return (
    <li>
      <article aria-labelledby={titleId} className={`h-full rounded-2xl border-2 p-4 ${TONES[card.tone]}`}>
        <h2 id={titleId} className="font-semibold">
          {toilet.name}
        </h2>
        <p className="mt-1 text-xl font-bold">{card.headline}</p>
        {card.detail && <p className="mt-1 text-sm text-slate-700">{card.detail}</p>}
        {card.actions.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {/* Index keys keep keyboard focus on the same button when its action changes (Book → Leave queue).
                aria-disabled rather than disabled, so focus is not dropped while a request runs. */}
            {card.actions.map(([action, label], i) => (
              <button
                key={i}
                type="button"
                aria-disabled={busy}
                aria-label={`${label}: ${toilet.name}`}
                onClick={() => onAction(action)}
                className={`btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </article>
    </li>
  );
}

function AdminPanel({ toilets, mutate }: { toilets: ToiletView[]; mutate: Mutate }) {
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (await mutate('/api/admin/toilets', 'POST', { name: new FormData(form).get('name') })) form.reset();
  }

  return (
    <details className="mt-10 rounded-2xl border border-slate-300 bg-white p-4">
      <summary className="cursor-pointer rounded font-semibold focus-visible:outline-2 focus-visible:outline-sky-700">Manage toilets</summary>
      <form onSubmit={add} className="mt-4 flex gap-2">
        <label htmlFor="new-toilet" className="sr-only">
          New toilet name
        </label>
        <input id="new-toilet" name="name" required maxLength={80} placeholder="Floor 2 / Toilet C" className="field" />
        <button className="btn btn-secondary">Add</button>
      </form>
      <ul className="mt-4 space-y-3">
        {toilets.map((toilet) => (
          <AdminRow key={toilet.id} toilet={toilet} mutate={mutate} />
        ))}
      </ul>
    </details>
  );
}

function AdminRow({ toilet, mutate }: { toilet: ToiletView; mutate: Mutate }) {
  const closed = toilet.status === 'closed';
  const path = `/api/admin/toilets/${toilet.id}`;

  function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void mutate(path, 'PATCH', { name: new FormData(e.currentTarget).get('name') });
  }

  return (
    <li>
      <form onSubmit={rename} className="flex flex-wrap gap-2">
        <label htmlFor={`rename-${toilet.id}`} className="sr-only">
          Name of {toilet.name}
        </label>
        {/* Uncontrolled, so live updates never clobber typing; the key resets it after a rename. */}
        <input id={`rename-${toilet.id}`} key={toilet.name} name="name" defaultValue={toilet.name} required maxLength={80} className="field basis-full sm:basis-0" />
        <button className="btn btn-secondary">Rename</button>
        <button type="button" onClick={() => mutate(path, 'PATCH', { disabled: !closed })} className="btn btn-secondary">
          {closed ? 'Reopen' : 'Close'}
        </button>
      </form>
    </li>
  );
}

/** Wall-clock time that re-renders every second while `ticking`, for countdowns. */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

function countdown(deadline: string | null, now: number): string {
  const sec = Math.max(0, Math.ceil(((deadline ? Date.parse(deadline) : now) - now) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** Subscribes this device to Web Push and tells the server. Silent if refused or unsupported. */
async function enablePush(api: Api, vapidPublicKey: string | null): Promise<void> {
  if (!vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    if ((await Notification.requestPermission()) !== 'granted') return;
    const { pushManager } = await navigator.serviceWorker.ready;
    const subscription =
      (await pushManager.getSubscription()) ??
      (await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapidPublicKey) }));
    await api('/api/push', 'POST', subscription.toJSON());
  } catch {
    // Push is a convenience; the live view still updates.
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
