import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { PushNavigationListener } from '@/components/PushNavigationListener';
import { PwaUpdatePrompt } from '@/components/PwaUpdatePrompt';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { PropertiesListPage } from '@/pages/properties/PropertiesListPage';
import { PropertyDetailPage } from '@/pages/properties/PropertyDetailPage';
import { PropertyFormPage } from '@/pages/properties/PropertyFormPage';
import { UnitFormPage } from '@/pages/properties/UnitFormPage';
import { GuestsListPage } from '@/pages/guests/GuestsListPage';
import { GuestDetailPage } from '@/pages/guests/GuestDetailPage';
import { GuestFormPage } from '@/pages/guests/GuestFormPage';
import { ReservationsListPage } from '@/pages/reservations/ReservationsListPage';
import { ReservationsCalendarPage } from '@/pages/reservations/ReservationsCalendarPage';
import { ReservationsAvailabilityPage } from '@/pages/reservations/ReservationsAvailabilityPage';
import { ReservationDetailPage } from '@/pages/reservations/ReservationDetailPage';
import { ReservationFormPage } from '@/pages/reservations/ReservationFormPage';
import { CashPage } from '@/pages/finance/CashPage';
import { ExpensesListPage } from '@/pages/finance/ExpensesListPage';
import { ExpenseFormPage } from '@/pages/finance/ExpenseFormPage';
import { PendingPaymentsPage } from '@/pages/finance/PendingPaymentsPage';
import { DebtorsPage } from '@/pages/finance/DebtorsPage';
import { RegionsPage } from '@/pages/finance/RegionsPage';
import { HousekeepingPage } from '@/pages/housekeeping/HousekeepingPage';
import { StaffListPage } from '@/pages/finance/StaffListPage';
import { StaffDetailPage } from '@/pages/finance/StaffDetailPage';
import { TemplatesPage } from '@/pages/settings/TemplatesPage';
import { TrashPage } from '@/pages/settings/TrashPage';
import { BackupsPage } from '@/pages/settings/BackupsPage';
import { AuditLogPage } from '@/pages/settings/AuditLogPage';
import { ProfilePage } from '@/pages/settings/ProfilePage';

const RESERVATION_WRITERS = ['SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI'] as const;
const GUEST_WRITERS = ['SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI'] as const;
const FINANCE_ACCESS = ['SUPER_ADMIN', 'PROPERTY_MANAGER'] as const;
// Roles that can submit a new gider. YETKILI's submission goes through the
// onay queue (migration 055 + 064) instead of posting straight to the kasa.
const EXPENSE_WRITERS = ['SUPER_ADMIN', 'PROPERTY_MANAGER', 'YETKILI'] as const;
const HOUSEKEEPING_ACCESS = [
  'SUPER_ADMIN',
  'PROPERTY_MANAGER',
  'HOUSEKEEPING',
  'YETKILI',
  'TEKNIK_PERSONEL',
] as const;
const UNIT_WRITERS = ['SUPER_ADMIN', 'PROPERTY_MANAGER', 'YETKILI'] as const;
// Narrow technical role — blocked from otherwise-open pages (guests, properties,
// reservation calendar/availability). Its server access is HOUSEKEEPING-level,
// so the router must hide what the UI shouldn't expose.
const TEKNIK_BLOCKED = ['TEKNIK_PERSONEL'] as const;

