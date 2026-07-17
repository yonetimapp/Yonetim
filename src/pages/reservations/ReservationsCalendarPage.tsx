import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type UIEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useRegions } from '@/hooks/useRegions';
import { can, seesAllRegions as seesAllRegionsOf } from '@/lib/rbac';
import { listProperties, type Property } from '@/lib/queries/properties';
import { listAllUnits, type Unit } from '@/lib/queries/units';
import {
  listReservationsInRange,
  updateReservation,
  cancelReservation,
  type ReservationWithRefs,
} from '@/lib/queries/reservations';
import {
  listBlocksInRange,
  deleteBlock,
  type PropertyBlock,
} from '@/lib/queries/property_blocks';
import {
  listNotesInRange,
  type PropertyDateNote,
} from '@/lib/queries/property_date_notes';
import {
  listPricesInRange,
  type NightlyPrice,
} from '@/lib/queries/property_nightly_prices';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ReservationsViewTabs } from './ViewTabs';
import {
  ArrowsLeftRightIcon,
  NoEntryIcon,
  XMarkIcon,
} from '@/components/icons/ActionIcons';
import { CellActionSheet, type CellAction } from './CellActionSheet';
import {
  ReservationActionSheet,
  type ReservationAction,
} from './ReservationActionSheet';
import { RangeActionSheet, type RangeAction } from './RangeActionSheet';
import { BlockDatesModal } from './BlockDatesModal';
import { DateNoteModal } from './DateNoteModal';
import { NightlyPriceModal } from './NightlyPriceModal';
import { MoveReservationModal } from './MoveReservationModal';
import { DayUseMonthCalendar } from './DayUseMonthCalendar';
import { cn, formatDate, formatRoomType, istanbulToday } from '@/lib/utils';
import type { ReservationStatus } from '@/types/database';

// The timeline is ONE freely-scrollable range — no Önceki/Sonraki paging. It
// spans RANGE_START → end of BASE_END_YEAR; the "Sene Ekle" button grows the end
// by a year at a time. The business has no data before May 2026, so that's the
// fixed left edge. The view auto-scrolls to today on open.
const RANGE_START = '2026-05-01';
const BASE_END_YEAR = 2026;
// Roomier layout (Sprint 2): wider cells + taller rows for tactile feel and to
// make room for per-date note/price indicators that land in Tasks 6–7. These
// were 44 / 36 in v1 — bumping them ~30% gives the Airbnb-ish density the
// operator asked for without overflowing a tablet viewport.
const DAY_W = 56; // px per day column
// The sticky unit-name column is fixed-width. 200px is comfortable on a
// tablet/desktop but swallows half a phone viewport, so it collapses below sm.
const LABEL_W_MOBILE = 112;
const LABEL_W_DESKTOP = 200;
const ROW_H = 48; // px per unit row
// Fixed heights so the frozen left name-column and the scrollable timeline align
// row-for-row (box-sizing: border-box → the border-b doesn't add to these).
const HEADER_H = 44; // px — day-header row
const GROUP_H = 32; // px — "Daireler" / "Binalar" section header row
const PROP_H = 36; // px — property band row
const DAY_MS = 24 * 60 * 60 * 1000;
/** Vertical inset for reservation bars so two-line cell content can fit below. */
const BAR_INSET = 6;

const STATUS_BAR: Record<ReservationStatus, string> = {
  pending: 'bg-amber-500 hover:bg-amber-600',
  upcoming: 'bg-sky-500 hover:bg-sky-600',
  active: 'bg-emerald-600 hover:bg-emerald-700',
  completed: 'bg-stone-400 hover:bg-stone-500 dark:bg-stone-600 dark:hover:bg-stone-500',
  cancelled: 'bg-red-400',
};

const STATUS_LABELS: Record<ReservationStatus, string> = {
  pending: 'Beklemede',
  upcoming: 'Yakında',
  active: 'Aktif',
  completed: 'Tamamlandı',
  cancelled: 'İptal',
};

// --- date helpers: work purely in YYYY-MM-DD UTC-day space, matching how
// stay_start / stay_end are stored (UTC midnight). "Today" comes from the
// shared istanbulToday() helper so it never drifts past midnight Istanbul. ---
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayIndex(fromStr: string, toStr: string): number {
  const a = new Date(fromStr + 'T00:00:00Z').getTime();
  const b = new Date(toStr + 'T00:00:00Z').getTime();
  return Math.round((b - a) / DAY_MS);
}
// A stored UTC timestamp → its Europe/Istanbul calendar date ("YYYY-MM-DD").
// Reservations carry an Istanbul-local check-in TIME (defaults to creation
// time), so a stay booked between 00:00–02:59 lands on the PREVIOUS UTC day.
// Slicing the raw UTC ISO therefore placed the bar one column too early — a
// 1-night stay looked like 2. Shifting +3h first yields the true Istanbul day.
// Istanbul is fixed UTC+3, no DST (see CLAUDE.md).
function istanbulDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
// Istanbul wall-clock "HH:MM" from a stored UTC timestamp (fixed +3h). Used to
// label güniçi (day-use) bars, which carry a meaningful giriş/çıkış time.
function istanbulClock(iso: string): string {
  return new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(11, 16);
}

