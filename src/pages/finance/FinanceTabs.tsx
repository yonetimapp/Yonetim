import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { baseRole } from '@/lib/rbac';
import { countPendingApprovals } from '@/lib/queries/pendingApprovals';
import { cn } from '@/lib/utils';

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    // Soft tinted active state (matches ReservationsViewTabs) so it doesn't fight
    // with the primary indigo CTAs on the page.
    isActive
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : 'border border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
  );

function CashIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="5"
        width="15"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ReceiptIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 2.5h10v15l-2.5-1.5L10 17l-2.5-1L5 17.5v-15z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M7.5 7h5M7.5 10h5M7.5 13h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4 10l4 4 8-9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DebtIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 6.5c-1.4 0-2.2.8-2.2 1.7s.8 1.3 2.2 1.6c1.4.3 2.2.7 2.2 1.6s-.8 1.7-2.2 1.7-2.2-.8-2.2-1.7M10 5.3v1.2M10 13.4v1.3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2 17c0-2.8 2.2-5 5-5s5 2.2 5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="14" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 17c0-2.2 1.5-4 4-4s2 0 2 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RegionIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 17.5s5.5-4.6 5.5-9a5.5 5.5 0 1 0-11 0c0 4.4 5.5 9 5.5 9z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="8.5" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function FinanceTabs() {
  const { profile } = useAuth();
  // Personel (YETKILI) only has access to Giderler (their own submissions
  // queued for onay). The other three routes are ProtectedRoute-blocked for
  // them anyway, but hiding the tabs avoids dead-end clicks.
  const r = baseRole(profile?.role);
  const isFullFinance = r === 'SUPER_ADMIN' || r === 'PROPERTY_MANAGER';

  // Badge the "Onaylar" tab with how many items still await approval.
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    if (!isFullFinance) return;
    countPendingApprovals(profile?.role === 'SUPER_ADMIN')
      .then(setPendingCount)
      .catch(() => {});
  }, [isFullFinance, profile?.role]);

  return (
    <div className="flex flex-wrap gap-2">
      {isFullFinance && (
        <NavLink to="/finance/staff" className={tabClass}>
          <PeopleIcon />
          Personel
        </NavLink>
      )}
      <NavLink to="/finance/expenses" className={tabClass}>
        <ReceiptIcon />
        Giderler
      </NavLink>
      {isFullFinance && (
        <NavLink to="/finance/cash" className={tabClass}>
          <CashIcon />
          Kasa
        </NavLink>
      )}
      {isFullFinance && (
        <NavLink to="/finance/debts" className={tabClass}>
          <DebtIcon />
          Borçlar
        </NavLink>
      )}
      {isFullFinance && (
        <NavLink to="/finance/pending" className={tabClass}>
          <CheckIcon />
          Onaylar
          {pendingCount > 0 && (
            <span className="ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
              {pendingCount}
            </span>
          )}
        </NavLink>
      )}
      {/* Bölgeler is structural admin — creating a region also creates its kasa,
          so it stays with the Yönetici alone (matches role/region assignment). */}
      {profile?.role === 'SUPER_ADMIN' && (
        <NavLink to="/finance/regions" className={tabClass}>
          <RegionIcon />
          Bölgeler
        </NavLink>
      )}
    </div>
  );
}
