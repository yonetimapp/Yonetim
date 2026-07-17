import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  listAuditLog,
  listAuditFacets,
  lookupStaffNames,
  type AuditEntry,
  type AuditFilters,
} from '@/lib/queries/audit';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import { cn, formatDateTime } from '@/lib/utils';

const PAGE_SIZE = 50;

/** Turkish label for the raw `action` code (used in the filter dropdown). */
const ACTION_LABELS: Record<string, string> = {
  GUEST_DECRYPT: 'Misafir bilgisi görüntüleme',
};

const labelOr = (map: Record<string, string>, value: string): string =>
  map[value] ?? value;

/** Read a string field off the JSON metadata, safely. */
function metaString(entry: AuditEntry, key: string): string | null {
  const m = entry.metadata;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const v = (m as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/**
 * Turn an audit row into a plain Turkish sentence describing what happened.
 * This is the whole point of the rewrite — the operator should read a
 * sentence, not decode JSON + raw enum codes.
 */
function eventSentence(entry: AuditEntry): string {
  if (entry.action === 'GUEST_DECRYPT') {
    const name = metaString(entry, 'guest_name');
    return name
      ? `${name} adlı misafirin hassas bilgileri (TC kimlik / pasaport) görüntülendi`
      : 'Bir misafirin hassas bilgileri görüntülendi';
  }
  return labelOr(ACTION_LABELS, entry.action);
}

/** Soft accent colour for the little category dot next to each event. */
function eventAccent(action: string): string {
  return action === 'GUEST_DECRYPT' ? 'bg-amber-500' : 'bg-stone-400';
}

export function AuditLogPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'SUPER_ADMIN';

  // Filters
  const [action, setAction] = useState('');
  const [from, setFrom] = useState(''); // YYYY-MM-DD
  const [to, setTo] = useState(''); // YYYY-MM-DD

  // Page
  const [page, setPage] = useState(0);

  // Data
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staffNames, setStaffNames] = useState<Map<string, string>>(() => new Map());
  const [actionFacets, setActionFacets] = useState<string[]>([]);

  const filters: AuditFilters = useMemo(
    () => ({
      action: action || undefined,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      // Exclusive upper bound: +1 day so picking "to=18.05" includes the 18th.
      to: to
        ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString()
        : undefined,
    }),
    [action, from, to],
  );

  // Reset to first page whenever filters change.
  useEffect(() => {
    setPage(0);
  }, [action, from, to]);

  // Load action facets once.
  useEffect(() => {
    if (!isAdmin) return;
    listAuditFacets()
      .then((f) => setActionFacets(f.actions))
      .catch(() => {
        /* best-effort; failure just leaves the dropdown with only "Tümü" */
      });
  }, [isAdmin]);

  // Load page whenever filters or page change.
  useEffect(() => {
    if (!isAdmin) return;
    setLoadError(null);
    setRows(null);
    listAuditLog(filters, { page, pageSize: PAGE_SIZE })
      .then(async (res) => {
        setRows(res.rows);
        setTotal(res.total);
        const ids = res.rows
          .map((r) => r.user_id)
          .filter((u): u is string => Boolean(u));
        const missing = ids.filter((id) => !staffNames.has(id));
        if (missing.length > 0) {
          try {
            const map = await lookupStaffNames(missing);
            setStaffNames((prev) => {
              const merged = new Map(prev);
              for (const [k, v] of map) merged.set(k, v);
              return merged;
            });
          } catch {
            // Non-fatal: names just stay unresolved.
          }
        }
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Yüklenemedi'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page, isAdmin]);

  if (!isAdmin) {
    return (
      <Card>
        <p className="text-sm text-stone-700 dark:text-stone-300">
          Bu sayfayı görüntülemek için süper admin yetkisi gereklidir.
        </p>
      </Card>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const pageEnd = Math.min(total, (page + 1) * PAGE_SIZE);

  const userName = (entry: AuditEntry): string =>
    entry.user_id ? (staffNames.get(entry.user_id) ?? 'Bilinmeyen kullanıcı') : 'Sistem';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Denetim Kaydı
        </h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Misafir bilgilerine kimlerin baktığının kaydı.
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label="Olay türü"
            name="filter_action"
            value={action}
            onChange={setAction}
            options={[
              { value: '', label: 'Tümü' },
              ...actionFacets.map((a) => ({ value: a, label: labelOr(ACTION_LABELS, a) })),
            ]}
          />
          <DateInput label="Başlangıç" name="filter_from" value={from} onChange={setFrom} />
          <DateInput label="Bitiş" name="filter_to" value={to} onChange={setTo} />
        </div>
      </Card>

      {loadError && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{loadError}</p>
        </Card>
      )}

      {!loadError && rows === null && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {rows && rows.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Bu filtreyle eşleşen kayıt yok.
          </p>
        </Card>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-stone-600 dark:text-stone-300">
              {pageStart}–{pageEnd} / {total} kayıt
            </p>
            <div className="flex items-center gap-2 text-sm">
              <Button
                variant="secondary"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ← Önceki
              </Button>
              <span className="text-stone-600 dark:text-stone-300">
                Sayfa {page + 1} / {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Sonraki →
              </Button>
            </div>
          </div>

          {/* One readable row per audit entry — same layout on all sizes. */}
          <Card className="p-0">
            <ul className="divide-y divide-stone-200 dark:divide-stone-700">
              {rows.map((r) => (
                <li key={r.id} className="flex gap-3 px-4 py-3">
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                      eventAccent(r.action),
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-stone-900 dark:text-stone-100">
                      {eventSentence(r)}
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                      {userName(r)} · {formatDateTime(r.created_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