const weekdayFmt = new Intl.DateTimeFormat('tr-TR', { weekday: 'short', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('tr-TR', { month: 'short', timeZone: 'UTC' });
const monthLongFmt = new Intl.DateTimeFormat('tr-TR', { month: 'long', timeZone: 'UTC' });
const yearFmt = new Intl.DateTimeFormat('tr-TR', { year: 'numeric', timeZone: 'UTC' });

/** "YYYY-MM-DD" → "Haziran 2026". Drives the dynamic month label that tracks
 *  the leftmost visible day as the timeline scrolls. */
function monthYearLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${monthLongFmt.format(d)} ${yearFmt.format(d)}`;
}

export function ReservationsCalendarPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  // Last calendar year included in the range; "Sene Ekle" bumps it. The range is
  // always RANGE_START → 31 Dec endYear, rendered as [RANGE_START, endYear+1-01-01).
  const [endYear, setEndYear] = useState(BASE_END_YEAR);
  const rangeEndExclusive = `${endYear + 1}-01-01`;
  const windowDays = useMemo(
    () => dayIndex(RANGE_START, rangeEndExclusive),
    [rangeEndExclusive],
  );
  const lastDay = addDaysStr(RANGE_START, windowDays - 1);
  /** Shown when the user has scrolled to the right end — offers to add a year. */
  const [showAddYear, setShowAddYear] = useState(false);
  /** Month+year of the leftmost visible day — the header label, updated on scroll. */
  const [visibleMonth, setVisibleMonth] = useState(() => monthYearLabel(istanbulToday()));

  // Horizontal-scroll container. On first mount we scroll to today (yesterday at
  // the left edge), so the long past range and future range are both reachable.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const didInitScroll = useRef(false);
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    if (node && !didInitScroll.current) {
      const todayIdx = dayIndex(RANGE_START, istanbulToday());
      node.scrollLeft = Math.max(0, (todayIdx - 1) * DAY_W);
      didInitScroll.current = true;
    }
  }, []);

  // On scroll: reveal "Sene Ekle" at the right edge, and keep the header month
  // label in step with the leftmost visible day (so it reads "Temmuz 2026" once
  // July's first day passes the left edge, and back again when scrolling left).
  const handleTimelineScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setShowAddYear(el.scrollLeft + el.clientWidth >= el.scrollWidth - 8);
    const idx = Math.min(windowDays - 1, Math.max(0, Math.floor(el.scrollLeft / DAY_W)));
    setVisibleMonth(monthYearLabel(addDaysStr(RANGE_START, idx)));
  };
  const [properties, setProperties] = useState<Property[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  // Which region's grid an all-region user is looking at (one at a time — the
  // timeline is a wide fixed-column grid, so merging regions would just make it
  // unreadable). Empty until the region list loads; see the effect below.
  const [regionFilter, setRegionFilter] = useState<string>('');
  const { regions, defaultRegion } = useRegions();
  const [reservations, setReservations] = useState<ReservationWithRefs[]>([]);
  const [blocks, setBlocks] = useState<PropertyBlock[]>([]);
  const [notes, setNotes] = useState<PropertyDateNote[]>([]);
  const [prices, setPrices] = useState<NightlyPrice[]>([]);
  const [loading, setLoading] = useState(true);
  // Whether the one-time properties+units fetch has finished. The "no mülk"
  // empty state is gated on this so it only shows once we KNOW there are none —
  // otherwise it flashes on entry (properties start []) before the grid appears.
  const [propsLoaded, setPropsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Cell-action-sheet state: which cell was clicked, if any. */
  const [pickedCell, setPickedCell] = useState<{
    propertyId: string;
    unitId: string;
    unitName: string;
    dateStr: string;
  } | null>(null);
  /** Whether we're currently showing the Tarihi Blokla modal. */
  const [showBlockModal, setShowBlockModal] = useState(false);
  /** Whether we're currently showing the Tarih Notu modal. */
  const [showNoteModal, setShowNoteModal] = useState(false);
  /** Whether we're currently showing the Gecelik Fiyat modal. */
  const [showPriceModal, setShowPriceModal] = useState(false);
  /** Bumping this re-runs the load effect after a price change (the RPC
      returns a count, not the new rows, so we need to re-fetch). */
  const [priceVersion, setPriceVersion] = useState(0);
  /** Same trick for reservation moves/extends/cancels — bump → reload. */
  const [reservationVersion, setReservationVersion] = useState(0);

  // ---- existing-reservation action sheet (Task 9) ----
  /** Reservation tapped on the calendar — drives ReservationActionSheet. */
  const [pickedReservation, setPickedReservation] = useState<ReservationWithRefs | null>(
    null,
  );
  /** Whether the move-reservation modal is open after picking "Taşı". */
  const [showMoveModal, setShowMoveModal] = useState(false);
  /** Reservation pending an "İptal Et" confirmation. */
  const [resvToCancel, setResvToCancel] = useState<ReservationWithRefs | null>(null);
  const [resvCancelError, setResvCancelError] = useState<string | null>(null);
  const [resvCancelLoading, setResvCancelLoading] = useState(false);
  /** Toast for inline +1/-1 night results — kept lightweight, auto-dismiss. */
  const [actionError, setActionError] = useState<string | null>(null);

  // ---- range-select (Task 9) ----
  /** Mobile-friendly toggle — when on, the next two cell taps form a range. */
  const [rangeMode, setRangeMode] = useState(false);
  /** First cell of an in-progress range select. Cleared on completion / cancel. */
  const [rangeAnchor, setRangeAnchor] = useState<{
    propertyId: string;
    unitId: string;
    unitName: string;
    dateStr: string;
  } | null>(null);
  /** Completed range — drives RangeActionSheet. */
  const [rangePick, setRangePick] = useState<{
    propertyId: string;
    unitId: string;
    unitName: string;
    startDate: string;
    endDate: string;
  } | null>(null);
  /** When 'block' / 'price' fires from RangeActionSheet, the source range
      flows into the corresponding modal as initialEnd / dateEnd. */
  const [rangeBlockPick, setRangeBlockPick] = useState<{
    propertyId: string;
    unitId: string;
    unitName: string;
    startDate: string;
    endDate: string;
  } | null>(null);
  const [rangePricePick, setRangePricePick] = useState<{
    propertyId: string;
    unitId: string;
    unitName: string;
    startDate: string;
    endDate: string;
  } | null>(null);
  /** Block pending delete (the user clicked an existing block bar). */
  const [blockToDelete, setBlockToDelete] = useState<PropertyBlock | null>(null);
  const [blockDeleteError, setBlockDeleteError] = useState<string | null>(null);
  const [blockDeleting, setBlockDeleting] = useState(false);

  // Width of the sticky unit-name column — collapses on phones (see consts).
  const [labelW, setLabelW] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 640
      ? LABEL_W_MOBILE
      : LABEL_W_DESKTOP,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const sync = () => setLabelW(mq.matches ? LABEL_W_DESKTOP : LABEL_W_MOBILE);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const today = istanbulToday();
  const canCreate = Boolean(profile && can(profile.role, 'reservation:create'));
  const seesAllRegions = seesAllRegionsOf(profile);

  // Open on the default region once the region list arrives (all-region users
  // only — everyone else is RLS-scoped and never filters). Guarded on the empty
  // regionFilter so it only ever seeds the initial value, never fights the user.
  useEffect(() => {
    if (seesAllRegions && !regionFilter && defaultRegion) setRegionFilter(defaultRegion);
  }, [seesAllRegions, regionFilter, defaultRegion]);

  // Properties + units load once
  useEffect(() => {
    Promise.all([listProperties(), listAllUnits()])
      .then(([p, u]) => {
        setProperties(p);
        setUnits(u);
      })
      .catch((e) => setError(e?.message ?? 'Yüklenemedi'))
      .finally(() => setPropsLoaded(true));
  }, []);

  // Reservations + blocks + notes + price overrides reload whenever the
  // window shifts. All four render on the same grid; loading them in parallel
  // gives a single visual flash. priceVersion bumps re-fetch after a bulk
  // price write (the RPC returns a count, not the new rows).
  useEffect(() => {
    const startDate = RANGE_START;
    const endDate = rangeEndExclusive;
    const startISO = new Date(startDate + 'T00:00:00Z').toISOString();
    const endISO = new Date(endDate + 'T00:00:00Z').toISOString();
    setLoading(true);
    Promise.all([
      listReservationsInRange(startISO, endISO),
      listBlocksInRange(startISO, endISO),
      listNotesInRange(startDate, endDate),
      listPricesInRange(startDate, endDate),
    ])
      .then(([r, b, n, pr]) => {
        setReservations(r);
        setBlocks(b);
        setNotes(n);
        setPrices(pr);
      })
      .catch((e) => setError(e?.message ?? 'Takvim yüklenemedi'))
      .finally(() => setLoading(false));
  }, [rangeEndExclusive, priceVersion, reservationVersion]);

  const days = useMemo(
    () =>
      Array.from({ length: windowDays }, (_, i) => {
        const dateStr = addDaysStr(RANGE_START, i);
        const d = new Date(dateStr + 'T00:00:00Z');
        const dow = d.getUTCDay();
        return {
          dateStr,
          dayNum: d.getUTCDate(),
          weekday: weekdayFmt.format(d),
          month: monthFmt.format(d),
          isWeekend: dow === 0 || dow === 6,
          isToday: dateStr === today,
          showMonth: d.getUTCDate() === 1 || i === 0,
        };
      }),
    [windowDays, today],
  );

  const unitsByProperty = useMemo(() => {
    const map = new Map<string, Unit[]>();
    for (const u of units) {
      const arr = map.get(u.property_id) ?? [];
      arr.push(u);
      map.set(u.property_id, arr);
    }
    return map;
  }, [units]);

  const reservationsByUnit = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, ReservationWithRefs[]>();
    for (const r of reservations) {
      if (r.status === 'cancelled') continue;
      // Güniçi (day-use) stays show on the Gantt as a one-day bar, but only until
      // their çıkış time passes — after that they drop off here and remain solely
      // in the Güniçi list below. Overnight stays are unaffected (history stays).
      if (r.stay_type === 'DAYUSE' && new Date(r.stay_end).getTime() <= now) continue;
      const arr = map.get(r.unit_id) ?? [];
      arr.push(r);
      map.set(r.unit_id, arr);
    }
    return map;
  }, [reservations]);

  // Stack overlapping stays into vertical lanes so two reservations on the same
  // unit never render on top of each other. Completed stays no longer block new
  // ones (migration 066), so a finished stay can overlap a fresh booking — those
  // go on separate lanes. Every row stays ONE uniform height; a stay shrinks to
  // a fraction of it ONLY where it actually overlaps another (localCount), so a
  // standalone booking stays full height even if the unit overlaps elsewhere.
  const lanesByUnit = useMemo(() => {
    const map = new Map<
      string,
      { lane: Map<string, number>; localCount: Map<string, number> }
    >();
    for (const [unitId, list] of reservationsByUnit) {
      // Every rendered stay takes a lane so overlaps stack. Day-use (giriş =
      // çıkış) collapses to one day → give it a 1-day span so it stacks with any
      // overnight stay sharing that day instead of vanishing.
      const spans = list
        .map((r) => {
          const s = dayIndex(RANGE_START, istanbulDateOf(r.stay_start));
          const e =
            r.stay_type === 'DAYUSE'
              ? s + 1
              : dayIndex(RANGE_START, istanbulDateOf(r.stay_end));
          return { id: r.id, s, e };
        })
        .filter((x) => x.e > x.s)
        .sort((a, b) => a.s - b.s);

      const laneEnd: number[] = []; // exclusive end-index of each lane's last stay
      const lane = new Map<string, number>();
      const placed: { id: string; s: number; e: number; lane: number }[] = [];
      for (const x of spans) {
        let idx = laneEnd.findIndex((end) => x.s >= end);
        if (idx === -1) {
          idx = laneEnd.length;
          laneEnd.push(x.e);
        } else {
          laneEnd[idx] = x.e;
        }
        lane.set(x.id, idx);
        placed.push({ ...x, lane: idx });
      }

      // Local split factor: height = row / (1 + highest lane among the stays a
      // stay overlaps, itself included). Half-open overlap, so back-to-back
      // stays (A çıkış = B giriş) don't count and both stay full height.
      const localCount = new Map<string, number>();
      for (const a of placed) {
        let maxLane = a.lane;
        for (const b of placed) {
          if (b.id !== a.id && a.s < b.e && b.s < a.e && b.lane > maxLane) {
            maxLane = b.lane;
          }
        }
        localCount.set(a.id, maxLane + 1);
      }
      map.set(unitId, { lane, localCount });
    }
    return map;
  }, [reservationsByUnit]);

  // Group properties into "Daireler" (APARTMENT) and "Binalar" (HOTEL) sections,
  // each sorted by name. Empty groups are dropped so a section header only shows
  // when it has properties. Both panes iterate this identically to stay aligned.
  // Properties shown on the grid. An all-region user opens on the default region
  // and switches with the region buttons; one region shows at a time, so another
  // region's mülkler stay OUT of the view rather than widening the grid.
  // Everyone else just sees their RLS-scoped set.
  //
  // The empty regionFilter (list not loaded / load failed) falls through to ALL
  // properties on purpose: showing everything degrades gracefully, whereas
  // filtering on '' would blank the calendar.
  const visibleProperties = useMemo(() => {
    if (!seesAllRegions || !regionFilter) return properties;
    return properties.filter((p) => p.region === regionFilter);
  }, [properties, regionFilter, seesAllRegions]);

  const groups = useMemo(() => {
    // Pin "Daireler" to the top of its section; everything else alphabetical.
    const byName = (a: Property, b: Property) => {
      if (a.name === 'Daireler' && b.name !== 'Daireler') return -1;
      if (b.name === 'Daireler' && a.name !== 'Daireler') return 1;
      return a.name.localeCompare(b.name, 'tr', { numeric: true });
    };
    return [
      {
        key: 'APARTMENT',
        label: 'Daireler',
        items: visibleProperties.filter((p) => p.type === 'APARTMENT').sort(byName),
      },
      {
        key: 'HOTEL',
        label: 'Binalar',
        items: visibleProperties.filter((p) => p.type === 'HOTEL').sort(byName),
      },
    ].filter((g) => g.items.length > 0);
  }, [visibleProperties]);

  const blocksByUnit = useMemo(() => {
    const map = new Map<string, PropertyBlock[]>();
    for (const b of blocks) {
      const arr = map.get(b.unit_id) ?? [];
      arr.push(b);
      map.set(b.unit_id, arr);
    }
    return map;
  }, [blocks]);

  /** Fast (unit_id, date) → note lookup so the cell render is O(1) per cell. */
  const notesByCell = useMemo(() => {
    const map = new Map<string, PropertyDateNote>();
    for (const n of notes) {
      map.set(`${n.unit_id}|${n.note_date}`, n);
    }
    return map;
  }, [notes]);

  /** Fast (unit_id, date) → price-override lookup, same shape as notesByCell. */
  const pricesByCell = useMemo(() => {
    const map = new Map<string, NightlyPrice>();
    for (const p of prices) {
      map.set(`${p.unit_id}|${p.price_date}`, p);
    }
    return map;
  }, [prices]);

  const trackWidth = windowDays * DAY_W;

  const handleCellClick = (
    propertyId: string,
    unitId: string,
    unitName: string,
    dateStr: string,
    e: MouseEvent,
  ) => {
    if (!canCreate) return;
    // Two paths off a cell click:
    //   - Normal click → single-cell action sheet (Yeni rez / Blokla / Not / Fiyat)
    //   - Shift+click OR "Aralık modu" on → range-select. The first such
    //     click sets the anchor; the second on the same unit completes the
    //     range and opens RangeActionSheet for bulk block / price.
    const wantRange = e.shiftKey || rangeMode;
    if (wantRange) {
      if (rangeAnchor && rangeAnchor.unitId === unitId) {
        // Complete the range — normalize so startDate ≤ endDate.
        const a = rangeAnchor.dateStr;
        const b = dateStr;
        const [startDate, endDate] = a <= b ? [a, b] : [b, a];
        setRangePick({
          propertyId,
          unitId,
          unitName,
          startDate,
          endDate,
        });
        setRangeAnchor(null);
        setRangeMode(false);
        return;
      }
      // New anchor (or replacing one from a different unit).
      setRangeAnchor({ propertyId, unitId, unitName, dateStr });
      return;
    }
    setPickedCell({ propertyId, unitId, unitName, dateStr });
  };

  const handleReservationBarClick = (r: ReservationWithRefs) => {
    // Replaces the old "click bar → straight to /reservations/:id". Now opens
    // the action sheet whose "Detayı aç" option does the original nav.
    setPickedReservation(r);
  };

  /** +1 / -1 night via direct updateReservation; the EXCLUDE constraint
      catches collisions and wrapErr surfaces the Turkish message. */
  const shiftStayEnd = async (r: ReservationWithRefs, deltaDays: number) => {
    setActionError(null);
    try {
      const newEnd = new Date(
        new Date(r.stay_end).getTime() + deltaDays * DAY_MS,
      ).toISOString();
      await updateReservation(r.id, { stay_end: newEnd });
      setReservationVersion((v) => v + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'İşlem başarısız');
    }
  };

  const handleReservationActionPick = (action: ReservationAction) => {
    const r = pickedReservation;
    if (!r) return;
    switch (action) {
      case 'detail':
        setPickedReservation(null);
        navigate(`/reservations/${r.id}`);
        return;
      case 'edit':
        setPickedReservation(null);
        navigate(`/reservations/${r.id}/edit`);
        return;
      case 'move':
        // Keep pickedReservation set so MoveReservationModal can read from it.
        setShowMoveModal(true);
        return;
      case 'extend':
        setPickedReservation(null);
        void shiftStayEnd(r, +1);
        return;
      case 'shorten':
        setPickedReservation(null);
        void shiftStayEnd(r, -1);
        return;
      case 'cancel':
        setResvCancelError(null);
        setResvToCancel(r);
        setPickedReservation(null);
        return;
      default:
        return;
    }
  };

  const handleConfirmCancelReservation = async () => {
    if (!resvToCancel) return;
    setResvCancelLoading(true);
    setResvCancelError(null);
    try {
      await cancelReservation(resvToCancel.id);
      setResvToCancel(null);
      setReservationVersion((v) => v + 1);
    } catch (err) {
      setResvCancelError(err instanceof Error ? err.message : 'İptal başarısız');
    } finally {
      setResvCancelLoading(false);
    }
  };

  const handleRangeActionPick = (action: RangeAction) => {
    const range = rangePick;
    if (!range) return;
    setRangePick(null);
    if (action === 'block') {
      setRangeBlockPick(range);
    } else if (action === 'price') {
      setRangePricePick(range);
    }
  };

  const handleActionPick = (action: CellAction) => {
    if (!pickedCell) return;
    switch (action) {
      case 'reservation': {
        const { propertyId, unitId, dateStr } = pickedCell;
        setPickedCell(null);
        navigate(
          `/reservations/new?property=${propertyId}&unit=${unitId}&checkin=${dateStr}&from=/reservations/calendar`,
        );
        return;
      }
      case 'block':
        // Keep pickedCell set so the modal can read unit/date from it.
        setShowBlockModal(true);
        return;
      case 'note':
        setShowNoteModal(true);
        return;
      case 'price':
        setShowPriceModal(true);
        return;
      default:
        return;
    }
  };

  const handleBlockClick = (block: PropertyBlock) => {
    if (!canCreate) return;
    setBlockDeleteError(null);
    setBlockToDelete(block);
  };

  const handleConfirmDeleteBlock = async () => {
    if (!blockToDelete) return;
    setBlockDeleting(true);
    setBlockDeleteError(null);
    try {
      await deleteBlock(blockToDelete.id);
      setBlocks((prev) => prev.filter((b) => b.id !== blockToDelete.id));
      setBlockToDelete(null);
    } catch (e) {
      setBlockDeleteError(e instanceof Error ? e.message : 'Blok silinemedi');
    } finally {
      setBlockDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Rezervasyon Takvimi
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            {formatDate(RANGE_START)} – {formatDate(lastDay)}
          </p>
        </div>
        <ReservationsViewTabs />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {/* Free scroll replaces Önceki/Sonraki paging — "Bugün" just jumps the
              scroll position back to today (yesterday at the left edge). */}
          <Button
            variant="secondary"
            onClick={() => {
              if (scrollRef.current) {
                const todayIdx = dayIndex(RANGE_START, today);
                scrollRef.current.scrollLeft = Math.max(0, (todayIdx - 1) * DAY_W);
              }
            }}
          >
            Bugün
          </Button>
          {canCreate && (
            <Button
              variant={rangeMode ? 'primary' : 'secondary'}
              onClick={() => {
                // Toggle "Aralık modu" — same effect as holding shift, but
                // works on touch where Shift isn't a thing.
                setRangeMode((m) => !m);
                setRangeAnchor(null);
              }}
            >
              {rangeMode ? (
                <>
                  <XMarkIcon className="h-4 w-4" />
                  Aralık modunu kapat
                </>
              ) : (
                <>
                  <ArrowsLeftRightIcon className="h-4 w-4" />
                  Aralık seç
                </>
              )}
            </Button>
          )}
          {/* Region switcher — one button per region, hidden below two (a lone
              'Genel' needs no switcher). */}
          {seesAllRegions &&
            regions.length > 1 &&
            regions.map((r) => (
              <Button
                key={r.id}
                variant={regionFilter === r.name ? 'primary' : 'secondary'}
                onClick={() => setRegionFilter(r.name)}
              >
                {r.name}
              </Button>
            ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600 dark:text-stone-300">
          {(['pending', 'upcoming', 'active', 'completed'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={cn('h-3 w-3 rounded-sm', STATUS_BAR[s].split(' ')[0])} />
              {STATUS_LABELS[s]}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm bg-amber-500" />
            Güniçi
          </span>
        </div>
      </div>

      {/* Range-select status banner — shown while the user is in the middle
          of an aralık seç flow so they know what the next click will do. */}
      {(rangeMode || rangeAnchor) && (
        <Card className="border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40">
          <p className="text-sm text-sky-800 dark:text-sky-300">
            {rangeAnchor ? (
              <>
                Aralık başlangıcı: <strong>{rangeAnchor.unitName}</strong> ·{' '}
                <strong>{rangeAnchor.dateStr}</strong> seçildi. Bitiş hücresine tıkla.
                <button
                  type="button"
                  className="ml-3 underline hover:no-underline"
                  onClick={() => {
                    setRangeAnchor(null);
                    setRangeMode(false);
                  }}
                >
                  vazgeç
                </button>
              </>
            ) : (
              <>
                Aralık modu açık — başlangıç hücresine tıkla, ardından bitişe.
                Tek tıklamayla normal moda dönmek için yukarıdan kapat.
              </>
            )}
          </p>
        </Card>
      )}

      {/* Inline +1/-1 night / extend error toast. */}
      {actionError && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-red-700 dark:text-red-400">{actionError}</p>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-xs text-red-700 underline hover:no-underline dark:text-red-400"
            >
              kapat
            </button>
          </div>
        </Card>
      )}

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!error && propsLoaded && properties.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Henüz mülk eklenmemiş.
          </p>
        </Card>
      )}

      {/* Gantt timeline — scrolls horizontally inside its own container on
          small screens (a contained scroll region, not page-level scroll). */}
      {!error && properties.length > 0 && (
        <Card className="relative p-0">
          {/* Current-month label — tracks the leftmost visible day as you scroll
              so you always see which month/year you're looking at (Haziran 2026
              → Temmuz 2026 as you pass into July, and back when scrolling left). */}
          <div className="border-b border-stone-300 bg-stone-50 px-3 py-2 text-center text-sm font-semibold text-stone-700 dark:border-stone-600 dark:bg-stone-800/40 dark:text-stone-200">
            {visibleMonth}
          </div>
          {/* "Sene Ekle" — appears once scrolled to the right end of the range,
              extends it by a year so scrolling can continue. */}
          {showAddYear && (
            <button
              type="button"
              onClick={() => {
                setEndYear((y) => y + 1);
                setShowAddYear(false);
              }}
              className="absolute right-3 top-16 z-50 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-emerald-700"
            >
              + Sene Ekle
            </button>
          )}
          <div className="flex">
            {/* Frozen left names column — sits in normal flow so it scrolls
                VERTICALLY with the page alongside the timeline. No position:sticky
                (so no repaint flicker) and it's outside the horizontal scroller
                (so left/right scrolling can't drift it up/down). */}
            <div
              className="shrink-0 border-r border-stone-300 dark:border-stone-600"
              style={{ width: labelW }}
            >
              <div
                className="flex items-center border-b border-stone-300 bg-white px-3 text-xs font-medium uppercase text-stone-600 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300"
                style={{ height: HEADER_H }}
              >
                Birim
              </div>
              {groups.map((g) => (
                <Fragment key={`lblg-${g.key}`}>
                  <div
                    className="flex items-center border-b border-stone-300 bg-stone-100 px-3 text-xs font-bold uppercase tracking-wide text-stone-700 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200"
                    style={{ height: GROUP_H }}
                  >
                    {g.label}
                  </div>
                  {g.items.map((p) => {
                    const propUnits = unitsByProperty.get(p.id) ?? [];
                    return (
                      <Fragment key={`lbl-${p.id}`}>
                        <div
                          className="flex items-center border-b border-stone-200 bg-stone-50 px-3 text-sm font-semibold text-stone-800 dark:border-stone-700 dark:bg-stone-800/40 dark:text-stone-200"
                          style={{ height: PROP_H }}
                        >
                          <span className="truncate">{p.name}</span>
                        </div>
                    {propUnits.length === 0 && (
                      <div
                        className="flex items-center border-b border-stone-200 px-3 text-xs italic text-stone-400 dark:border-stone-700 dark:text-stone-500"
                        style={{ height: ROW_H }}
                      >
                        birim yok
                      </div>
                    )}
                    {propUnits.map((u) => (
                      <div
                        key={u.id}
                        className="flex items-center gap-1.5 border-b border-stone-200 px-3 text-sm text-stone-800 dark:border-stone-700 dark:text-stone-200"
                        style={{ height: ROW_H }}
                      >
                        <span className="truncate">{u.name}</span>
                        <span className="shrink-0 rounded bg-stone-200 px-1 py-0.5 text-[10px] font-medium text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                          {formatRoomType(u.room_type)}
                        </span>
                      </div>
                    ))}
                  </Fragment>
                );
              })}
                </Fragment>
              ))}
            </div>

            {/* Timeline pane — horizontal scroll ONLY. */}
            <div
              ref={setScrollNode}
              onScroll={handleTimelineScroll}
              className="min-w-0 flex-1 overflow-x-auto"
            >
              <div style={{ width: trackWidth }}>
              {/* Day header */}
              <div
                className="flex border-b border-stone-300 dark:border-stone-600"
                style={{ height: HEADER_H }}
              >
                {days.map((d) => (
                  <div
                    key={d.dateStr}
                    className={cn(
                      'flex shrink-0 flex-col items-center justify-center border-l border-stone-200 dark:border-stone-700',
                      d.isWeekend && 'bg-stone-100/70 dark:bg-stone-800/50',
                      d.isToday && 'bg-emerald-50 dark:bg-emerald-950/40',
                    )}
                    style={{ width: DAY_W }}
                  >
                    <div className="text-[10px] uppercase leading-tight text-stone-500 dark:text-stone-400">
                      {d.showMonth ? d.month : d.weekday}
                    </div>
                    <div
                      className={cn(
                        'text-sm leading-tight',
                        d.isToday
                          ? 'font-bold text-emerald-700 dark:text-emerald-400'
                          : 'text-stone-700 dark:text-stone-300',
                      )}
                    >
                      {d.dayNum}
                    </div>
                  </div>
                ))}
              </div>

              {/* Body: properties → units, grouped into Daireler / Binalar */}
              {groups.map((g) => (
                <Fragment key={`g-${g.key}`}>
                  <div
                    className="border-b border-stone-300 bg-stone-100 dark:border-stone-600 dark:bg-stone-800"
                    style={{ height: GROUP_H }}
                  />
                  {g.items.map((p) => {
                    const propUnits = unitsByProperty.get(p.id) ?? [];
                    return (
                      <Fragment key={p.id}>
                        <div
                          className="border-b border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-800/40"
                          style={{ height: PROP_H }}
                        />

                    {propUnits.length === 0 && (
                      <div
                        className="border-b border-stone-200 dark:border-stone-700"
                        style={{ height: ROW_H }}
                      />
                    )}

                    {propUnits.map((u) => {
                      const unitRes = reservationsByUnit.get(u.id) ?? [];
                      const unitBlocks = blocksByUnit.get(u.id) ?? [];
                      const unitLanes = lanesByUnit.get(u.id);
                      return (
                        <div
                          key={u.id}
                          className="relative border-b border-stone-200 dark:border-stone-700"
                          style={{ height: ROW_H }}
                        >
                            {/* Clickable day-cell background. Shift-click (or
                                "Aralık modu" on) routes through the same
                                handler — see handleCellClick. */}
                            <div className="absolute inset-0 flex">
                              {days.map((d) => {
                                const isAnchor =
                                  rangeAnchor !== null &&
                                  rangeAnchor.unitId === u.id &&
                                  rangeAnchor.dateStr === d.dateStr;
                                return (
                                  <button
                                    key={d.dateStr}
                                    type="button"
                                    disabled={!canCreate}
                                    onClick={(e) =>
                                      handleCellClick(p.id, u.id, u.name, d.dateStr, e)
                                    }
                                    aria-label={`${u.name} ${d.dateStr} işlemler`}
                                    className={cn(
                                      'shrink-0 border-l border-stone-200 dark:border-stone-700',
                                      d.isWeekend && 'bg-stone-100/60 dark:bg-stone-800/30',
                                      d.isToday && 'bg-emerald-50/70 dark:bg-emerald-950/30',
                                      isAnchor && 'bg-sky-100 ring-2 ring-inset ring-sky-500 dark:bg-sky-900/50',
                                      canCreate && !isAnchor &&
                                        'hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30',
                                      !canCreate && 'cursor-default',
                                    )}
                                    style={{ width: DAY_W }}
                                  />
                                );
                              })}
                            </div>

                            {/* Date-block bars — render below reservations
                                (z-5) so a paying stay overlays cleanly if a
                                block somehow exists (shouldn't, per triggers). */}
                            {unitBlocks.map((b) => {
                              const sIdx = dayIndex(RANGE_START, istanbulDateOf(b.block_start));
                              const eIdx = dayIndex(RANGE_START, istanbulDateOf(b.block_end));
                              const left = Math.max(sIdx, 0);
                              const right = Math.min(eIdx, windowDays);
                              if (right <= left) return null;
                              const clippedLeft = sIdx < 0;
                              const clippedRight = eIdx > windowDays;
                              const padLeft = clippedLeft ? 0 : 2;
                              const padRight = clippedRight ? 0 : 2;
                              return (
                                <button
                                  key={b.id}
                                  type="button"
                                  onClick={() => handleBlockClick(b)}
                                  title={
                                    b.reason
                                      ? `Bloklu — ${b.reason}`
                                      : 'Bloklu (sebep belirtilmemiş)'
                                  }
                                  aria-label="Tarih bloğu"
                                  className={cn(
                                    'absolute z-[5] flex items-center justify-center overflow-hidden text-xs font-semibold text-stone-700 transition-opacity hover:opacity-80 dark:text-stone-200',
                                    clippedLeft ? '' : 'rounded-l',
                                    clippedRight ? '' : 'rounded-r',
                                  )}
                                  style={{
                                    left: left * DAY_W + padLeft,
                                    width: (right - left) * DAY_W - padLeft - padRight,
                                    top: BAR_INSET,
                                    height: ROW_H - BAR_INSET * 2,
                                    backgroundColor: 'rgba(120, 113, 108, 0.25)',
                                    backgroundImage:
                                      'repeating-linear-gradient(45deg, rgba(120,113,108,0.35) 0 6px, transparent 6px 12px)',
                                    border: '1px solid rgba(120, 113, 108, 0.5)',
                                  }}
                                >
                                  <span className="flex items-center justify-center gap-1 truncate px-1.5">
                                    <NoEntryIcon className="h-3 w-3 shrink-0" />
                                    <span className="truncate">Bloklu</span>
                                  </span>
                                </button>
                              );
                            })}

                            {/* Per-date note dots — small amber circle in
                                the top-right of any cell with a note. Sits
                                above bars (z-20) so it's still visible when
                                a reservation covers the date. */}
                            {days.map((d, di) => {
                              const noteRow = notesByCell.get(`${u.id}|${d.dateStr}`);
                              if (!noteRow) return null;
                              return (
                                <span
                                  key={`note-${d.dateStr}`}
                                  className="pointer-events-none absolute z-20 h-2 w-2 rounded-full bg-amber-500 shadow ring-1 ring-white dark:ring-stone-900"
                                  style={{ left: (di + 1) * DAY_W - 8, top: 4 }}
                                  title={noteRow.note}
                                />
                              );
                            })}

                            {/* Per-date price overrides — tiny ₺ label at the
                                bottom of any cell with a custom price. Hidden
                                when a reservation/block bar covers the cell
                                (the bar's z-10 sits above this z-0 label). */}
                            {days.map((d, di) => {
                              const priceRow = pricesByCell.get(`${u.id}|${d.dateStr}`);
                              if (!priceRow) return null;
                              return (
                                <span
                                  key={`price-${d.dateStr}`}
                                  className="pointer-events-none absolute z-[1] truncate text-center text-[10px] font-semibold leading-tight text-emerald-700 dark:text-emerald-400"
                                  style={{
                                    left: di * DAY_W,
                                    width: DAY_W,
                                    bottom: 2,
                                  }}
                                  title={`Özel fiyat: ${priceRow.price} ₺`}
                                >
                                  ₺{Number(priceRow.price).toLocaleString('tr-TR')}
                                </span>
                              );
                            })}

                            {/* Reservation bars — overnight span multiple days;
                                güniçi (day-use) render one cell wide in amber with
                                the çıkış saati (they leave once the çıkış passes). */}
                            {unitRes.map((r) => {
                              const isDayUse = r.stay_type === 'DAYUSE';
                              const sIdx = dayIndex(RANGE_START, istanbulDateOf(r.stay_start));
                              // Day-use collapses to one day (giriş = çıkış) → render
                              // a single-cell bar so it's actually visible.
                              const eIdx = isDayUse
                                ? sIdx + 1
                                : dayIndex(RANGE_START, istanbulDateOf(r.stay_end));
                              const left = Math.max(sIdx, 0);
                              const right = Math.min(eIdx, windowDays);
                              if (right <= left) return null;
                              const clippedLeft = sIdx < 0;
                              const clippedRight = eIdx > windowDays;
                              const padLeft = clippedLeft ? 0 : 2;
                              const padRight = clippedRight ? 0 : 2;
                              // Long stays (≥10 days) get the name repeated at the
                              // right end so it stays visible when the wide bar is
                              // scrolled away from its start.
                              const isLong = eIdx - sIdx >= 10;
                              // Every row is one uniform height; overlapping stays
                              // SPLIT that fixed height into stacked half-height
                              // (or thirds…) lanes instead of growing the row.
                              const laneCount = unitLanes?.localCount.get(r.id) ?? 1;
                              const laneIdx = unitLanes?.lane.get(r.id) ?? 0;
                              const laneH = (ROW_H - BAR_INSET * 2) / laneCount;
                              const laneGap = laneCount > 1 ? 2 : 0;
                              return (
                                <button
                                  key={r.id}
                                  type="button"
                                  onClick={() => handleReservationBarClick(r)}
                                  title={
                                    isDayUse
                                      ? `${r.guest?.full_name ?? '—'} · ${istanbulDateOf(
                                          r.stay_start,
                                        )} · ${istanbulClock(r.stay_start)}–${istanbulClock(
                                          r.stay_end,
                                        )} · Güniçi`
                                      : `${r.guest?.full_name ?? '—'} · ${istanbulDateOf(
                                          r.stay_start,
                                        )} → ${istanbulDateOf(r.stay_end)} · ${STATUS_LABELS[r.status]}`
                                  }
                                  className={cn(
                                    'absolute z-10 flex items-center overflow-hidden px-1.5 text-xs font-medium text-white shadow-sm transition-colors',
                                    isLong && 'justify-between gap-2',
                                    isDayUse
                                      ? 'bg-amber-500 hover:bg-amber-600'
                                      : STATUS_BAR[r.status],
                                    clippedLeft ? '' : 'rounded-l',
                                    clippedRight ? '' : 'rounded-r',
                                  )}
                                  style={{
                                    left: left * DAY_W + padLeft,
                                    width: (right - left) * DAY_W - padLeft - padRight,
                                    top: BAR_INSET + laneIdx * laneH,
                                    height: laneH - laneGap,
                                  }}
                                >
                                  <span className="truncate">
                                    {isDayUse
                                      ? istanbulClock(r.stay_end)
                                      : (r.guest?.full_name ?? '—')}
                                  </span>
                                  {isLong && !isDayUse && (
                                    <span className="truncate">
                                      {r.guest?.full_name ?? '—'}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
                </Fragment>
              ))}
              </div>
            </div>
          </div>
        </Card>
      )}

      {canCreate && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Boş bir güne tıklayarak yeni rezervasyon, blok, not veya fiyat ekleyebilirsiniz.
        </p>
      )}

      {/* Güniçi (gündüz kullanımı) stays show as a one-day amber bar on the
          timeline above while upcoming/ongoing, then drop off once their çıkış
          passes. This month-grid + list keeps their full record (past included). */}
      {!error && (
        <DayUseMonthCalendar
          refreshKey={reservationVersion}
          allowedPropertyIds={
            seesAllRegions ? new Set(visibleProperties.map((p) => p.id)) : null
          }
        />
      )}

      {loading && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {/* Cell action sheet — pops on any empty-cell click. All four actions
          are now live (block / note / price + the original new-reservation). */}
      {pickedCell && !showBlockModal && !showNoteModal && !showPriceModal && (
        <CellActionSheet
          unitName={pickedCell.unitName}
          dateStr={pickedCell.dateStr}
          onPick={handleActionPick}
          onClose={() => setPickedCell(null)}
        />
      )}

      {/* Tarihi Blokla modal — appears after the sheet's 'block' action. */}
      {showBlockModal && pickedCell && (
        <BlockDatesModal
          propertyId={pickedCell.propertyId}
          unitId={pickedCell.unitId}
          unitName={pickedCell.unitName}
          initialStart={pickedCell.dateStr}
          onClose={() => {
            setShowBlockModal(false);
            setPickedCell(null);
          }}
          onCreated={(b) => {
            setBlocks((prev) => [...prev, b]);
            setShowBlockModal(false);
            setPickedCell(null);
          }}
        />
      )}

      {/* Tarih Notu modal — add / edit / delete the note for the picked cell. */}
      {showNoteModal && pickedCell && (
        <DateNoteModal
          propertyId={pickedCell.propertyId}
          unitId={pickedCell.unitId}
          unitName={pickedCell.unitName}
          dateStr={pickedCell.dateStr}
          existing={notesByCell.get(`${pickedCell.unitId}|${pickedCell.dateStr}`) ?? null}
          onClose={() => {
            setShowNoteModal(false);
            setPickedCell(null);
          }}
          onSaved={(n) => {
            setNotes((prev) => {
              // Upsert by id: replace if present, otherwise append. n=null
              // means the note was deleted — drop it from the local cache.
              const key = `${pickedCell.unitId}|${pickedCell.dateStr}`;
              const existing = prev.find(
                (x) => `${x.unit_id}|${x.note_date}` === key,
              );
              if (n === null) {
                return existing ? prev.filter((x) => x.id !== existing.id) : prev;
              }
              if (existing) {
                return prev.map((x) => (x.id === existing.id ? n : x));
              }
              return [...prev, n];
            });
            setShowNoteModal(false);
            setPickedCell(null);
          }}
        />
      )}

      {/* ===== Existing-reservation action sheet (Task 9) ===== */}
      {pickedReservation && !showMoveModal && (() => {
        const r = pickedReservation;
        // Nights = days between stay_start and stay_end. Day-use stays
        // collapse to ≤1 which is fine (Uzat/Kısalt are hidden for them).
        const nights = Math.max(
          1,
          Math.round(
            (new Date(r.stay_end).getTime() - new Date(r.stay_start).getTime()) /
              DAY_MS,
          ),
        );
        return (
          <ReservationActionSheet
            guestName={r.guest?.full_name ?? '—'}
            unitName={r.unit?.name ?? '—'}
            status={r.status}
            stayType={r.stay_type}
            nights={nights}
            canEdit={Boolean(profile && can(profile.role, 'reservation:update'))}
            canCancel={Boolean(profile && can(profile.role, 'reservation:cancel'))}
            onPick={handleReservationActionPick}
            onClose={() => setPickedReservation(null)}
          />
        );
      })()}

      {showMoveModal && pickedReservation && (
        <MoveReservationModal
          reservationId={pickedReservation.id}
          currentStayStart={pickedReservation.stay_start}
          currentStayEnd={pickedReservation.stay_end}
          stayType={pickedReservation.stay_type}
          guestName={pickedReservation.guest?.full_name ?? '—'}
          unitName={pickedReservation.unit?.name ?? '—'}
          onClose={() => {
            setShowMoveModal(false);
            setPickedReservation(null);
          }}
          onMoved={() => {
            setShowMoveModal(false);
            setPickedReservation(null);
            setReservationVersion((v) => v + 1);
          }}
        />
      )}

      <ConfirmDialog
        open={resvToCancel !== null}
        title="Rezervasyon iptal edilsin mi?"
        description={
          resvToCancel ? (
            <>
              <p>
                <strong>{resvToCancel.guest?.full_name ?? '—'}</strong> —{' '}
                {istanbulDateOf(resvToCancel.stay_start)} →{' '}
                {istanbulDateOf(resvToCancel.stay_end)}
              </p>
              <p className="mt-2 text-xs text-stone-600 dark:text-stone-300">
                İptal edilen rezervasyonlar tekrar aktif edilemez.
              </p>
            </>
          ) : null
        }
        confirmLabel="İptal Et"
        destructive
        loading={resvCancelLoading}
        error={resvCancelError}
        onConfirm={handleConfirmCancelReservation}
        onCancel={() => {
          setResvToCancel(null);
          setResvCancelError(null);
        }}
      />

      {/* ===== Range-select action sheet + range-flavored modals (Task 9) ===== */}
      {rangePick && (() => {
        const nights = Math.max(
          1,
          Math.round(
            (new Date(rangePick.endDate + 'T00:00:00Z').getTime() -
              new Date(rangePick.startDate + 'T00:00:00Z').getTime()) /
              DAY_MS,
          ) + 1,
        );
        return (
          <RangeActionSheet
            unitName={rangePick.unitName}
            startDate={rangePick.startDate}
            endDate={rangePick.endDate}
            nights={nights}
            onPick={handleRangeActionPick}
            onClose={() => setRangePick(null)}
          />
        );
      })()}

      {rangeBlockPick && (
        <BlockDatesModal
          propertyId={rangeBlockPick.propertyId}
          unitId={rangeBlockPick.unitId}
          unitName={rangeBlockPick.unitName}
          initialStart={rangeBlockPick.startDate}
          // RangeActionSheet's range is inclusive (start..end), but block_end
          // is exclusive (half-open tstzrange). Bump one day so the operator
          // sees the same end-date they picked.
          initialEnd={addDaysStr(rangeBlockPick.endDate, 1)}
          onClose={() => setRangeBlockPick(null)}
          onCreated={(b) => {
            setBlocks((prev) => [...prev, b]);
            setRangeBlockPick(null);
          }}
        />
      )}

      {rangePricePick && (() => {
        const unit = units.find((u) => u.id === rangePricePick.unitId);
        return (
          <NightlyPriceModal
            propertyId={rangePricePick.propertyId}
            unitId={rangePricePick.unitId}
            unitName={rangePricePick.unitName}
            dateStr={rangePricePick.startDate}
            dateEnd={rangePricePick.endDate}
            existingId={null}
            existingPrice={null}
            unitBasePrice={unit ? Number(unit.base_price) : 0}
            onClose={() => setRangePricePick(null)}
            onSaved={() => {
              setRangePricePick(null);
              setPriceVersion((v) => v + 1);
            }}
          />
        );
      })()}

      {/* Gecelik Fiyat modal — single-day or range price override. The bulk
          RPC returns just a count, so we bump priceVersion to re-fetch. */}
      {showPriceModal && pickedCell && (() => {
        const key = `${pickedCell.unitId}|${pickedCell.dateStr}`;
        const existing = pricesByCell.get(key) ?? null;
        const unit = units.find((u) => u.id === pickedCell.unitId);
        return (
          <NightlyPriceModal
            propertyId={pickedCell.propertyId}
            unitId={pickedCell.unitId}
            unitName={pickedCell.unitName}
            dateStr={pickedCell.dateStr}
            existingId={existing?.id ?? null}
            existingPrice={existing ? Number(existing.price) : null}
            unitBasePrice={unit ? Number(unit.base_price) : 0}
            onClose={() => {
              setShowPriceModal(false);
              setPickedCell(null);
            }}
            onSaved={() => {
              setShowPriceModal(false);
              setPickedCell(null);
              setPriceVersion((v) => v + 1);
            }}
          />
        );
      })()}

      {/* Delete a block by clicking its bar. */}
      <ConfirmDialog
        open={blockToDelete !== null}
        title="Bu blok kaldırılsın mı?"
        description={
          blockToDelete && (
            <>
              <p>
                <strong>
                  {istanbulDateOf(blockToDelete.block_start)} → {istanbulDateOf(blockToDelete.block_end)}
                </strong>
                {blockToDelete.reason ? ` — ${blockToDelete.reason}` : ''}
              </p>
              <p className="mt-2 text-xs text-stone-600 dark:text-stone-300">
                Blok kaldırıldıktan sonra bu tarihler tekrar rezervasyona açılır.
              </p>
            </>
          )
        }
        confirmLabel="Bloğu Kaldır"
        destructive
        loading={blockDeleting}
        error={blockDeleteError}
        onConfirm={handleConfirmDeleteBlock}
        onCancel={() => {
          setBlockToDelete(null);
          setBlockDeleteError(null);
        }}
      />
    </div>
  );
}
