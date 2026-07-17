import { useEffect, useState } from 'react';
import { Outlet, Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can, isTeknikPersonel } from '@/lib/rbac';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { NotificationSettingsModal } from '@/components/NotificationSettingsModal';
import { PullToRefresh } from '@/components/PullToRefresh';
import { PendingApprovalPage } from '@/pages/PendingApprovalPage';
import { cn, formatRole } from '@/lib/utils';

export function Layout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();

  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  /** Bell-icon settings modal — owns per-event push opt-in toggles. */
  const [notifModalOpen, setNotifModalOpen] = useState(false);

  // Close the mobile drawer on Esc + lock body scroll while open.
  useEffect(() => {
    if (!mobileOpen) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', handle);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handle);
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
    navigate('/login', { replace: true });
  };

  // Desktop NavLink — inline horizontal pill.
  const navLinkClasses = ({ isActive }: { isActive: boolean }) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
      isActive
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
        : 'text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800',
    );

  // Mobile-drawer NavLink — full-width block, bigger tap target so each item
  // lives on its own row instead of wrapping flow-style alongside neighbors.
  const drawerLinkClasses = ({ isActive }: { isActive: boolean }) =>
    cn(
      'block w-full rounded-md px-3 py-3 text-base font-medium transition-colors',
      isActive
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
        : 'text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800',
    );

  // Same icon-button look used for Denetim Kaydı / Çöp Kutusu in both layouts.
  const iconLinkClasses = ({ isActive }: { isActive: boolean }) =>
    cn(
      'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
      isActive
        ? 'border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
        : 'border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
    );

  const closeMobile = () => setMobileOpen(false);

  // The audit + trash icon SVGs as inline JSX. Inline both copies; the
  // duplication is small and avoids a new shared file just for two icons.
  const auditIcon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  );

  const trashIcon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );

  // Yedekler — the nightly cloud-backup browser (SUPER_ADMIN, like audit/trash).
  const backupIcon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v10" />
      <path d="M8 9l4 4 4-4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );

  // Bell — opens the per-event notification preferences modal. Visible to
  // every signed-in role (not gated to SUPER_ADMIN like audit/trash).
  const bellIcon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );

  // Same look as the audit/trash icon links but as a <button> because it
  // opens a modal instead of navigating.
  const iconButtonClasses = cn(
    'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
    'border-stone-300 text-stone-700 hover:bg-stone-100',
    'dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
  );

  // PENDING signups have no role permissions and are in no RLS allow-list —
  // the app shell would just be empty. Show the holding screen instead.
  if (profile?.role === 'PENDING') {
    return <PendingApprovalPage />;
  }

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-950">
      <PullToRefresh />
      <header className="border-b border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          {/* Logo — always visible */}
          <Link
            to="/dashboard"
            className="text-lg font-semibold text-emerald-600 dark:text-emerald-500"
          >
            HomeGuru
          </Link>

          {/* Desktop nav (left of right-side actions) — hidden on mobile */}
          <nav className="ml-6 hidden flex-1 items-center gap-1 md:flex">
            <NavLink to="/dashboard" className={navLinkClasses}>
              Panel
            </NavLink>
            <NavLink to="/reservations" className={navLinkClasses}>
              Rezervasyonlar
            </NavLink>
            {profile && can(profile.role, 'housekeeping:read') && (
              <NavLink to="/housekeeping" className={navLinkClasses}>
                Temizlik
              </NavLink>
            )}
            {profile && !isTeknikPersonel(profile.role) && (
              <>
                <NavLink to="/guests" className={navLinkClasses}>
                  Misafirler
                </NavLink>
                <NavLink to="/properties" className={navLinkClasses}>
                  Mülkler
                </NavLink>
              </>
            )}
            {profile && can(profile.role, 'finance:read') && (
              <NavLink to="/finance/cash" className={navLinkClasses}>
                Finans
              </NavLink>
            )}
            {profile && can(profile.role, 'finance:read') && (
              <NavLink to="/settings/templates" className={navLinkClasses}>
                Şablonlar
              </NavLink>
            )}
          </nav>

          {/* Desktop right-side actions — hidden on mobile */}
          <div className="hidden items-center gap-3 md:flex">
            <Link
              to="/settings/profile"
              title="Profili düzenle"
              className="rounded px-1 text-sm text-stone-700 transition-colors hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              {profile?.full_name}
              <span className="ml-2 rounded bg-stone-100 px-2 py-0.5 text-xs uppercase text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                {profile?.role ? formatRole(profile.role) : ''}
              </span>
            </Link>
            {profile?.role === 'SUPER_ADMIN' && (
              <NavLink
                to="/settings/audit"
                aria-label="Denetim Kaydı"
                title="Denetim Kaydı"
                className={iconLinkClasses}
              >
                {auditIcon}
              </NavLink>
            )}
            {profile?.role === 'SUPER_ADMIN' && (
              <NavLink
                to="/settings/trash"
                aria-label="Çöp Kutusu"
                title="Çöp Kutusu"
                className={iconLinkClasses}
              >
                {trashIcon}
              </NavLink>
            )}
            {profile?.role === 'SUPER_ADMIN' && (
              <NavLink
                to="/settings/backups"
                aria-label="Yedekler"
                title="Yedekler"
                className={iconLinkClasses}
              >
                {backupIcon}
              </NavLink>
            )}
            {profile && (
              <button
                type="button"
                onClick={() => setNotifModalOpen(true)}
                aria-label="Bildirim Ayarları"
                title="Bildirim Ayarları"
                className={iconButtonClasses}
              >
                {bellIcon}
              </button>
            )}
            <ThemeToggle />
            <button
              type="button"
              onClick={() => setConfirmSignOut(true)}
              className={cn(
                'rounded-md border px-3 py-1 text-sm transition-colors',
                'border-stone-300 text-stone-700 hover:bg-stone-100',
                'dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800',
              )}
            >
              Çıkış
            </button>
          </div>

          {/* Mobile hamburger — visible only on mobile.
              Filled emerald to stand out against the white header and match
              the brand logo on the left. */}
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Menüyü aç"
            aria-expanded={mobileOpen}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm transition-colors hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 dark:bg-emerald-600 dark:hover:bg-emerald-500 dark:focus:ring-offset-stone-900 md:hidden"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={closeMobile}
            aria-hidden="true"
          />
          <aside
            className="absolute right-0 top-0 flex h-full w-72 max-w-[85vw] flex-col bg-white shadow-xl dark:bg-stone-900"
          >
            {/* Drawer header: user (tap → profile) + close */}
            <div className="flex items-start justify-between gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-700">
              <NavLink
                to="/settings/profile"
                onClick={closeMobile}
                className="-mx-2 min-w-0 rounded px-2 py-1 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                  {profile?.full_name}
                </p>
                <span className="mt-1 inline-block rounded bg-stone-100 px-2 py-0.5 text-xs uppercase text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                  {profile?.role ? formatRole(profile.role) : ''}
                </span>
              </NavLink>
              <button
                type="button"
                onClick={closeMobile}
                aria-label="Menüyü kapat"
                className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M5 5l10 10M15 5L5 15"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            {/* Drawer nav links — one per row */}
            <nav className="flex-1 space-y-1 overflow-y-auto p-3">
              <NavLink to="/dashboard" className={drawerLinkClasses} onClick={closeMobile}>
                Panel
              </NavLink>
              <NavLink
                to="/reservations"
                className={drawerLinkClasses}
                onClick={closeMobile}
              >
                Rezervasyonlar
              </NavLink>
              {profile && can(profile.role, 'housekeeping:read') && (
                <NavLink
                  to="/housekeeping"
                  className={drawerLinkClasses}
                  onClick={closeMobile}
                >
                  Temizlik
                </NavLink>
              )}
              {profile && !isTeknikPersonel(profile.role) && (
                <>
                  <NavLink to="/guests" className={drawerLinkClasses} onClick={closeMobile}>
                    Misafirler
                  </NavLink>
                  <NavLink to="/properties" className={drawerLinkClasses} onClick={closeMobile}>
                    Mülkler
                  </NavLink>
                </>
              )}
              {profile && can(profile.role, 'finance:read') && (
                <NavLink
                  to="/finance/cash"
                  className={drawerLinkClasses}
                  onClick={closeMobile}
                >
                  Finans
                </NavLink>
              )}
              {profile && can(profile.role, 'finance:read') && (
                <NavLink
                  to="/settings/templates"
                  className={drawerLinkClasses}
                  onClick={closeMobile}
                >
                  Şablonlar
                </NavLink>
              )}
            </nav>

            {/* Drawer footer: admin shortcuts + theme + sign out */}
            <div className="flex items-center justify-between gap-3 border-t border-stone-200 px-3 py-3 dark:border-stone-700">
              <div className="flex items-center gap-2">
                {profile?.role === 'SUPER_ADMIN' && (
                  <NavLink
                    to="/settings/audit"
                    aria-label="Denetim Kaydı"
                    title="Denetim Kaydı"
                    onClick={closeMobile}
                    className={iconLinkClasses}
                  >
                    {auditIcon}
                  </NavLink>
                )}
                {profile?.role === 'SUPER_ADMIN' && (
                  <NavLink
                    to="/settings/trash"
                    aria-label="Çöp Kutusu"
                    title="Çöp Kutusu"
                    onClick={closeMobile}
                    className={iconLinkClasses}
                  >
                    {trashIcon}
                  </NavLink>
                )}
                {profile?.role === 'SUPER_ADMIN' && (
                  <NavLink
                    to="/settings/backups"
                    aria-label="Yedekler"
                    title="Yedekler"
                    onClick={closeMobile}
                    className={iconLinkClasses}
                  >
                    {backupIcon}
                  </NavLink>
                )}
                {profile && (
                  <button
                    type="button"
                    onClick={() => {
                      closeMobile();
                      setNotifModalOpen(true);
                    }}
                    aria-label="Bildirim Ayarları"
                    title="Bildirim Ayarları"
                    className={iconButtonClasses}
                  >
                    {bellIcon}
                  </button>
                )}
                <ThemeToggle />
              </div>
              <button
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  setConfirmSignOut(true);
                }}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-sm transition-colors',
                  'border-stone-300 text-stone-700 hover:bg-stone-100',
                  'dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800',
                )}
              >
                Çıkış
              </button>
            </div>
          </aside>
        </div>
      )}

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>

      <ConfirmDialog
        open={confirmSignOut}
        title="Çıkış yapılsın mı?"
        description="Oturumunuz kapatılacak ve giriş ekranına yönlendirileceksiniz."
        confirmLabel="Çıkış Yap"
        cancelLabel="Vazgeç"
        destructive
        loading={signingOut}
        onConfirm={handleSignOut}
        onCancel={() => setConfirmSignOut(false)}
      />

      {notifModalOpen && (
        <NotificationSettingsModal onClose={() => setNotifModalOpen(false)} />
      )}
    </div>
  );
}
