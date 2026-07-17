import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can, canCollectPayment, isTeknikPersonel } from '@/lib/rbac';
import {
  cancelReservation,
  deleteReservation,
  requestReservationDeletion,
  getPendingDeletionRequest,
  getReservation,
  setCariBlocked,
  isOrphanedReservation,
  reservationPropertyLabel,
  reservationUnitLabel,
} from '@/lib/queries/reservations';
import { getProperty, type Property } from '@/lib/queries/properties';
import { getUnit, type Unit } from '@/lib/queries/units';
import {
  listLedgerForReservation,
  deleteLedgerEntry,
  type LedgerEntry,
} from '@/lib/queries/ledger';
import {
  deletePaymentCollection,
  countActivePaymentsForReservation,
} from '@/lib/queries/payments';
import { supabase } from '@/lib/supabase';
import type { Database, ReservationStatus, PaymentMethod } from '@/types/database';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LateCheckoutModal } from './LateCheckoutModal';
import { LedgerEntryModal } from './LedgerEntryModal';
import { PaymentCollectModal } from './PaymentCollectModal';
import { CompanionListModal } from './CompanionListModal';
import { SendWhatsAppModal } from '@/components/SendWhatsAppModal';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { WarningTriangleIcon } from '@/components/icons/WarningTriangleIcon';
import { ClockIcon, PhoneIcon } from '@/components/icons/ActionIcons';
import { ProblematicFlagModal } from '@/pages/guests/ProblematicFlagModal';
import { formatDate, formatTRY, checkoutTimeLabel, tPaymentMethods, toTelHref } from '@/lib/utils';
import { exportRowsToCsv } from '@/lib/csvExport';
import { resolveKatalogLink } from '@/lib/gallery';

type Reservation = Database['public']['Tables']['reservations']['Row'];

const STATUS_LABELS: Record<ReservationStatus, string> = {
  pending: 'Beklemede',
  upcoming: 'Yakında',
  active: 'Aktif',
  completed: 'Tamamlandı',
  cancelled: 'İptal',
};

