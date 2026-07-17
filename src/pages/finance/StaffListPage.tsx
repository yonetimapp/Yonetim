import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { listStaff, type StaffProfileWithProperty } from '@/lib/queries/staff';
import { Card } from '@/components/ui/Card';
import { FinanceTabs } from './FinanceTabs';
import { RoleInfoModal } from './RoleInfoModal';
import { formatTRY, formatRole, formatScope } from '@/lib/utils';

// Role is a classification, not a status — single neutral stone palette
// avoids implying that different roles are "better" or "worse".
const ROLE_BADGE = 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200';

// Group ordering: pending signups first (need an admin's attention), then by
// access scope.
const GROUP_ORDER: Record<string, number> = {
  __pending__: 0,
  ALL: 1,
  HOTELS: 2,
  APARTMENTS: 3,
};

// Within each access-scope group, list roles in this order:
// Yönetici → Alt Yönetici → Personel → Temizlik → Resepsiyon → Onay Bekliyor.
const ROLE_ORDER: Record<string, number> = {
  SUPER_ADMIN: 0,
  PROPERTY_MANAGER: 1,
  YETKILI: 2,
  HOUSEKEEPING: 3,
  RECEPTION: 4,
  PENDING: 5,
};

export function StaffListPage() {
  const { profile } = useAuth();
  const [staff, setStaff] = useState<StaffProfileWithProperty[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRoleInfo, setShowRoleInfo] = useState(false);

  useEffect(() => {
    listStaff()
      .then(setStaff)
      .catch((e) => setError(e?.message ?? 'Personel yüklenemedi'));
  }, []);

  // Group by access scope. PENDING signups get their own "Onay Bekleyenler"
  // group up top — their scope is meaningless until an admin promotes them.
  const grouped = useMemo(() => {
    if (!staff) return [];
    const buckets = new Map<
      string,
      { key: string; label: string; items: StaffProfileWithProperty[] }
    >();
    for (const s of staff) {
      const key = s.role === 'PENDING' ? '__pending__' : s.access_scope;
      const label =
        key === '__pending__' ? 'Onay Bekleyenler' : formatScope(s.access_scope);
      const existing = buckets.get(key);
      if (existing) existing.items.push(s);
      else buckets.set(key, { key, label, items: [s] });
    }
    // Sort items inside each bucket by role priority, then by name within
    // the same role — so the visual scan goes top-down by seniority.
    for (const bucket of buckets.values()) {
      bucket.items.sort((a, b) => {
        const ra = ROLE_ORDER[a.role] ?? 9;
        const rb = ROLE_ORDER[b.role] ?? 9;
        if (ra !== rb) return ra - rb;
        return a.full_name.localeCompare(b.full_name, 'tr', { numeric: true });
      });
    }
    return Array.from(buckets.values()).sort(
      (g1, g2) => (GROUP_ORDER[g1.key] ?? 9) - (GROUP_ORDER[g2.key] ?? 9),
    );
  }, [staff]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Personel
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Maaş bilgileri ve verilen avansların kaydı
            {profile?.role === 'SUPER_ADMIN' && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => setShowRoleInfo(true)}
                  className="font-medium text-emerald-600 hover:underline dark:text-emerald-500"
                >
                  Rol Bilgisi
                </button>
              </>
            )}
          </p>
        </div>
        <FinanceTabs />
      </div>

      {showRoleInfo && <RoleInfoModal onClose={() => setShowRoleInfo(false)} />}

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!staff && !error && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {staff && staff.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Henüz personel eklenmemiş.
          </p>
        </Card>
      )}

      {grouped.map((group) => (
        <Fragment key={group.key}>
          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              {group.label}
            </h2>
            <Card className="p-0">
              <ul className="divide-y divide-stone-300 dark:divide-stone-700">
                {group.items.map((s) => (
                  <li key={s.user_id}>
                    <Link
                      to={`/finance/staff/${s.user_id}`}
                      className="flex items-center justify-between gap-4 px-6 py-3 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/50"
                    >
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-stone-900 dark:text-stone-100">
                          {s.full_name}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-medium ${ROLE_BADGE}`}
                          >
                            {formatRole(s.role)}
                          </span>
                          {s.role !== 'PENDING' && (
                            <span className="text-xs text-stone-500 dark:text-stone-400">
                              {s.all_regions ? 'Tüm bölgeler' : s.region}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        {s.salary != null ? (
                          <>
                            <div className="text-xs uppercase tracking-wide text-stone-600 dark:text-stone-300">
                              Maaş
                            </div>
                            <div className="text-base font-semibold text-stone-900 dark:text-stone-100">
                              {formatTRY(Number(s.salary))}
                            </div>
                          </>
                        ) : (
                          <span className="text-xs italic text-stone-500 dark:text-stone-400">
                            maaş tanımsız
                          </span>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        </Fragment>
      ))}
    </div>
  );
}
