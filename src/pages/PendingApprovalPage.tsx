import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

/**
 * Full-screen gate shown to PENDING users (fresh signups). Their account
 * exists but has no role permissions and is in no RLS allow-list — the app
 * itself would just be empty. This screen explains the state and offers a
 * way out. A SUPER_ADMIN promotes them from the Personel page.
 */
export function PendingApprovalPage() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-4 dark:bg-stone-950">
      <div className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-6 text-center shadow-sm dark:border-stone-700 dark:bg-stone-900">
        <h1 className="text-2xl font-semibold text-emerald-600 dark:text-emerald-500">
          HomeGuru
        </h1>
        <h2 className="mt-4 text-lg font-semibold text-stone-900 dark:text-stone-100">
          Hesabınız onay bekliyor
        </h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
          {profile?.full_name ? `${profile.full_name}, hesabınız` : 'Hesabınız'}{' '}
          oluşturuldu. Bir yönetici hesabınızı onaylayıp yetki verene kadar
          uygulamayı kullanamazsınız.
        </p>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
          Onaylandıktan sonra tekrar giriş yapın.
        </p>

        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="mt-6 w-full rounded-md border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50 dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          {signingOut ? 'Çıkış yapılıyor…' : 'Çıkış Yap'}
        </button>
      </div>
    </div>
  );
}
