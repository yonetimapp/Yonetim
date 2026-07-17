import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { baseRole } from '@/lib/rbac';
import type { ReactNode } from 'react';
import type { Role } from '@/types/database';

interface Props {
  children: ReactNode;
  /** Optional: restrict to specific roles. Defaults to any authenticated user. */
  allowedRoles?: Role[];
  /**
   * Optional: block specific roles from an otherwise-open route. Checked against
   * the RAW role (not baseRole) so a narrow role like TEKNIK_PERSONEL can
   * be denied pages its server access would otherwise let it load.
   */
  deniedRoles?: Role[];
}

export function ProtectedRoute({ children, allowedRoles, deniedRoles }: Props) {
  const { user, profile, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-stone-50 text-stone-600 dark:bg-stone-950 dark:text-stone-300">
        Yükleniyor…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // Profile exists but no role assigned yet — needs admin attention.
  if (!profile) {
    return (
      <div className="flex h-screen items-center justify-center bg-stone-50 px-4 text-center text-red-600 dark:bg-stone-950 dark:text-red-400">
        Hesabınıza henüz bir rol atanmadı. Lütfen yöneticinizle iletişime geçin.
      </div>
    );
  }

  // Region access is a per-user assignment, not a role — routes gate purely on
  // the role; the region restriction is enforced server-side by RLS.
  if (allowedRoles && !allowedRoles.includes(baseRole(profile.role) as Role)) {
    return <Navigate to="/dashboard" replace />;
  }

  // Deny-list takes precedence: a blocked role is redirected even if it would
  // otherwise pass allowedRoles. Uses the raw role.
  if (deniedRoles && deniedRoles.includes(profile.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
