import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can, baseRole, isTeknikPersonel } from '@/lib/rbac';
import { loadDashboardCounts, type DashboardCounts } from '@/lib/queries/dashboard';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/utils';
import {
  CalendarIcon,
  MagnifyingGlassIcon,
  UserIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  CurrencyLiraIcon,
} from '@/components/icons/ActionIcons';
import { QuickIssueModal } from '@/components/QuickIssueModal';

export function DashboardPage() {
  const { profile } = useAuth();

  const [counts, setCounts] = useState<DashboardCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Sorunlar quick-action modal — file an issue against an active stay. */
  const [showIssueModal, setShowIssueModal] = useState(false);
  /** Bumping this re-runs the count loader after a successful issue create. */
  const [countsVersion, setCountsVersion] = useState(0);

  useEffect(() => {
    setError(null);
    loadDashboardCounts()
      .then(setCounts)
      .catch((e) => setError(e instanceof Error ? e.message : 'Veriler yüklenemedi'));
  }, [countsVersion]);

  if (!profile) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  const canReadFinance = can(profile.role, 'finance:read');
  const canReadHousekeeping = can(profile.role, 'housekeeping:read');
  // Cleaning-status capability — gates the "Kirli Daireler" tile so a read-only
  // issue role (Teknik Personel) sees "Açık Sorun" but not the cleaning count.
  const canWriteHousekeeping = can(profile.role, 'housekeeping:write');
  const canCreateReservation = can(profile.role, 'reservation:create');
  const canCreateGuest = can(profile.role, 'guest:create');
  const teknik = isTeknikPersonel(profile.role);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Hoş geldin, {profile.full_name}
        </h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Bugünün özeti ve hızlı işlemler
        </p>
      </div>

      {/* Today tiles */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-600 dark:text-stone-300">
          Bugün
        </h2>
        {error && (
          <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </Card>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {/* Informational counts — always neutral, no good/bad meaning. */}
          <Tile to="/reservations" label="Bugün Giriş" value={counts?.checkInsToday} />
          <Tile to="/reservations" label="Bugün Çıkış" value={counts?.checkOutsToday} />
          <Tile
            to={teknik ? '/reservations' : '/reservations/calendar'}
            label="Şu An Aktif"
            value={counts?.activeNow}
          />
          {/* Watch metrics — neutral at 0 (all good), warning tone only when > 0. */}
          {canReadFinance && (
            <Tile
              to="/finance/pending"
              label="Onay Bekleyen Tahsilat"
              value={counts?.pendingPayments}
              watchTone="amber"
            />
          )}
          {canReadHousekeeping && (
            <Tile
              to="/housekeeping?filter=issues"
              label="Açık Sorun"
              value={counts?.openIssues}
              watchTone="red"
            />
          )}
          {canWriteHousekeeping && (
            <Tile
              to="/housekeeping?filter=dirty"
              label="Kirli Daireler"
              value={counts?.dirtyUnits}
              watchTone="amber"
            />
          )}
        </div>
      </section>

      {/* Quick actions */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-600 dark:text-stone-300">
          Hızlı İşlemler
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {canReadHousekeeping && (
            <QuickAction
              onClick={() => setShowIssueModal(true)}
              icon={<ExclamationCircleIcon className="h-5 w-5" />}
              label="Sorunlar"
              description="Bir mülk ve birim seçip hızlıca sorun bildir"
            />
          )}
          {canCreateReservation && (
            <QuickAction
              to="/reservations/new"
              icon={<CalendarIcon className="h-5 w-5" />}
              label="+ Yeni Rezervasyon"
              description="Müsait birim seçerek hızlıca rezervasyon oluştur"
            />
          )}
          {!teknik && (
            <QuickAction
              to="/reservations/availability"
              icon={<MagnifyingGlassIcon className="h-5 w-5" />}
              label="Müsaitlik Ara"
              description="Tarih ve gece sayısına göre uygun birimleri bul"
            />
          )}
          {canCreateGuest && (
            <QuickAction
              to="/guests/new"
              icon={<UserIcon className="h-5 w-5" />}
              label="+ Yeni Misafir"
              description="Misafir kaydı oluştur"
            />
          )}
          {canReadFinance && (
            <QuickAction
              to="/finance/pending"
              icon={<CheckCircleIcon className="h-5 w-5" />}
              label="Tahsilat Onayları"
              description="Personel tarafından toplanan tahsilatları onayla"
            />
          )}
          {canReadFinance && (
            <QuickAction
              to="/finance/expenses/new"
              icon={<CurrencyLiraIcon className="h-5 w-5" />}
              label="Gider Ekle"
              description="Yapılan harcamayı hızlıca kaydet"
            />
          )}
          {/* Personel (YETKILI) has no Finans menu, but can submit giderler.
              The form lands the row in 'pending' for yönetici onay. */}
          {baseRole(profile?.role) === 'YETKILI' && (
            <QuickAction
              to="/finance/expenses/new"
              icon={<ExclamationCircleIcon className="h-5 w-5" />}
              label="+ Gider Bildir"
              description="Yapılan harcamayı yönetici onayına gönder"
            />
          )}
        </div>
      </section>

      {showIssueModal && (
        <QuickIssueModal
          onClose={() => setShowIssueModal(false)}
          onCreated={() => setCountsVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tile — compact count card, tap to drill into the relevant page.
// -----------------------------------------------------------------------------

type WatchTone = 'amber' | 'red';

// Per-tone classes applied ONLY when a watch metric is non-zero. At zero,
// every tile is plain neutral — "0 açık sorun" should look calm, not alarming.
const WATCH_NUMBER: Record<WatchTone, string> = {
  amber: 'text-amber-700 dark:text-amber-400',
  red: 'text-red-700 dark:text-red-400',
};
const WATCH_BORDER: Record<WatchTone, string> = {
  amber: 'border-amber-300 shadow-sm dark:border-amber-800',
  red: 'border-red-300 shadow-sm dark:border-red-800',
};

interface TileProps {
  to: string;
  label: string;
  value: number | undefined;
  /**
   * Set only for "needs attention" metrics. When the value is > 0 the tile
   * takes this warning tone; at 0 it stays neutral like an informational tile.
   */
  watchTone?: WatchTone;
}

function Tile({ to, label, value, watchTone }: TileProps) {
  const active = watchTone !== undefined && (value ?? 0) > 0;
  return (
    <Link
      to={to}
      className={cn(
        'block rounded-lg border bg-white p-4 transition-shadow hover:shadow-md dark:bg-stone-900',
        active && watchTone
          ? WATCH_BORDER[watchTone]
          : 'border-stone-200 dark:border-stone-700',
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-stone-600 dark:text-stone-300">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-3xl font-semibold tabular-nums',
          active && watchTone
            ? WATCH_NUMBER[watchTone]
            : 'text-stone-900 dark:text-stone-100',
        )}
      >
        {value === undefined ? '…' : value}
      </p>
    </Link>
  );
}

// -----------------------------------------------------------------------------
// QuickAction — big neutral button-like card.
// -----------------------------------------------------------------------------

interface QuickActionProps {
  /** Navigates to this route when set. Mutually exclusive with onClick. */
  to?: string;
  /** Runs in place of navigation when set (e.g. to open a modal). */
  onClick?: () => void;
  /** Optional leading icon, rendered in a circular well on the left. */
  icon?: ReactNode;
  label: string;
  description: ReactNode;
}

function QuickAction({ to, onClick, icon, label, description }: QuickActionProps) {
  // Shared styling between the Link and button modes so the grid stays
  // visually uniform whichever shape the action takes.
  const className =
    'flex items-center gap-3 rounded-lg border border-emerald-300 bg-white p-4 text-left text-stone-900 transition-colors hover:border-emerald-400 hover:bg-emerald-50 active:border-emerald-400 active:bg-emerald-50 dark:border-emerald-800 dark:bg-stone-900 dark:text-stone-100 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/30 dark:active:border-emerald-700 dark:active:bg-emerald-950/30';

  const body = (
    <>
      {icon && (
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold">{label}</span>
        <span className="mt-1 block text-xs text-stone-600 dark:text-stone-300">
          {description}
        </span>
      </span>
    </>
  );

  if (to) {
    return (
      <Link to={to} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={`${className} w-full`}>
      {body}
    </button>
  );
}