export default function App() {
  return (
    <AuthProvider>
      <PwaUpdatePrompt />
      <PushNavigationListener />
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />

          {/* Profile — any authenticated user can edit their own display name */}
          <Route path="/settings/profile" element={<ProfilePage />} />

          {/* Properties */}
          <Route
            path="/properties"
            element={
              <ProtectedRoute deniedRoles={[...TEKNIK_BLOCKED]}>
                <PropertiesListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/properties/new"
            element={
              <ProtectedRoute allowedRoles={['SUPER_ADMIN']}>
                <PropertyFormPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/properties/:id"
            element={
              <ProtectedRoute deniedRoles={[...TEKNIK_BLOCKED]}>
                <PropertyDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/properties/:id/edit"
            element={
              <ProtectedRoute allowedRoles={['SUPER_ADMIN']}>
                <PropertyFormPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/properties/:id/units/new"
            element={
              <ProtectedRoute allowedRoles={[...UNIT_WRITERS]}>
                <UnitFormPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/properties/:id/units/:unitId/edit"
            element={
              <ProtectedRoute allowedRoles={[...UNIT_WRITERS]}>
                <UnitFormPage />
              </ProtectedRoute>
            }
          />

          {/* Guests */}
          <Route
            path="/guests"
            element={
              <ProtectedRoute deniedRoles={[...TEKNIK_BLOCKED]}>
                <GuestsListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/guests/new"
            element={
              <ProtectedRoute allowedRoles={[...GUEST_WRITERS]}>
                <GuestFormPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/guests/:id"
            element={
              <ProtectedRoute deniedRoles={[...TEKNIK_BLOCKED]}>
                <GuestDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/guests/:id/edit"
            element={
              <ProtectedRoute allowedRoles={[...GUEST_WRITERS]}>
                <GuestFormPage />
              </ProtectedRoute>
            }
          />

          {/* Reservations */}
          <Route path="/reservations" element={<ReservationsListPage />} />
          <Route
            path="/reservations/calendar"
            element={
              <ProtectedRoute deniedRoles={[...TEKNIK_BLOCKED]}>
                <ReservationsCalendarPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reservations/availability"
            element={
              <ProtectedRoute deniedRoles={[...TEKNIK_BLOCKED]}>
                <ReservationsAvailabilityPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reservations/new"
            element={
              <ProtectedRoute allowedRoles={[...RESERVATION_WRITERS]}>
                <ReservationFormPage />
              </ProtectedRoute>
            }
          />
          <Route path="/reservations/:id" element={<ReservationDetailPage />} />
          <Route
            path="/reservations/:id/edit"
            element={
              <ProtectedRoute allowedRoles={[...RESERVATION_WRITERS]}>
                <ReservationFormPage />
              </ProtectedRoute>
            }
          />

          {/* Finance — general kasa (one cash pot). Reception/Housekeeping are RLS-blocked. */}
          <Route
            path="/finance/cash"
            element={
              <ProtectedRoute allowedRoles={[...FINANCE_ACCESS]}>
                <CashPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/finance/expenses"
            element={
              <ProtectedRoute allowedRoles={[...EXPENSE_WRITERS]}>
                <ExpensesListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/finance/expenses/new"
            element={
              <ProtectedRoute allowedRoles={[...EXPENSE_WRITERS]}>
                <ExpenseFormPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/finance/expenses/:id/edit"
            element={
              <ProtectedRoute allowedRoles={[...FINANCE_ACCESS]}>
                <ExpenseFormPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/finance/staff"
            element={
              <ProtectedRoute allowedRoles={[...FINANCE_ACCESS]}>
                <StaffListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/finance/staff/:userId"
            element={
              <ProtectedRoute allowedRoles={[...FINANCE_ACCESS]}>
                <StaffDetailPage />
              </ProtectedRoute>
            }
          />

          {/* Borçlar — reservations with an outstanding balance (collected < total) */}
          <Route
            path="/finance/debts"
            element={
              <ProtectedRoute allowedRoles={[...FINANCE_ACCESS]}>
                <DebtorsPage />
              </ProtectedRoute>
            }
          />

          {/* Bölgeler — region admin. Creating a region also creates its kasa,
              so this stays Yönetici-only (mirrors role/region assignment). */}
          <Route
            path="/finance/regions"
            element={
              <ProtectedRoute allowedRoles={['SUPER_ADMIN']}>
                <RegionsPage />
              </ProtectedRoute>
            }
          />

          {/* Payment approvals queue (Phase 3C-lite) — managers approve/dispute housekeeping-collected payments */}
          <Route
            path="/finance/pending"
            element={
              <ProtectedRoute allowedRoles={[...FINANCE_ACCESS]}>
                <PendingPaymentsPage />
              </ProtectedRoute>
            }
          />

          {/* Housekeeping (Phase 3A) — visible to housekeeping role + managers + admins */}
          <Route
            path="/housekeeping"
            element={
              <ProtectedRoute allowedRoles={[...HOUSEKEEPING_ACCESS]}>
                <HousekeepingPage />
              </ProtectedRoute>
            }
          />

          {/* WhatsApp message templates (Phase 3D) — managers + admins manage; all roles can READ via RLS to use in modals */}
          <Route
            path="/settings/templates"
            element={
              <ProtectedRoute allowedRoles={[...FINANCE_ACCESS]}>
                <TemplatesPage />
              </ProtectedRoute>
            }
          />

          {/* Çöp Kutusu — recoverable deletes (SUPER_ADMIN only; RLS-gated server-side too) */}
          <Route
            path="/settings/trash"
            element={
              <ProtectedRoute allowedRoles={['SUPER_ADMIN']}>
                <TrashPage />
              </ProtectedRoute>
            }
          />

          {/* Yedekler — browsable cloud backups (SUPER_ADMIN only; the backups
              bucket's RLS is SUPER_ADMIN-SELECT-only too, migration 129) */}
          <Route
            path="/settings/backups"
            element={
              <ProtectedRoute allowedRoles={['SUPER_ADMIN']}>
                <BackupsPage />
              </ProtectedRoute>
            }
          />

          {/* Denetim Kaydı — read-only audit log (SUPER_ADMIN only; RLS also allows PROPERTY_MANAGER but UI restricts further) */}
          <Route
            path="/settings/audit"
            element={
              <ProtectedRoute allowedRoles={['SUPER_ADMIN']}>
                <AuditLogPage />
              </ProtectedRoute>
            }
          />

        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
