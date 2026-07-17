import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listReservationsInRange,
  type ReservationWithRefs,
} from '@/lib/queries/reservations';
import { Card } from '@/components/ui/Card';
import { loadStaffDirectory } from '@/lib/queries/staff_directory';
import { cn, formatDate, formatDateTime, istanbulToday } from '@/lib/utils';

// --- date helpers in YYYY-MM-DD UTC-day space (stay_* are stored at UTC) ---
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOnOrBefore(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
function addMonths(monthStartStr: string, delta: number): string {
  const d = new Date(monthStartStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10); // day is always 01, so it stays 01
}

// Istanbul (UTC+3, fixed — no DST since 2016) wall-clock from a stored
// timestamptz ISO: shift +3h then slice the relevant part.
function istanbulClock(iso: string): string {
  return new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(11, 16);
}
function istanbulDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// Monday-first to match the Turkish week convention used across the app.
const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const monthYearFmt = new Intl.DateTimeFormat('tr-TR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

interface DayUseMonthCalendarProps {
  /** Bump to force a refetch (e.g. after a reservation edit elsewhere on the page). */
  refreshKey?: number;
  /** When set, only show stays whose mülk id is in this set (region filter). */
  allowedPropertyIds?: Set<string> | null;
}

/**
 * Güniçi (DAYUSE) stays panel. They begin and end on the same day, so they
 * collapse to a zero-width bar on the resource-timeline Gantt and can't be shown
 * there. This panel shows them two ways, switchable via a toggle:
 *   • Takvim — a month grid with a one-line timed chip per stay.
 *   • Liste  — a compact newest-first list with the full time range.
 * Self-contained: it fetches its own month range so it stays decoupled from the
 * Gantt's window and navigation.
 */
export function DayUseMonthCalendar({
  refreshKey = 0,
  allowedPropertyIds = null,
}: DayUseMonthCalendarProps) {
  const navigate = useNavigate();
  const [view, setView] = useState<'calendar' | 'list'>('list');
  const [monthStart, setMonthStart] = useState(() => istanbulToday().slice(0, 7) + '-01');
  const [search, setSearch] = useState('');
  const [stays, setStays] = useState<ReservationWithRefs[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Resolves a reservation's created_by id → staff name for the "Oluşturan" line.
  const [staffMap, setStaffMap] = useState<Map<string, string>>(() => new Map());

  const today = istanbulToday();
  const monthPrefix = monthStart.slice(0, 7);
  // The visible grid is always 6 weeks (42 days) from the Monday on/before the
  // 1st — enough rows for any month layout.
  const gridStart = useMemo(() => mondayOnOrBefore(monthStart), [monthStart]);

  useEffect(() => {
    // Guard against out-of-order resolution: when the month changes faster than
    // a fetch completes, an earlier response must not clobber a later one (and
    // we must not setState after unmount).
    let ignore = false;
    const toISO = (d: string) => new Date(d + 'T00:00:00Z').toISOString();
    // Takvim fetches just the visible 6-week grid; Liste fetches a wide window
    // (≈2 years around now) so the name search spans past + upcoming stays.
    const thisMonth = istanbulToday().slice(0, 7) + '-01';
    const startISO =
      view === 'calendar' ? toISO(gridStart) : toISO(addMonths(thisMonth, -12));
    const endISO =
      view === 'calendar'
        ? toISO(addDaysStr(gridStart, 42))
        : toISO(addMonths(thisMonth, 13));
    setLoading(true);
    setError(null);
    listReservationsInRange(startISO, endISO)
      .then((rs) => {
        if (ignore) return;
        setStays(rs.filter((r) => r.stay_type === 'DAYUSE' && r.status !== 'cancelled'));
      })
      .catch((e) => {
        if (ignore) return;
        setError(e instanceof Error ? e.message : 'Yüklenemedi');
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [view, gridStart, refreshKey]);

  useEffect(() => {
    loadStaffDirectory().then(setStaffMap).catch(() => {});
  }, []);

  // Apply the region filter (by mülk) before any view computes.
  const visibleStays = useMemo(
    () =>
      allowedPropertyIds
        ? stays.filter((r) => r.property_id && allowedPropertyIds.has(r.property_id))
        : stays,
    [stays, allowedPropertyIds],
  );

  // Calendar: bucket stays by their Istanbul calendar day, earliest giriş first.
  const byDay = useMemo(() => {
    const m = new Map<string, ReservationWithRefs[]>();
    for (const r of visibleStays) {
      const day = istanbulDay(r.stay_start);
      const arr = m.get(day) ?? [];
      arr.push(r);
      m.set(day, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => a.stay_start.localeCompare(b.stay_start));
    }
    return m;
  }, [visibleStays]);

  // List: all fetched stays filtered by the name search, newest first.
  const listStays = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('tr');
    return visibleStays
      .filter(
        (r) => !q || (r.guest?.full_name ?? '').toLocaleLowerCase('tr').includes(q),
      )
      .sort((a, b) => b.stay_start.localeCompare(a.stay_start));
  }, [visibleStays, search]);

  const cells = useMemo(
    () =>
      Array.from({ length: 42 }, (_, i) => {
        const dateStr = addDaysStr(gridStart, i);
        return {
          dateStr,
          dayNum: Number(dateStr.slice(8, 10)),
          inMonth: dateStr.slice(0, 7) === monthPrefix,
          isToday: dateStr === today,
        };
      }),
    [gridStart, monthPrefix, today],
  );

  const monthLabel = monthYearFmt.format(new Date(monthStart + 'T00:00:00Z'));
  const navBtn =
    'rounded border border-stone-300 px-2 py-1 text-sm font-medium text-stone-600 hover:bg-stone-200 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-700';

  return (
    <Card className="p-0">
      {/* Header: title + Liste / Takvim toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-300 bg-stone-50 px-3 py-2 dark:border-stone-600 dark:bg-stone-800/40">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-stone-700 dark:text-stone-200">
          Güniçi konaklamalar
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            Güniçi
          </span>
        </span>
        <div className="flex overflow-hidden rounded-md border border-stone-300 text-xs dark:border-stone-600">
          {(['list', 'calendar'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'px-2 py-1 font-medium',
                view === v
                  ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                  : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-700',
              )}
            >
              {v === 'list' ? 'Liste' : 'Takvim'}
            </button>
          ))}
        </div>
      </div>

      {/* Controls: Takvim → prominent month + named nav; Liste → name search. */}
      {view === 'calendar' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-700">
          <span className="text-base font-bold text-stone-800 dark:text-stone-100">
            {monthLabel}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMonthStart((m) => addMonths(m, -1))}
              className={navBtn}
            >
              ‹ Önceki
            </button>
            <button
              type="button"
              onClick={() => setMonthStart(istanbulToday().slice(0, 7) + '-01')}
              className={navBtn}
            >
              Bugün
            </button>
            <button
              type="button"
              onClick={() => setMonthStart((m) => addMonths(m, 1))}
              className={navBtn}
            >
              Sonraki ›
            </button>
          </div>
        </div>
      ) : (
        <div className="border-b border-stone-200 px-3 py-2 dark:border-stone-700">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="İsme göre ara…"
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder-stone-400 focus:border-emerald-500 focus:outline-none dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder-stone-500"
          />
        </div>
      )}

      {error && (
        <p className="px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {view === 'calendar' ? (
        /* min-w keeps each column readable; the grid scrolls horizontally on
           phones and fills the width on tablet/desktop. */
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="grid grid-cols-7 border-b border-stone-200 text-center text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:border-stone-700 dark:text-stone-400">
              {WEEKDAYS.map((w) => (
                <div key={w} className="py-1">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((c) => {
                const chips = byDay.get(c.dateStr) ?? [];
                return (
                  <div
                    key={c.dateStr}
                    className={cn(
                      'min-h-[72px] border-b border-r border-stone-200 p-1 dark:border-stone-700',
                      !c.inMonth && 'bg-stone-50 dark:bg-stone-900/40',
                      c.isToday && 'bg-emerald-50 dark:bg-emerald-950/30',
                    )}
                  >
                    <div className="mb-0.5 flex justify-end">
                      <span
                        className={cn(
                          'text-[11px] leading-none',
                          c.isToday
                            ? 'rounded bg-emerald-600 px-1 py-0.5 font-semibold text-white dark:bg-emerald-500'
                            : c.inMonth
                              ? 'text-stone-600 dark:text-stone-300'
                              : 'text-stone-400 dark:text-stone-600',
                        )}
                      >
                        {c.dayNum}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {chips.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => navigate(`/reservations/${r.id}`)}
                          title={`${r.guest?.full_name ?? ''} · ${r.unit?.name ?? ''} · ${istanbulClock(r.stay_start)}–${istanbulClock(r.stay_end)}`}
                          className="block w-full truncate rounded bg-emerald-100 px-1 py-0.5 text-left text-[10px] leading-tight text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:hover:bg-emerald-900/70"
                        >
                          <span className="font-semibold">{istanbulClock(r.stay_start)}</span>{' '}
                          {r.guest?.full_name ?? '—'}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Liste — compact, newest-first across the ~2-year fetch window (past +
           upcoming, see the effect above), name-searchable. */
        listStays.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-stone-500 dark:text-stone-400">
            {search.trim() ? 'Eşleşen güniçi konaklama bulunamadı.' : 'Güniçi konaklama yok.'}
          </p>
        ) : (
          <ul className="divide-y divide-stone-200 dark:divide-stone-700">
            {listStays.map((r) => {
              const creator = r.created_by ? staffMap.get(r.created_by) : undefined;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/reservations/${r.id}`)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/40"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-stone-800 dark:text-stone-100">
                        {r.guest?.full_name ?? '—'}
                      </span>
                      <span className="block truncate text-xs text-stone-500 dark:text-stone-400">
                        {r.unit?.name ?? '—'}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-stone-400 dark:text-stone-500">
                        Oluşturan: {creator ?? '—'} · {formatDateTime(r.created_at)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm text-stone-700 dark:text-stone-200">
                        {formatDate(r.stay_start)}
                      </span>
                      <span className="block text-xs text-stone-500 dark:text-stone-400">
                        {istanbulClock(r.stay_start)}–{istanbulClock(r.stay_end)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      )}

      {loading && (
        <p className="px-3 py-2 text-xs text-stone-500 dark:text-stone-400">Yükleniyor…</p>
      )}
    </Card>
  );
}