const timeFmt = new Intl.DateTimeFormat('tr-TR', { timeStyle: 'short' });
function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function ReservationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { profile, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // "← Geri" returns to wherever the user came from (Takvim, Liste, Müsaitlik, a
  // notification link…) rather than always dumping them on the list.
  // location.key === 'default' means they landed here directly (deep link /
  // refresh) with no in-app history → fall back to the reservations list.
  const goBack = () =>
    location.key === 'default' ? navigate('/reservations') : navigate(-1);

  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [property, setProperty] = useState<Property | null>(null);
  const [unit, setUnit] = useState<Unit | null>(null);
  const [guestName, setGuestName] = useState<string>('');
  const [guestPhone, setGuestPhone] = useState<string | null>(null);
  /** Persistent guest warning state — drives the inline triangle button. */
  const [guestIsProblematic, setGuestIsProblematic] = useState(false);
  const [guestProblematicNote, setGuestProblematicNote] = useState<string | null>(null);
  const [showWhatsApp, setShowWhatsApp] = useState(false);
  const [showProblematicModal, setShowProblematicModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Deletion approval (migration 090): non-admins file a request a SUPER_ADMIN
  // resolves in Onaylar. `deletionPending` drives the "onay bekliyor" badge.
  const [requesting, setRequesting] = useState(false);
  const [deletionPending, setDeletionPending] = useState(false);

  // Cari hesap (ledger) — gated to finance:read
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [showLedgerModal, setShowLedgerModal] = useState(false);
  // Bumping this re-runs the ledger fetch (used after a successful payment collection)
  const [ledgerVersion, setLedgerVersion] = useState(0);

  // Payment collection — gated to payment:collect via type-conditional canCollectPayment()
  const [showCollectModal, setShowCollectModal] = useState(false);
  /** Count of UNCONFIRMED + CONFIRMED payments for this reservation. Drives
      the "Zaten ödeme toplanıldı" confirmation before a second Ödeme Topla. */
  const [activePaymentsCount, setActivePaymentsCount] = useState(0);
  const [showDoubleCollectConfirm, setShowDoubleCollectConfirm] = useState(false);
  /** Geç Çıkış picker — sets reservations.late_checkout_hours (0..4). */
  const [showLateCheckout, setShowLateCheckout] = useState(false);
  /** Ek Misafir list — read-mostly inline view of the guest's companions. */
  const [showCompanions, setShowCompanions] = useState(false);
  /** Cari hesap lock (SUPER_ADMIN only). */
  const [blocking, setBlocking] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  // Per-row ledger deletion (SUPER_ADMIN only — see migration 017)
  const [entryToDelete, setEntryToDelete] = useState<LedgerEntry | null>(null);
  const [entryDeleteError, setEntryDeleteError] = useState<string | null>(null);
  const [entryDeleting, setEntryDeleting] = useState(false);

  const canSeeLedger = Boolean(profile && can(profile.role, 'finance:read'));
  const canWriteLedger = Boolean(profile && can(profile.role, 'finance:write'));
  const canDeleteLedger = profile?.role === 'SUPER_ADMIN';

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const r = await getReservation(id);
        if (!r) {
          setError('Rezervasyon bulunamadı');
          return;
        }
        // An orphaned reservation (deleted mülk) has null property_id/unit_id —
        // skip those lookups (a null uuid filter would error) and fall back to
        // the snapshotted names.
        const [p, u, g] = await Promise.all([
          r.property_id ? getProperty(r.property_id) : Promise.resolve(null),
          r.unit_id ? getUnit(r.unit_id) : Promise.resolve(null),
          supabase
            .from('guests')
            .select('full_name, phone, is_problematic, problematic_note')
            .eq('id', r.guest_id)
            .maybeSingle(),
        ]);
        // Set reservation + property + unit together (one batched render) so the
        // page paints complete. Setting reservation first made the layout render
        // without property-dependent buttons (e.g. Ödeme Topla), which then
        // popped in a beat later — the flash on entry.
        setReservation(r);
        setProperty(p);
        setUnit(u);
        // Best-effort: surface an existing pending deletion request as a badge.
        getPendingDeletionRequest(id)
          .then((req) => setDeletionPending(Boolean(req)))
          .catch(() => {});
        setGuestName(g.data?.full_name ?? '');
        setGuestPhone(g.data?.phone ?? null);
        setGuestIsProblematic(g.data?.is_problematic ?? false);
        setGuestProblematicNote(g.data?.problematic_note ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Yüklenemedi');
      }
    })();
  }, [id]);

  // Load the per-reservation ledger only if the user is permitted to see it.
  // ledgerVersion bumps re-run this effect (after a payment is collected, etc.)
  useEffect(() => {
    const rid = reservation?.id;
    if (!rid || !canSeeLedger) {
      setLedger(null);
      return;
    }
    setLedgerError(null);
    listLedgerForReservation(rid)
      .then(setLedger)
      .catch((e) => setLedgerError(e?.message ?? 'Cari yüklenemedi'));
  }, [reservation?.id, canSeeLedger, ledgerVersion]);

  // Track active (UNCONFIRMED + CONFIRMED) payment count so Ödeme Topla can
  // warn before a second collection. Bumps on ledgerVersion change so the
  // count refreshes after the user collects.
  useEffect(() => {
    const rid = reservation?.id;
    if (!rid) {
      setActivePaymentsCount(0);
      return;
    }
    countActivePaymentsForReservation(rid)
      .then(setActivePaymentsCount)
      .catch(() => setActivePaymentsCount(0));
  }, [reservation?.id, ledgerVersion]);

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

  if (!reservation) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  const canEdit = profile && can(profile.role, 'reservation:update');
  const canCancel = profile && can(profile.role, 'reservation:cancel');
  const canDelete = profile && can(profile.role, 'reservation:delete');
  // SUPER_ADMIN deletes outright; everyone else's delete becomes a request that
  // a SUPER_ADMIN approves/denies in Onaylar (migration 090).
  const isSuperAdmin = profile?.role === 'SUPER_ADMIN';
  /** Can flip the persistent guest warning flag. */
  const canEditGuest = Boolean(profile && can(profile.role, 'guest:update'));
  // Teknik Personel has no finance access — hide reservation pricing (tutar/kapora).
  const isTeknik = isTeknikPersonel(profile?.role);
  // Ödeme Topla — type-conditional: HOTEL=reception, APARTMENT=housekeeping; manager+admin everywhere.
  const canCollect = Boolean(
    profile && property && canCollectPayment(profile.role, property.type),
  );
  const isCancelled = reservation.status === 'cancelled';
  // Cari hesap lock — only Yönetici (SUPER_ADMIN) can toggle it.
  const isBlocked = reservation.cari_blocked;
  const canBlockCari = profile?.role === 'SUPER_ADMIN';

  const handleToggleBlock = async () => {
    setBlockError(null);
    // Locking needs a settled (zero) balance — the RPC re-checks server-side;
    // this is the friendly upfront guard / warning.
    if (!isBlocked) {
      const bal = (ledger ?? []).reduce(
        (s, e) =>
          e.type === 'DEBT'
            ? s + Number(e.amount)
            : e.type === 'PAYMENT'
              ? s - Number(e.amount)
              : s,
        0,
      );
      if (Math.abs(bal) > 0.005) {
        setBlockError('Cari hesap bakiyesi sıfır olmadan hesap kilitlenemez.');
        return;
      }
    }
    setBlocking(true);
    try {
      await setCariBlocked(reservation.id, !isBlocked);
      setReservation({ ...reservation, cari_blocked: !isBlocked });
    } catch (e) {
      setBlockError(e instanceof Error ? e.message : 'İşlem başarısız');
    } finally {
      setBlocking(false);
    }
  };

  const handleCancel = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await cancelReservation(id);
      const r = await getReservation(id);
      setReservation(r);
      setConfirmCancel(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'İptal başarısız');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteReservation(id);
      navigate('/reservations', { replace: true });
    } catch (e) {
      // Keep the dialog open and show the reason inside it
      setDeleteError(e instanceof Error ? e.message : 'Silme başarısız');
      setDeleting(false);
    }
  };

  // Non-admin path: file a deletion request (stays on the page; the reservation
  // is untouched until a SUPER_ADMIN approves it in Onaylar).
  const handleRequestDeletion = async () => {
    if (!id) return;
    setRequesting(true);
    setDeleteError(null);
    try {
      await requestReservationDeletion(id);
      setDeletionPending(true);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Talep gönderilemedi');
    } finally {
      setRequesting(false);
    }
  };

  const handleDeleteEntry = async () => {
    if (!entryToDelete) return;
    setEntryDeleting(true);
    setEntryDeleteError(null);
    try {
      if (entryToDelete.payment_collection_id) {
        // Cascade path: deleting the payment_collection removes the matching
        // cash_transactions row AND this ledger entry in one shot
        // (FK ON DELETE CASCADE — migration 016).
        await deletePaymentCollection(entryToDelete.payment_collection_id);
      } else {
        // Manual ledger entry OR auto-debit row OR legacy unlinked payment —
        // delete just this row.
        await deleteLedgerEntry(entryToDelete.id);
      }
      setLedger((prev) => prev?.filter((e) => e.id !== entryToDelete.id) ?? prev);
      setEntryToDelete(null);
      setEntryDeleting(false);
    } catch (e) {
      setEntryDeleteError(e instanceof Error ? e.message : 'Silme başarısız');
      setEntryDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={goBack}
        className="inline-block text-sm text-emerald-600 hover:underline dark:text-emerald-500"
      >
        ← Geri
      </button>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold text-stone-900 dark:text-stone-100">
              {guestName || '—'}
            </h1>
            {/* Sorunlu Misafir — persistent warning flag (migration 043).
                Text pill: amber when flagged, dashed outline "işaretle"
                affordance otherwise. Both states open the same modal. */}
            {(guestIsProblematic || canEditGuest) && (
              <button
                type="button"
                onClick={canEditGuest ? () => setShowProblematicModal(true) : undefined}
                disabled={!canEditGuest}
                title={
                  guestIsProblematic && guestProblematicNote
                    ? `Sorunlu Misafir — ${guestProblematicNote}`
                    : guestIsProblematic
                      ? 'Sorunlu Misafir'
                      : 'Sorunlu misafir olarak işaretle'
                }
                className={
                  guestIsProblematic
                    ? 'shrink-0 rounded-md bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 transition-colors hover:bg-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-default disabled:hover:bg-red-100 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/60'
                    : 'shrink-0 rounded-md border border-dashed border-red-300 px-2.5 py-0.5 text-xs font-medium text-red-600 transition-colors hover:border-red-400 hover:bg-red-50 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:border-red-800 dark:text-red-400 dark:hover:border-red-700 dark:hover:bg-red-950/40'
                }
              >
                {guestIsProblematic ? 'Sorunlu Misafir' : '+ Sorunlu işaretle'}
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            {reservationPropertyLabel({
              property,
              deleted_property_name: reservation.deleted_property_name,
            })}{' '}
            ·{' '}
            {reservationUnitLabel({
              unit,
              deleted_unit_name: reservation.deleted_unit_name,
            })}
          </p>
          {/* The mülk this reservation belonged to was deleted ("bağı kopar").
              The financial record is preserved but no longer tied to a mülk. */}
          {isOrphanedReservation(reservation) && (
            <p className="mt-1 flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
              <WarningTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">
                {`Bu rezervasyon silinmiş olan ${reservation.deleted_property_name}’e aittir. Kayıt geçmiş için korunuyor.`}
              </span>
            </p>
          )}
          {/* Surface the warning note inline so housekeeping doesn't have to
              click the pill to read it. */}
          {guestIsProblematic && guestProblematicNote && (
            <p className="mt-1 flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400">
              <WarningTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{guestProblematicNote}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canCollect && !isCancelled && !isBlocked && (
            <Button
              size="sm"
              onClick={() => {
                // If the reservation already has at least one UNCONFIRMED or
                // CONFIRMED payment, warn before opening the modal — the
                // operator might be repeating themselves.
                if (activePaymentsCount > 0) {
                  setShowDoubleCollectConfirm(true);
                } else {
                  setShowCollectModal(true);
                }
              }}
            >
              Ödeme Topla
            </Button>
          )}
          {canEdit && !isCancelled && reservation.stay_type !== 'DAYUSE' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowLateCheckout(true)}
            >
              Geç Çıkış: {checkoutTimeLabel(reservation.late_checkout_hours)}
            </Button>
          )}
          {canEdit && !isCancelled && (
            <Link to={`/reservations/${reservation.id}/edit`}>
              <Button variant="secondary" size="sm">
                Düzenle
              </Button>
            </Link>
          )}
          {canCancel && !isCancelled && (
            <Button
              variant="danger"
              size="sm"
              className="border border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:text-red-400 dark:hover:bg-red-900"
              onClick={() => setConfirmCancel(true)}
            >
              İptal Et
            </Button>
          )}
          {canDelete && (isSuperAdmin || !deletionPending) && (
            <Button
              variant="danger"
              size="sm"
              loading={!isSuperAdmin && requesting}
              onClick={() => {
                setDeleteError(null);
                // SUPER_ADMIN confirms a real delete; everyone else files the
                // request straight away (no confirm step).
                if (isSuperAdmin) setConfirmDelete(true);
                else handleRequestDeletion();
              }}
            >
              Sil
            </Button>
          )}
          {deletionPending && (
            <span className="inline-flex items-center rounded-md bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              Silme talebi onay bekliyor
            </span>
          )}
          {!isSuperAdmin && deleteError && (
            <p className="w-full text-sm text-red-600 dark:text-red-400">{deleteError}</p>
          )}
        </div>
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {reservation.stay_type === 'DAYUSE' ? (
            <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              <ClockIcon className="h-3.5 w-3.5" />
              Güniçi konaklama
            </p>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {guestPhone && (
              <a href={toTelHref(guestPhone)}>
                <Button variant="secondary" size="sm">
                  <PhoneIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
                  Ara
                </Button>
              </a>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowCompanions(true)}
            >
              Ek Misafir
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowWhatsApp(true)}
            >
              <WhatsAppIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
              WhatsApp
            </Button>
          </div>
        </div>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <Field
            label="Giriş"
            value={
              reservation.stay_type === 'DAYUSE'
                ? `${formatDate(reservation.stay_start)} · ${formatTime(reservation.stay_start)}`
                : formatDate(reservation.stay_start)
            }
          />
          <Field
            label="Çıkış"
            value={
              reservation.stay_type === 'DAYUSE'
                ? `${formatDate(reservation.stay_end)} · ${formatTime(reservation.stay_end)}`
                : formatDate(reservation.stay_end)
            }
          />
          {!isTeknik && (
            <>
              <Field label="Toplam Tutar" value={formatTRY(Number(reservation.total_amount))} />
              <Field label="Kapora" value={formatTRY(Number(reservation.deposit))} />
            </>
          )}
          <Field
            label="Otomatik Borçlandır"
            value={reservation.auto_debit ? 'Evet' : 'Hayır'}
          />
          <Field label="Durum" value={STATUS_LABELS[reservation.status]} />
        </dl>
        {reservation.note && (
          <div className="mt-4 border-t border-stone-200 pt-3 dark:border-stone-700">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Not
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-stone-800 dark:text-stone-200">
              {reservation.note}
            </p>
          </div>
        )}
      </Card>

      {canSeeLedger && (
        <LedgerSection
          ledger={ledger}
          error={ledgerError}
          canWrite={canWriteLedger}
          canDelete={canDeleteLedger}
          guestName={guestName}
          stayStart={reservation.stay_start}
          isBlocked={isBlocked}
          canBlock={canBlockCari}
          blocking={blocking}
          blockError={blockError}
          onToggleBlock={handleToggleBlock}
          onAddClick={() => setShowLedgerModal(true)}
          onDeleteClick={(entry) => {
            setEntryDeleteError(null);
            setEntryToDelete(entry);
          }}
        />
      )}

      {showLedgerModal && user && (
        <LedgerEntryModal
          guestId={reservation.guest_id}
          reservationId={reservation.id}
          createdByUserId={user.id}
          onClose={() => setShowLedgerModal(false)}
          onCreated={(entry) => {
            setLedger((prev) => (prev ? [entry, ...prev] : [entry]));
            setShowLedgerModal(false);
          }}
        />
      )}

      {showCollectModal && (
        <PaymentCollectModal
          reservationId={reservation.id}
          defaultAmount={Number(reservation.total_amount)}
          onClose={() => setShowCollectModal(false)}
          onCollected={() => {
            setShowCollectModal(false);
            // Re-fetch the ledger so the new PAYMENT entry appears
            setLedgerVersion((v) => v + 1);
          }}
        />
      )}

      <ConfirmDialog
        open={showDoubleCollectConfirm}
        title="Zaten ödeme toplanıldı"
        description="Bu rezervasyon için daha önce ödeme toplandı. Tekrar yapmak istediğinize emin misiniz?"
        confirmLabel="Evet, yine de topla"
        cancelLabel="Vazgeç"
        destructive
        onConfirm={() => {
          setShowDoubleCollectConfirm(false);
          setShowCollectModal(true);
        }}
        onCancel={() => setShowDoubleCollectConfirm(false)}
      />

      {showLateCheckout && (
        <LateCheckoutModal
          reservationId={reservation.id}
          current={reservation.late_checkout_hours ?? 0}
          onClose={() => setShowLateCheckout(false)}
          onUpdated={(next) => {
            setReservation((prev) =>
              prev ? { ...prev, late_checkout_hours: next } : prev,
            );
            setShowLateCheckout(false);
          }}
        />
      )}

      {showCompanions && (
        <CompanionListModal
          guestId={reservation.guest_id}
          guestName={guestName}
          canEdit={canEditGuest}
          onClose={() => setShowCompanions(false)}
        />
      )}

      <ConfirmDialog
        open={confirmCancel}
        title="Rezervasyon iptal edilsin mi?"
        description="İptal edilen rezervasyonlar tekrar aktif edilemez."
        confirmLabel="İptal Et"
        destructive
        loading={busy}
        onConfirm={handleCancel}
        onCancel={() => setConfirmCancel(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`"${guestName || 'Rezervasyon'}" kaydı silinsin mi?`}
        description={
          <>
            <p>Rezervasyon Çöp Kutusu'na taşınır ve oradan geri yüklenebilir.</p>
            <p className="mt-2">
              Rezervasyonu iptal statüsünde tutmak istiyorsanız bunun yerine “İptal Et” seçeneğini kullanın.
            </p>
          </>
        }
        confirmLabel="Sil"
        destructive
        loading={deleting}
        error={deleteError}
        onConfirm={handleDelete}
        onCancel={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      />

      {showProblematicModal && (
        <ProblematicFlagModal
          guestId={reservation.guest_id}
          guestName={guestName || 'Misafir'}
          initialIsProblematic={guestIsProblematic}
          initialNote={guestProblematicNote}
          onClose={() => setShowProblematicModal(false)}
          onSaved={({ isProblematic, note }) => {
            setGuestIsProblematic(isProblematic);
            setGuestProblematicNote(note);
            setShowProblematicModal(false);
          }}
        />
      )}

      {showWhatsApp && (
        <SendWhatsAppModal
          recipientName={guestName || 'Misafir'}
          recipientPhone={guestPhone}
          variables={{
            misafir_adi: guestName,
            giris_tarihi: formatDate(reservation.stay_start),
            cikis_tarihi: formatDate(reservation.stay_end),
            gece_sayisi: String(
              Math.max(
                1,
                Math.round(
                  (new Date(reservation.stay_end).getTime() -
                    new Date(reservation.stay_start).getTime()) /
                    (24 * 60 * 60 * 1000),
                ),
              ),
            ),
            toplam_tutar: formatTRY(Number(reservation.total_amount)),
            mulk_adi: property?.name ?? '',
            birim_adi: unit?.name ?? '',
            katalog_link: resolveKatalogLink(unit),
          }}
          onClose={() => setShowWhatsApp(false)}
        />
      )}

      <ConfirmDialog
        open={entryToDelete !== null}
        title="Cari hareketi silinsin mi?"
        description={
          entryToDelete && (
            <>
              <p>
                <strong>
                  {entryToDelete.type === 'DEBT' ? '+' : '−'}
                  {formatTRY(Number(entryToDelete.amount))}
                </strong>
                {entryToDelete.note ? ` — ${tPaymentMethods(entryToDelete.note)}` : ''}
              </p>
              <p className="mt-2">Kayıt Çöp Kutusu'na taşınır ve oradan geri yüklenebilir. Bakiye yeniden hesaplanır.</p>
              {entryToDelete.payment_collection_id && (
                <div className="mt-3 rounded border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-700 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200">
                  <p>
                    <strong>Not:</strong> Bu kayıt bir tahsilatla bağlantılı.
                    Silindiğinde bağlı{' '}
                    <strong>tahsilat kaydı ve kasa hareketi</strong> de
                    otomatik olarak silinir.
                  </p>
                </div>
              )}
            </>
          )
        }
        confirmLabel="Sil"
        destructive
        loading={entryDeleting}
        error={entryDeleteError}
        onConfirm={handleDeleteEntry}
        onCancel={() => {
          setEntryToDelete(null);
          setEntryDeleteError(null);
        }}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-stone-600 dark:text-stone-300">
        {label}
      </dt>
      <dd className="mt-1 text-stone-900 dark:text-stone-100">{value || '—'}</dd>
    </div>
  );
}

interface LedgerSectionProps {
  ledger: LedgerEntry[] | null;
  error: string | null;
  canWrite: boolean;
  canDelete: boolean;
  /** Used to build the CSV download filename. */
  guestName: string;
  stayStart: string;
  /** Cari hesap lock state + controls (SUPER_ADMIN only). */
  isBlocked: boolean;
  canBlock: boolean;
  blocking: boolean;
  blockError: string | null;
  onToggleBlock: () => void;
  onAddClick: () => void;
  onDeleteClick: (entry: LedgerEntry) => void;
}

function LedgerSection({
  ledger,
  error,
  canWrite,
  canDelete,
  guestName,
  stayStart,
  isBlocked,
  canBlock,
  blocking,
  blockError,
  onToggleBlock,
  onAddClick,
  onDeleteClick,
}: LedgerSectionProps) {
  const entries = ledger ?? [];
  // Split the two totals so the user can verify the math by sight,
  // instead of trusting a single signed number.
  const totalDebt = entries.reduce(
    (s, e) => (e.type === 'DEBT' ? s + Number(e.amount) : s),
    0,
  );
  const totalPayment = entries.reduce(
    (s, e) => (e.type === 'PAYMENT' ? s + Number(e.amount) : s),
    0,
  );
  const balance = totalDebt - totalPayment;

  // Color the balance by who is "in the red":
  //   positive  → guest owes us       (amber)
  //   negative  → guest has credit    (indigo)
  //   zero      → settled             (emerald)
  const balanceColor =
    balance > 0
      ? 'text-amber-600 dark:text-amber-400'
      : balance < 0
        ? 'text-indigo-600 dark:text-indigo-400'
        : 'text-emerald-600 dark:text-emerald-400';
  // Sign meaning:
  //   positive → guest owes us (we collect)         → "Misafir borçlu"
  //   negative → guest has paid (full / over)       → "Misafirden Alındı"
  //   zero     → settled                            → "Hesap kapalı"
  const balanceLabel =
    balance > 0 ? 'Misafir borçlu' : balance < 0 ? 'Misafirden Alındı' : 'Hesap kapalı';

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Cari Hesap
          </h2>
          {isBlocked && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
              Kilitli
            </span>
          )}
        </span>
        {ledger !== null && (
          <div className="flex flex-wrap gap-2">
            {entries.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const rows = entries.map((e) => ({
                    Tarih: formatDate(e.created_at),
                    Tip: e.type === 'DEBT' ? 'Ücret' : 'Ödeme',
                    Tutar: Number(e.amount).toFixed(2),
                    'Para Birimi': e.currency,
                    Açıklama: tPaymentMethods(e.note),
                  }));
                  const base = `cari-${guestName || 'misafir'}-${stayStart.slice(0, 10)}`;
                  exportRowsToCsv(base, rows, [
                    { key: 'Tarih', label: 'Tarih' },
                    { key: 'Tip', label: 'Tip' },
                    { key: 'Tutar', label: 'Tutar' },
                    { key: 'Para Birimi', label: 'Para Birimi' },
                    { key: 'Açıklama', label: 'Açıklama' },
                  ]);
                }}
              >
                CSV İndir
              </Button>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="secondary"
                disabled={isBlocked}
                className="border-transparent bg-stone-200 hover:bg-stone-300 dark:border-transparent dark:bg-stone-700 dark:hover:bg-stone-600"
                onClick={onAddClick}
              >
                + Ekstra Ücret
              </Button>
            )}
            {canBlock && (
              <Button
                size="sm"
                variant="secondary"
                loading={blocking}
                onClick={onToggleBlock}
                className={
                  isBlocked
                    ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/30'
                    : 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30'
                }
              >
                {isBlocked ? 'Kilidi Aç' : 'Hesabı Kilitle'}
              </Button>
            )}
          </div>
        )}
      </div>
      {isBlocked && (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Bu cari hesap kilitli — yeni ödeme toplanamaz veya ekstra ücret eklenemez.
          Kilidi yalnızca yönetici açabilir.
        </p>
      )}
      {blockError && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
          {blockError}
        </p>
      )}

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!error && ledger === null && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {!error && ledger !== null && (
        <>
          <Card>
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-stone-600 dark:text-stone-300">
                  Toplam Ücret
                </span>
                <span className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                  {formatTRY(totalDebt)}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-stone-600 dark:text-stone-300">
                  Toplam Ödeme
                </span>
                <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                  {formatTRY(totalPayment)}
                </span>
              </div>
              <div className="border-t border-stone-300 pt-2 dark:border-stone-700">
                <div className="flex items-baseline justify-between">
                  <span className="text-base font-medium text-stone-700 dark:text-stone-200">
                    Bakiye
                  </span>
                  <span className={`text-2xl font-semibold ${balanceColor}`}>
                    {formatTRY(Math.abs(balance))}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="text-xs text-stone-600 dark:text-stone-300">
                    {ledger.length} hareket
                  </span>
                  <div className="text-right">
                    <span className={`block text-sm font-medium ${balanceColor}`}>
                      {balanceLabel}
                    </span>
                    {balance < 0 && (() => {
                      // Distinct payment methods used on this reservation —
                      // shown below "Misafirden Alındı" so the operator sees
                      // HOW the money came in without digging into the rows.
                      const METHOD_TR: Record<PaymentMethod, string> = {
                        CASH: 'Nakit',
                        TRANSFER: 'Havale/EFT',
                        CARD: 'Kart',
                      };
                      const methods = Array.from(
                        new Set(
                          ledger
                            .filter((e) => e.type === 'PAYMENT' && e.payment_collection?.method)
                            .map((e) => e.payment_collection!.method),
                        ),
                      );
                      if (methods.length === 0) return null;
                      return (
                        <div className="mt-1 flex flex-wrap justify-end gap-1">
                          {methods.map((m) => (
                            <span
                              key={m}
                              className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] font-medium text-stone-700 dark:bg-stone-700 dark:text-stone-200"
                            >
                              {METHOD_TR[m]}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {ledger.length === 0 ? (
            <Card>
              <p className="text-center text-sm text-stone-600 dark:text-stone-300">
                Henüz hareket yok.
              </p>
            </Card>
          ) : (
            <>
              {/* Mobile: stacked cards */}
              <div className="space-y-2 sm:hidden">
                {ledger.map((e) => {
                  const isDebt = e.type === 'DEBT';
                  return (
                    <div
                      key={e.id}
                      className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={
                                isDebt
                                  ? 'rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                  : 'rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                              }
                            >
                              {isDebt ? 'Ücret' : 'Ödeme'}
                            </span>
                            <span className="text-xs text-stone-600 dark:text-stone-300">
                              {formatDate(e.created_at)} · {formatTime(e.created_at)}
                            </span>
                          </div>
                          <p className="mt-1 break-words text-sm text-stone-700 dark:text-stone-300">
                            {tPaymentMethods(e.note)}
                            {e.created_by === null && (
                              <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                                Sistem
                              </span>
                            )}
                          </p>
                        </div>
                        <p
                          className={
                            isDebt
                              ? 'shrink-0 text-right font-semibold text-amber-600 dark:text-amber-400'
                              : 'shrink-0 text-right font-semibold text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {isDebt ? '+' : '−'}
                          {formatTRY(Number(e.amount))}
                        </p>
                      </div>
                      {canDelete && (
                        <div className="mt-2 flex justify-end">
                          <button
                            type="button"
                            onClick={() => onDeleteClick(e)}
                            className="text-xs text-red-600 hover:underline dark:text-red-400"
                          >
                            Sil
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Tablet+ : table */}
              <Card className="hidden p-0 sm:block">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-stone-300 text-xs uppercase text-stone-600 dark:border-stone-700 dark:text-stone-300">
                      <tr>
                        <th className="px-6 py-3 font-medium">Tarih</th>
                        <th className="px-6 py-3 font-medium">Tür</th>
                        <th className="px-6 py-3 font-medium">Açıklama</th>
                        <th className="px-6 py-3 text-right font-medium">Tutar</th>
                        {canDelete && <th className="px-6 py-3" aria-label="Sil" />}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-300 dark:divide-stone-700">
                      {ledger.map((e) => {
                        const isDebt = e.type === 'DEBT';
                        return (
                          <tr key={e.id}>
                            <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                              <div>{formatDate(e.created_at)}</div>
                              <div className="text-xs text-stone-600 dark:text-stone-300">
                                {formatTime(e.created_at)}
                              </div>
                            </td>
                            <td className="px-6 py-3">
                              <span
                                className={
                                  isDebt
                                    ? 'rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                    : 'rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                }
                              >
                                {isDebt ? 'Ücret' : 'Ödeme'}
                              </span>
                            </td>
                            <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                              <span>{tPaymentMethods(e.note)}</span>
                              {e.created_by === null && (
                                <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                                  Sistem
                                </span>
                              )}
                            </td>
                            <td
                              className={
                                isDebt
                                  ? 'px-6 py-3 text-right font-semibold text-amber-600 dark:text-amber-400'
                                  : 'px-6 py-3 text-right font-semibold text-emerald-600 dark:text-emerald-400'
                              }
                            >
                              {isDebt ? '+' : '−'}
                              {formatTRY(Number(e.amount))}
                            </td>
                            {canDelete && (
                              <td className="px-6 py-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => onDeleteClick(e)}
                                  aria-label="Hareketi sil"
                                  className="rounded p-1 text-stone-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                                >
                                  <svg
                                    className="h-4 w-4"
                                    viewBox="0 0 20 20"
                                    fill="none"
                                    aria-hidden="true"
                                  >
                                    <path
                                      d="M5 6h10M8 6V4h4v2M6 6l1 10h6l1-10"
                                      stroke="currentColor"
                                      strokeWidth="1.5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </section>
  );
}
