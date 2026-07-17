import { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import {
  deleteStaff,
  deleteAdvance,
  getStaff,
  listAdvancesForStaff,
  type StaffAdvance,
  type StaffProfileWithProperty,
} from '@/lib/queries/staff';
import {
  listSalaryPaymentsForStaff,
  type StaffSalaryPayment,
} from '@/lib/queries/staff_salary_payments';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StaffAdvanceModal } from './StaffAdvanceModal';
import { EditSalaryModal } from './EditSalaryModal';
import { PaySalaryModal } from './PaySalaryModal';
import { AssignScopeModal } from './AssignScopeModal';
import { AssignRegionModal } from './AssignRegionModal';
import { EditRoleModal } from './EditRoleModal';
import { formatDate, formatTRY, formatRole, formatScope } from '@/lib/utils';
import { baseRole } from '@/lib/rbac';

const timeFmt = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul',
  timeStyle: 'short',
});
function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

function currentIstanbulYearMonth(): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${y}-${m}`;
}

function monthLabel(yearMonth: string): string {
  // 'YYYY-MM' → 'Mayıs 2026'
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return yearMonth;
  const [y, m] = yearMonth.split('-');
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

export function StaffDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // "← Geri" returns to where the user came from; fall back to the staff list
  // only on a direct/deep-link entry (no in-app history).
  const goBack = () =>
    location.key === 'default' ? navigate('/finance/staff') : navigate(-1);

  const [staff, setStaff] = useState<StaffProfileWithProperty | null>(null);
  const [advances, setAdvances] = useState<StaffAdvance[]>([]);
  const [salaryPayments, setSalaryPayments] = useState<StaffSalaryPayment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [showEditSalary, setShowEditSalary] = useState(false);
  const [showPaySalary, setShowPaySalary] = useState(false);
  const [showAssignScope, setShowAssignScope] = useState(false);
  const [showAssignRegion, setShowAssignRegion] = useState(false);
  const [showEditRole, setShowEditRole] = useState(false);
  /** Delete confirmation modal — SUPER_ADMIN-only (matches delete_staff RPC). */
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Per-avans delete — SUPER_ADMIN-only; removes the avans AND its kasa hareketi. */
  const [advanceToDelete, setAdvanceToDelete] = useState<StaffAdvance | null>(null);
  const [advanceDeleting, setAdvanceDeleting] = useState(false);
  const [advanceDeleteError, setAdvanceDeleteError] = useState<string | null>(null);

  // RLS (staff_profiles_modify) limits salary edits, scope, and role changes
  // to SUPER_ADMIN. The pay_staff_salary RPC server-side accepts SUPER_ADMIN
  // and PROPERTY_MANAGER, so the manual-payment button surfaces for both.
  const canEditSalary = profile?.role === 'SUPER_ADMIN';
  const canAssignScope = profile?.role === 'SUPER_ADMIN';
  const canAssignRegion = profile?.role === 'SUPER_ADMIN';
  const canChangeRole = profile?.role === 'SUPER_ADMIN';
  const canPaySalary =
    baseRole(profile?.role) === 'SUPER_ADMIN' ||
    baseRole(profile?.role) === 'PROPERTY_MANAGER';
  // delete_staff RPC blocks self-delete on the server too, but hiding the
  // button up-front saves the operator the round trip + error toast.
  const canDelete = profile?.role === 'SUPER_ADMIN' && userId !== user?.id;
  // Deleting an avans cascades to its kasa hareketi (cash_transactions delete is
  // SUPER_ADMIN-only, migration 015), so the avans Sil is SUPER_ADMIN-only too.
  const isSuperAdmin = profile?.role === 'SUPER_ADMIN';

  const currentMonth = currentIstanbulYearMonth();

  useEffect(() => {
    if (!userId) return;
    setError(null);
    (async () => {
      try {
        const s = await getStaff(userId);
        if (!s) {
          setError('Personel bulunamadı');
          return;
        }
        setStaff(s);
        const [ads, pays] = await Promise.all([
          listAdvancesForStaff(userId),
          listSalaryPaymentsForStaff(userId),
        ]);
        setAdvances(ads);
        setSalaryPayments(pays);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Yüklenemedi');
      }
    })();
  }, [userId]);

  if (error) {
    return (
      <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        <button
          type="button"
          onClick={goBack}
          className="mt-3 inline-block text-sm text-emerald-600 hover:underline dark:text-emerald-500"
        >
          ← Geri
        </button>
      </Card>
    );
  }

  if (!staff) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  const salary = staff.salary != null ? Number(staff.salary) : null;
  // Outstanding advances = those not yet recovered from a paid salary
  // (settled_at IS NULL, migration 082). The next salary pays maaş − outstanding
  // and settles them, so "Kalan" here equals what the salary will actually pay.
  const outstandingAdvances = advances.reduce(
    (sum, a) => (a.settled_at == null ? sum + Number(a.amount) : sum),
    0,
  );
  const remaining = salary != null ? salary - outstandingAdvances : null;

  // Color the remaining figure: negative = over-advanced (red)
  const remainingClass =
    remaining == null
      ? ''
      : remaining < 0
        ? 'text-red-600 dark:text-red-400'
        : 'text-emerald-600 dark:text-emerald-400';

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={goBack}
        className="inline-block text-sm text-emerald-600 hover:underline dark:text-emerald-500"
      >
        ← Geri
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            {staff.full_name}
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            {formatRole(staff.role)}
            {` · ${formatScope(staff.access_scope)}`}
            {` · Bölge: ${staff.region}${staff.all_regions ? ' (tüm bölgeleri görür)' : ''}`}
            {staff.hire_date ? ` · İşe giriş: ${formatDate(staff.hire_date)}` : ''}
          </p>
          {(canChangeRole || canAssignScope || canAssignRegion) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {canChangeRole && (
                <button
                  type="button"
                  onClick={() => setShowEditRole(true)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                >
                  Rolü Değiştir
                </button>
              )}
              {canAssignScope && (
                <button
                  type="button"
                  onClick={() => setShowAssignScope(true)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                >
                  Çalışma Alanını Değiştir
                </button>
              )}
              {canAssignRegion && (
                <button
                  type="button"
                  onClick={() => setShowAssignRegion(true)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                >
                  Bölgeyi Değiştir
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canPaySalary && (
            <Button onClick={() => setShowPaySalary(true)}>Maaş Öde</Button>
          )}
          <Button variant="secondary" onClick={() => setShowAdvanceModal(true)}>
            + Avans Ver
          </Button>
          {canDelete && (
            <Button
              variant="danger"
              onClick={() => {
                setDeleteError(null);
                setShowDelete(true);
              }}
            >
              Sil
            </Button>
          )}
        </div>
      </div>

      <Card>
        <p className="text-xs uppercase tracking-wide text-stone-600 dark:text-stone-300">
          {monthLabel(currentMonth)}
        </p>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs text-stone-600 dark:text-stone-300">Maaş</p>
              {canEditSalary && (
                <button
                  type="button"
                  onClick={() => setShowEditSalary(true)}
                  className="rounded px-2 py-0.5 text-sm font-medium text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                >
                  Düzenle
                </button>
              )}
            </div>
            <p className="mt-0.5 text-lg font-semibold text-stone-900 dark:text-stone-100">
              {salary != null ? formatTRY(salary) : '—'}
            </p>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              {staff.salary_day != null
                ? `Otomatik ödeme: ayın ${staff.salary_day}'i`
                : 'Otomatik ödeme yok — elle ödenir'}
            </p>
          </div>
          <div>
            <p className="text-xs text-stone-600 dark:text-stone-300">Verilen avans</p>
            <p className="mt-0.5 text-lg font-semibold text-amber-600 dark:text-amber-400">
              {formatTRY(outstandingAdvances)}
            </p>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Maaştan düşülecek
            </p>
          </div>
          <div>
            <p className="text-xs text-stone-600 dark:text-stone-300">Kalan (ödenecek)</p>
            <p className={`mt-0.5 text-lg font-semibold ${remainingClass}`}>
              {remaining != null ? formatTRY(remaining) : '—'}
            </p>
          </div>
        </div>
        {salary == null && (
          <p className="mt-3 text-xs italic text-stone-500 dark:text-stone-400">
            Bu personel için maaş tanımlanmamış. Maaş bilgisi staff_profiles üzerinden eklenmelidir.
          </p>
        )}
      </Card>

      {/* Maaş Ödemeleri — recent payouts from the kasa, AUTO + MANUAL together. */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Maaş Ödemeleri
        </h2>
        {salaryPayments.length === 0 ? (
          <Card>
            <p className="text-center text-sm text-stone-600 dark:text-stone-300">
              Henüz maaş ödemesi kaydı yok.
            </p>
          </Card>
        ) : (
          <Card className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-stone-300 text-xs uppercase text-stone-600 dark:border-stone-700 dark:text-stone-300">
                  <tr>
                    <th className="px-6 py-3 font-medium">Dönem</th>
                    <th className="px-6 py-3 font-medium">Ödendi</th>
                    <th className="px-6 py-3 font-medium">Kaynak</th>
                    <th className="px-6 py-3 text-right font-medium">Tutar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-300 dark:divide-stone-700">
                  {salaryPayments.map((p) => (
                    <tr key={p.id}>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        {monthLabel(p.pay_period.slice(0, 7))}
                      </td>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        <div>{formatDate(p.paid_at)}</div>
                        <div className="text-xs text-stone-600 dark:text-stone-300">
                          {formatTime(p.paid_at)}
                        </div>
                      </td>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        <span
                          className={
                            p.source === 'AUTO'
                              ? 'rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
                              : 'rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-stone-700 dark:bg-stone-700 dark:text-stone-200'
                          }
                        >
                          {p.source === 'AUTO' ? 'Otomatik' : 'Elle'}
                        </span>
                        {p.note && (
                          <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                            {p.note}
                          </p>
                        )}
                      </td>
                      <td className="px-6 py-3 text-right font-semibold text-emerald-700 dark:text-emerald-400">
                        {formatTRY(Number(p.amount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Avans Geçmişi
        </h2>
        {advances.length === 0 ? (
          <Card>
            <p className="text-center text-sm text-stone-600 dark:text-stone-300">
              Henüz avans kaydı yok.
            </p>
          </Card>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="space-y-2 sm:hidden">
              {advances.map((a) => (
                <div
                  key={a.id}
                  className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-stone-600 dark:text-stone-300">
                        {formatDate(a.given_at)} · {formatTime(a.given_at)}
                      </p>
                      <p className="mt-0.5 break-words text-sm text-stone-700 dark:text-stone-300">
                        {a.note || '—'}
                      </p>
                    </div>
                    <p className="shrink-0 font-semibold text-amber-600 dark:text-amber-400">
                      {formatTRY(Number(a.amount))}
                    </p>
                  </div>
                  {isSuperAdmin && (
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setAdvanceDeleteError(null);
                          setAdvanceToDelete(a);
                        }}
                        className="text-xs text-red-600 hover:underline dark:text-red-400"
                      >
                        Sil
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Tablet+ : table */}
            <Card className="hidden p-0 sm:block">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-stone-300 text-xs uppercase text-stone-600 dark:border-stone-700 dark:text-stone-300">
                    <tr>
                      <th className="px-6 py-3 font-medium">Tarih</th>
                      <th className="px-6 py-3 font-medium">Açıklama</th>
                      <th className="px-6 py-3 text-right font-medium">Tutar</th>
                      {isSuperAdmin && <th className="px-6 py-3" aria-label="Sil" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-300 dark:divide-stone-700">
                    {advances.map((a) => (
                      <tr key={a.id}>
                        <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                          <div>{formatDate(a.given_at)}</div>
                          <div className="text-xs text-stone-600 dark:text-stone-300">
                            {formatTime(a.given_at)}
                          </div>
                        </td>
                        <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                          {a.note || '—'}
                        </td>
                        <td className="px-6 py-3 text-right font-semibold text-amber-600 dark:text-amber-400">
                          {formatTRY(Number(a.amount))}
                        </td>
                        {isSuperAdmin && (
                          <td className="px-6 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setAdvanceDeleteError(null);
                                setAdvanceToDelete(a);
                              }}
                              className="text-xs text-red-600 hover:underline dark:text-red-400"
                            >
                              Sil
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </section>

      {showAdvanceModal && user && (
        <StaffAdvanceModal
          staffUserId={staff.user_id}
          createdByUserId={user.id}
          onClose={() => setShowAdvanceModal(false)}
          onCreated={(advance) => {
            setAdvances((prev) => [advance, ...prev]);
            setShowAdvanceModal(false);
          }}
        />
      )}

      {showEditSalary && (
        <EditSalaryModal
          staffUserId={staff.user_id}
          staffName={staff.full_name}
          currentSalary={salary}
          currentSalaryDay={staff.salary_day}
          onClose={() => setShowEditSalary(false)}
          onUpdated={(next) => {
            setStaff((prev) =>
              prev ? { ...prev, salary: next.salary, salary_day: next.salary_day } : prev,
            );
            setShowEditSalary(false);
          }}
        />
      )}

      {showPaySalary && (
        <PaySalaryModal
          staffUserId={staff.user_id}
          staffName={staff.full_name}
          /* Default to the net (maaş − ödenmemiş avans); advances posted to the
             kasa when given, so paying the net keeps the total at the full maaş. */
          defaultSalary={remaining}
          onClose={() => setShowPaySalary(false)}
          onPaid={(payment) => {
            setSalaryPayments((prev) => [payment, ...prev]);
            // The payment settled outstanding advances server-side (migration
            // 082) — refresh so "Verilen avans" / Kalan update immediately.
            listAdvancesForStaff(staff.user_id).then(setAdvances).catch(() => {});
            setShowPaySalary(false);
          }}
        />
      )}

      {showAssignRegion && (
        <AssignRegionModal
          staffUserId={staff.user_id}
          staffName={staff.full_name}
          staffRole={staff.role}
          currentRegion={staff.region}
          currentAllRegions={staff.all_regions}
          onClose={() => setShowAssignRegion(false)}
          onUpdated={(region, allRegions) => {
            setStaff((prev) =>
              prev ? { ...prev, region, all_regions: allRegions } : prev,
            );
            setShowAssignRegion(false);
          }}
        />
      )}

      {showAssignScope && (
        <AssignScopeModal
          staffUserId={staff.user_id}
          staffName={staff.full_name}
          currentScope={staff.access_scope}
          onClose={() => setShowAssignScope(false)}
          onUpdated={(newScope) => {
            setStaff((prev) => (prev ? { ...prev, access_scope: newScope } : prev));
            setShowAssignScope(false);
          }}
        />
      )}

      {showEditRole && (
        <EditRoleModal
          staffUserId={staff.user_id}
          staffName={staff.full_name}
          currentRole={staff.role}
          onClose={() => setShowEditRole(false)}
          onUpdated={(newRole) => {
            // Mirror the migration-131 trigger: Teknik is pinned to all_regions
            // server-side the moment the role lands.
            setStaff((prev) =>
              prev
                ? {
                    ...prev,
                    role: newRole,
                    all_regions:
                      newRole === 'TEKNIK_PERSONEL' ? true : prev.all_regions,
                  }
                : prev,
            );
            setShowEditRole(false);
          }}
        />
      )}

      <ConfirmDialog
        open={showDelete}
        title="Personel silinsin mi?"
        description={
          <>
            <p>
              <strong>{staff.full_name}</strong> personel listesinden
              kaldırılır. Maaş ödemeleri, avanslar ve geçmiş kasa hareketleri
              olduğu gibi kalır.
            </p>
            <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
              Otomatik maaş ödemesi bu personel için bir daha çalışmaz.
            </p>
          </>
        }
        confirmLabel="Sil"
        cancelLabel="Vazgeç"
        destructive
        loading={deleting}
        error={deleteError}
        onConfirm={async () => {
          if (!userId) return;
          setDeleting(true);
          setDeleteError(null);
          try {
            await deleteStaff(userId);
            navigate('/finance/staff', { replace: true });
          } catch (err) {
            setDeleteError(err instanceof Error ? err.message : 'Silinemedi');
            setDeleting(false);
          }
        }}
        onCancel={() => {
          setShowDelete(false);
          setDeleteError(null);
        }}
      />

      <ConfirmDialog
        open={advanceToDelete !== null}
        title="Avans silinsin mi?"
        description={
          advanceToDelete && (
            <>
              <p>
                <strong>{formatTRY(Number(advanceToDelete.amount))}</strong>
                {advanceToDelete.note ? ` — ${advanceToDelete.note}` : ''} avansı silinecek.
              </p>
              <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
                Bağlı kasa hareketi de birlikte silinir; ikisi de Çöp Kutusu'na taşınır.
              </p>
            </>
          )
        }
        confirmLabel="Sil"
        cancelLabel="Vazgeç"
        destructive
        loading={advanceDeleting}
        error={advanceDeleteError}
        onConfirm={async () => {
          if (!advanceToDelete) return;
          setAdvanceDeleting(true);
          setAdvanceDeleteError(null);
          try {
            await deleteAdvance(advanceToDelete.id);
            setAdvances((prev) => prev.filter((x) => x.id !== advanceToDelete.id));
            setAdvanceToDelete(null);
            setAdvanceDeleting(false);
          } catch (err) {
            setAdvanceDeleteError(err instanceof Error ? err.message : 'Silinemedi');
            setAdvanceDeleting(false);
          }
        }}
        onCancel={() => {
          setAdvanceToDelete(null);
          setAdvanceDeleteError(null);
        }}
      />
    </div>
  );
}
