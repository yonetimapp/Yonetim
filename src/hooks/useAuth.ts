import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  createElement,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Role } from '@/types/database';

interface StaffProfile {
  user_id: string;
  full_name: string;
  role: Role;
  property_id: string | null;
  /** Home region (regions.name). NOT NULL since migration 124 — never blank. */
  region: string;
  /**
   * true = sees every region; false = scoped to `region`. Region access is
   * data-driven now (migration 124/125), so never infer it from the role —
   * use seesAllRegions() in lib/rbac, which mirrors auth_all_regions().
   */
  all_regions: boolean;
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  profile: StaffProfile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  /**
   * Re-fetch staff_profiles for the current user. Call this after the user
   * edits their own profile so the header/drawer reflect the change without
   * a full page reload.
   */
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (!data.session) setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return;
      setSession(newSession);
      if (!newSession) {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('staff_profiles')
      .select('user_id, full_name, role, property_id, region, all_regions')
      .eq('user_id', userId)
      .single();
    if (error) {
      console.error('Failed to load staff profile:', error);
      setProfile(null);
      return;
    }
    setProfile(data);
  }, []);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    loadProfile(userId).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // Key on the user *id* (primitive), not the user object reference —
    // Supabase emits a fresh session on every silent token refresh (e.g. tab
    // focus), and depending on the object reference here caused the whole
    // app to flash "Yükleniyor…" on every alt-tab.
  }, [session?.user?.id, loadProfile]);

  const refreshProfile = useCallback(async () => {
    if (!session?.user) return;
    await loadProfile(session.user.id);
  }, [session?.user, loadProfile]);

  const value: AuthContextValue = {
    user: session?.user ?? null,
    session,
    profile,
    loading,
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error };
    },
    signOut: async () => {
      await supabase.auth.signOut();
    },
    refreshProfile,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
