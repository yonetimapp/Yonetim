import { NavLink } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { isTeknikPersonel } from '@/lib/rbac';
import { cn } from '@/lib/utils';

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    // Active uses a softer tinted style so it doesn't compete with primary
    // emerald CTAs (e.g. "+ Yeni Rezervasyon") sitting next to it.
    isActive
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : 'border border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
  );

function CalendarIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="3"
        y="4"
        width="14"
        height="13"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M3 8h14M7 2.5v3M13 2.5v3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M13 13l4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ReservationsViewTabs() {
  const { profile } = useAuth();
  // Teknik Personel gets the read-only Liste only — no availability/calendar
  // tools (the routes are also guarded server-of-router-side in App.tsx).
  const restricted = isTeknikPersonel(profile?.role);
  return (
    <div className="flex flex-wrap gap-2">
      {!restricted && (
        <>
          <NavLink to="/reservations/availability" className={tabClass}>
            <SearchIcon />
            Müsaitlik
          </NavLink>
          <NavLink to="/reservations/calendar" className={tabClass}>
            <CalendarIcon />
            Takvim
          </NavLink>
        </>
      )}
      <NavLink to="/reservations" end className={tabClass}>
        Liste
      </NavLink>
    </div>
  );
}
