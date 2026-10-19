export interface GymRef {
  id: number;
  name: string;
  role: 'owner' | 'staff';
}

export const ROLE_LABEL: Record<'owner' | 'staff', string> = { owner: 'Sahip', staff: 'Çalışan' };

export interface Me {
  id: number;
  name: string;
  email: string;
  gyms: GymRef[];
}

export interface Summary {
  id: number;
  name: string;
  role: string;
  stats: {
    activeMembers: number;
    totalMembers: number;
    entriesLast24h: number;
    gatesOnline: number;
    gatesTotal: number;
  };
}

export interface Plan {
  id: number;
  name: string;
  days: number;
  priceCents: number;
}

export interface Member {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  active: boolean;
  membershipEndsAt: string | null;
  hasActiveMembership: boolean;
  lastVisitAt: string | null;
}

export interface MemberDetail {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  active: boolean;
  joinedAt: string;
  memberships: { id: number; plan: string; assignedAt: string; endsAt: string; status: 'active' | 'ended' }[];
  stats: { visits: number; visitsLast30: number; denied: number; lastVisitAt: string | null };
}

export interface Entry {
  id: number;
  at: string;
  allowed: boolean;
  reason: string | null;
  gateId: string;
  gateName: string | null;
  userId: number;
  memberName: string;
}

export interface EntrySummary {
  allowed: number;
  denied: number;
  uniqueMembers: number;
  total: number;
  byDay: { day: string; allowed: number; denied: number }[];
}

export interface Gate {
  id: string;
  name: string;
  online: boolean;
}

export type Role = 'owner' | 'staff';

export interface StaffMember {
  userId: number;
  name: string;
  email: string;
  role: Role;
}

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  actorName: string;
}

export interface NewGate {
  id: string;
  name: string;
  key: string;
}
