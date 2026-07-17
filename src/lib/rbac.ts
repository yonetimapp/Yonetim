import type { Role, PropertyType } from '@/types/database';

/**
 * RBAC permission checks. These MUST be mirrored on the server side
 * (RLS policies + Edge Function checks). The client side checks here
 * are for UX only — they hide UI but cannot enforce security.
 */

export type Permission =
  | 'reservation:create'
  | 'reservation:read'
  | 'reservation:update'
  | 'reservation:cancel'
  | 'reservation:delete'
  | 'guest:read'
  | 'guest:create'
  | 'guest:update'
  | 'guest:delete'
  | 'finance:read'
  | 'finance:write'
  | 'staff:read'
  | 'staff:write'
  | 'housekeeping:read'
  | 'housekeeping:write'
  // Report / resolve housekeeping issues. Split from housekeeping:write so a
  // technical role can file issues WITHOUT being able to change cleaning status.
  | 'issue:write'
  | 'payment:collect'
  | 'report:property'
  | 'report:all'
  | 'admin:*';

// A (property) manager's permission set for PROPERTY_MANAGER. Region access is a
// separate per-user assignment (all_regions flag + home region), not a role.
const MANAGER_PERMS: Permission[] = [
  'reservation:create',
  'reservation:read',
  'reservation:update',
  'reservation:cancel',
  'reservation:delete',
  'guest:read',
  'guest:create',
  'guest:update',
  'finance:read',
  'finance:write',
  'staff:read',
  'staff:write',
  'housekeeping:read',
  'housekeeping:write',
  'issue:write',
  'payment:collect',
  'report:property',
];

// A branch operator's permission set for YETKILI. Region access is a separate
// per-user assignment, not baked into the role.
const PERSONEL_PERMS: Permission[] = [
  'reservation:create',
  'reservation:read',
  'reservation:update',
  'reservation:cancel',
  'reservation:delete',
  'guest:read',
  'guest:create',
  'guest:update',
  'housekeeping:read',
  'housekeeping:write',
  'issue:write',
  'payment:collect',
  'report:property',
];

const BASE: Record<Role, Permission[]> = {
  SUPER_ADMIN: ['admin:*'],
  PROPERTY_MANAGER: MANAGER_PERMS,
  RECEPTION: [
    'reservation:create',
    'reservation:read',
    'reservation:update',
    'reservation:cancel',
    'reservation:delete',
    'guest:read',
    'guest:create',
    'guest:update',
  ],
  HOUSEKEEPING: ['housekeeping:read', 'housekeeping:write', 'issue:write'],
  // New-signup holding role. Zero permissions and in no RLS allow-list — the
  // account is inert until a SUPER_ADMIN promotes it to a real role.
  PENDING: [],
  // Branch operator — full operations within own branch, no finance/staff/admin.
  // Payment collection is allowed; the DB RPC creates UNCONFIRMED rows that a
  // manager confirms (since YETKILI has no finance:write).
  YETKILI: PERSONEL_PERMS,
  // Technical staff — deliberately narrow: read-only reservation Liste + issue
  // reporting only, across ALL regions. No cleaning-status write, no finance /
  // guest-PII / property / staff. Server: auth_role() → HOUSEKEEPING with an
  // all-property bypass in auth_sees_property. Migrations 114 + 117.
  TEKNIK_PERSONEL: ['housekeeping:read', 'issue:write', 'reservation:read'],
};

/**
 * Retained as an identity passthrough. Region-scoped role *variants* no longer
 * exist (region is a per-user assignment now), so a role already IS its base
 * role. Kept so the many `baseRole(profile?.role)` call sites stay stable.
 */
export function baseRole(role: Role | undefined): Role | undefined {
  return role;
}

export function can(role: Role, permission: Permission): boolean {
  if (role === 'SUPER_ADMIN') return true;
  return BASE[role].includes(permission);
}

/**
 * Whether the user's data spans every region — the client mirror of the DB's
 * auth_all_regions() (migration 125): SUPER_ADMIN, or the data-driven
 * `all_regions` flag on their staff_profiles row.
 *
 * Region access is not implied by the role, so region-filter UI must gate on
 * THIS, never on `role === 'PROPERTY_MANAGER'`: a region-scoped manager sees
 * exactly one region's rows (RLS), and offering them a region switcher would
 * just let them filter their way to an empty list.
 */
export function seesAllRegions(
  profile: { role: Role; all_regions: boolean } | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === 'SUPER_ADMIN' || profile.all_regions === true;
}

/**
 * Teknik Personel is a deliberately narrow role (read-only reservation Liste +
 * issue reporting, across all regions). This flags it so the few UI surfaces it
 * must NOT see — guest/property nav, availability/calendar tools, the Kirli
 * Daireler tile — can hide them without each re-listing the role literal.
 */
export function isTeknikPersonel(role: Role | undefined): boolean {
  return role === 'TEKNIK_PERSONEL';
}

/**
 * Property-type-conditional permissions.
 * The most important: housekeepers collect payment ONLY in APARTMENT properties.
 * Reception collects payment ONLY in HOTEL properties.
 */
export function canCollectPayment(role: Role, propertyType: PropertyType): boolean {
  const r = baseRole(role);
  if (r === 'SUPER_ADMIN' || r === 'PROPERTY_MANAGER') return true;
  if (r === 'YETKILI') return true; // both property types
  if (r === 'RECEPTION' && propertyType === 'HOTEL') return true;
  if (r === 'HOUSEKEEPING' && propertyType === 'APARTMENT') return true;
  return false;
}
