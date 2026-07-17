import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can } from '@/lib/rbac';
import {
  getGuestDecrypted,
  deleteGuest,
  cascadeDeleteGuest,
  countGuestReferences,
} from '@/lib/queries/guests';
import { getCompanionsDecrypted, deleteCompanion } from '@/lib/queries/companions';
import type { DecryptedGuest, DecryptedCompanion } from '@/types/database';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SendWhatsAppModal } from '@/components/SendWhatsAppModal';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { WarningTriangleIcon } from '@/components/icons/WarningTriangleIcon';
import { CompanionModal } from './CompanionModal';
import { ProblematicFlagModal } from './ProblematicFlagModal';
import { formatDate } from '@/lib/utils';

export function GuestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // "← Geri" returns to where the user came from; fall back to the list only on
  // a direct/deep-link entry (no in-app history).
  const goBack = () =>
    location.key === 'default' ? navigate('/guests') : navigate(-1);

  const [guest, setGuest] = useState<DecryptedGuest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cascadeBusy, setCascadeBusy] = useState(false);
  /** Set after the simple delete fails with FK so we can offer cascade. */
  const [blockingRefs, setBlockingRefs] = useState<{
    reservations: number;
    ledgerEntries: number;
  } | null>(null);
  const [showWhatsApp, setShowWhatsApp] = useState(false);
  /** Sorunlu Misafir — persistent warning flag modal (migration 043). */
  const [showProblematicModal, setShowProblematicModal] = useState(false);

  // Ek Misafir (companions)
  const [companions, setCompanions] = useState<DecryptedCompanion[]>([]);
  const [companionsError, setCompanionsError] = useState<string | null>(null);
  // Bumping this re-runs the companions fetch (after add / edit / delete).
  const [companionsVersion, setCompanionsVersion] = useState(0);
  const [showCompanionModal, setShowCompanionModal] = useState(false);
  const [editingCompanion, setEditingCompanion] = useState<DecryptedCompanion | null>(null);
  const [companionToDelete, setCompanionToDelete] = useState<DecryptedCompanion | null>(null);
  const [companionDeleteError, setCompanionDeleteError] = useState<string | null>(null);
  const [companionDeleting, setCompanionDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    setError(null);
    getGuestDecrypted(id)
      .then((g) => {
        if (!g) {
          setError('Misafir bulunamadı');
          return;
        }
        setGuest(g);
      })
      .catch((e) => setError(e?.message ?? 'Yüklenemedi'));
  }, [id]);

  // Companions — re-runs when companionsVersion bumps after a change.
  useEffect(() => {
    if (!id) return;
    setCompanionsError(null);
    getCompanionsDecrypted(id)
      .then(setCompanions)
      .catch((e) => setCompanionsError(e?.message ?? 'Ek misafirler yüklenemedi'));
  }, [id, companionsVersion]);

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

  if (!guest) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  const isAdmin = profile && can(profile.role, 'admin:*');
  const canEdit = profile && can(profile.role, 'guest:update');
  const canDelete = isAdmin;

  const handleDelete = async () => {
    if (!id) return;
    setBusy(true);
    setDeleteError(null);
    setBlockingRefs(null);
    try {
      await deleteGuest(id);
      navigate('/guests', { replace: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Silme başarısız';
      setDeleteError(msg);
      // If the error mentions a blocker, fetch counts so we can offer cascade.
      if (msg.includes('cari hareket') || msg.includes('rezervasyon') || msg.includes('bağlı')) {
        const refs = await countGuestReferences(id).catch(() => null);
        if (refs && (refs.reservations > 0 || refs.ledgerEntries > 0)) {
          setBlockingRefs(refs);
        }
      }
      setBusy(false);
    }
  };

  const handleCascadeDelete = async () => {
    if (!id) return;
    setCascadeBusy(true);
    setDeleteError(null);
    try {
      await cascadeDeleteGuest(id);
      navigate('/guests', { replace: true });
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Toplu silme başarısız');
      setCascadeBusy(false);
    }
  };

  const handleDeleteCompanion = async () => {
    if (!companionToDelete) return;
    setCompanionDeleting(true);
    setCompanionDeleteError(null);
    try {
      await deleteCompanion(companionToDelete.id);
      setCompanionToDelete(null);
      setCompanionDeleting(false);
      setCompanionsVersion((v) => v + 1);
    } catch (e) {
      setCompanionDeleteError(e instanceof Error ? e.message : 'Silme başarısız');
      setCompanionDeleting(false);
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
              {guest.full_name}
            </h1>
            {/* Sorunlu Misafir — persistent warning flag (migration 043).
                Text pill instead of a bare icon so it reads at a glance. */}
            {(guest.is_problematic || canEdit) && (
              <button
                type="button"
                onClick={canEdit ? () => setShowProblematicModal(true) : undefined}
                disabled={!canEdit}
                title={
                  guest.is_problematic && guest.problematic_note
                    ? `Sorunlu Misafir — ${guest.problematic_note}`
                    : guest.is_problematic
                      ? 'Sorunlu Misafir'
                      : 'Sorunlu misafir olarak işaretle'
                }
                className={
                  guest.is_problematic
                    ? 'shrink-0 rounded-md bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 transition-colors hover:bg-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-default disabled:hover:bg-red-100 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/60'
                    : 'shrink-0 rounded-md border border-dashed border-red-300 px-2.5 py-0.5 text-xs font-medium text-red-600 transition-colors hover:border-red-400 hover:bg-red-50 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:border-red-800 dark:text-red-400 dark:hover:border-red-700 dark:hover:bg-red-950/40'
                }
              >
                {guest.is_problematic ? 'Sorunlu Misafir' : '+ Sorunlu işaretle'}
              </button>
            )}
          </div>
          {guest.nationality && (
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{guest.nationality}</p>
          )}
          {guest.is_problematic && guest.problematic_note && (
            <p className="mt-1 flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400">
              <WarningTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{guest.problematic_note}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowWhatsApp(true)}>
            <WhatsAppIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
            WhatsApp
          </Button>
          {canEdit && (
            <Link to={`/guests/${guest.id}/edit`}>
              <Button variant="secondary" size="sm">
                Düzenle
              </Button>
            </Link>
          )}
          {canDelete && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
            >
              Sil
            </Button>
          )}
        </div>
      </div>

      <Card>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <Field label="Telefon" value={guest.phone} />
          <Field label="E-posta" value={guest.email} />
          <Field label="TC Kimlik" value={guest.tc_kimlik} />
          <Field label="Pasaport" value={guest.passport} />
          <Field label="Adres" value={guest.address} className="sm:col-span-2" />
        </dl>
      </Card>

      {/* Ek Misafirler — family / companions travelling with this guest */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Ek Misafirler
          </h2>
          {canEdit && (
            <Button
              size="sm"
              onClick={() => {
                setEditingCompanion(null);
                setShowCompanionModal(true);
              }}
            >
              + Ek Misafir
            </Button>
          )}
        </div>

        {companionsError && (
          <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-sm text-red-700 dark:text-red-400">{companionsError}</p>
          </Card>
        )}

        {!companionsError && companions.length === 0 && (
          <Card>
            <p className="text-center text-sm text-stone-600 dark:text-stone-300">
              Henüz ek misafir eklenmemiş.
            </p>
          </Card>
        )}

        {companions.length > 0 && (
          <Card className="p-0">
            <ul className="divide-y divide-stone-200 dark:divide-stone-700">
              {companions.map((c) => {
                const details = [
                  c.tc_kimlik ? `TC: ${c.tc_kimlik}` : null,
                  c.passport ? `Pasaport: ${c.passport}` : null,
                  c.birth_date ? `Doğum: ${formatDate(c.birth_date)}` : null,
                  c.nationality,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <li key={c.id} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-stone-900 dark:text-stone-100">
                          {c.full_name}
                        </span>
                        {c.relationship && (
                          <span className="rounded bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-700 dark:text-stone-200">
                            {c.relationship}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 break-words text-xs text-stone-600 dark:text-stone-300">
                        {details || '—'}
                      </p>
                    </div>
                    {canEdit && (
                      <div className="flex shrink-0 items-center gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingCompanion(c);
                            setShowCompanionModal(true);
                          }}
                          className="text-xs text-emerald-600 hover:underline dark:text-emerald-500"
                        >
                          Düzenle
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCompanionDeleteError(null);
                            setCompanionToDelete(c);
                          }}
                          className="text-xs text-red-600 hover:underline dark:text-red-400"
                        >
                          Sil
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title={`"${guest.full_name}" silinsin mi?`}
        description={
          <>
            <p>Bu işlem geri alınamaz.</p>
            <p className="mt-2 font-medium">
              Not: Rezervasyon veya cari hareket kaydı bulunan misafirler silinemez.
            </p>
          </>
        }
        confirmLabel="Sil"
        destructive
        loading={busy}
        error={
          deleteError && (
            <>
              <p>{deleteError}</p>
              {blockingRefs && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-stone-700 dark:text-stone-300">
                    Bağlı kayıtlar Çöp Kutusu'na taşınır (geri yüklenebilir), misafir kalıcı olarak silinir.
                  </p>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={cascadeBusy}
                    onClick={handleCascadeDelete}
                  >
                    Bağlı kayıtları Çöp Kutusu'na taşı ve misafiri sil
                  </Button>
                </div>
              )}
            </>
          )
        }
        onConfirm={handleDelete}
        onCancel={() => {
          setConfirmDelete(false);
          setDeleteError(null);
          setBlockingRefs(null);
        }}
      />

      <ConfirmDialog
        open={companionToDelete !== null}
        title="Ek misafir silinsin mi?"
        description={
          companionToDelete
            ? `"${companionToDelete.full_name}" kaydı kalıcı olarak silinecek.`
            : ''
        }
        confirmLabel="Sil"
        destructive
        loading={companionDeleting}
        error={companionDeleteError}
        onConfirm={handleDeleteCompanion}
        onCancel={() => {
          setCompanionToDelete(null);
          setCompanionDeleteError(null);
        }}
      />

      {showCompanionModal && (
        <CompanionModal
          guestId={guest.id}
          companion={editingCompanion}
          onClose={() => setShowCompanionModal(false)}
          onSaved={() => {
            setShowCompanionModal(false);
            setCompanionsVersion((v) => v + 1);
          }}
        />
      )}

      {showWhatsApp && (
        <SendWhatsAppModal
          recipientName={guest.full_name}
          recipientPhone={guest.phone}
          variables={{
            misafir_adi: guest.full_name,
          }}
          onClose={() => setShowWhatsApp(false)}
        />
      )}

      {showProblematicModal && (
        <ProblematicFlagModal
          guestId={guest.id}
          guestName={guest.full_name}
          initialIsProblematic={guest.is_problematic}
          initialNote={guest.problematic_note}
          onClose={() => setShowProblematicModal(false)}
          onSaved={({ isProblematic, note }) => {
            // Update the local guest snapshot so the icon + inline note reflect
            // the new state immediately without a re-fetch (which would log a
            // KVKK GUEST_DECRYPT audit row for no good reason).
            setGuest((prev) =>
              prev
                ? { ...prev, is_problematic: isProblematic, problematic_note: note }
                : prev,
            );
            setShowProblematicModal(false);
          }}
        />
      )}
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string | null;
  className?: string;
}

function Field({ label, value, className }: FieldProps) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium uppercase tracking-wide text-stone-600 dark:text-stone-300">
        {label}
      </dt>
      <dd className="mt-1 text-stone-900 dark:text-stone-100">{value || '—'}</dd>
    </div>
  );
}
