// Sign-in & access: administrators only.
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { AccessManager, type Person, type Waiting } from "@/components/access-manager";
import { PageHeader } from "@/components/ui/misc";

export default async function Access() {
  const s = await requireOwner();
  const [program, members, participants] = await Promise.all([
    db.program.findUniqueOrThrow({ where: { id: s.programId } }),
    db.membership.findMany({ where: { programId: s.programId }, include: { user: { include: { accessLinks: { where: { usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 1 } } }, participant: true } }),
    db.participant.findMany({ where: { programId: s.programId, archivedAt: null, active: true }, include: { role: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] }),
  ]);
  const order = { ADMIN: 0, CHIEF: 1, RESIDENT: 2 } as const;
  const people: Person[] = members
    .sort((a, b) => order[a.access] - order[b.access] || a.user.name.localeCompare(b.user.name))
    .map((m) => ({
      membershipId: m.id, userId: m.userId, name: m.user.name, email: m.user.email, access: m.access,
      participant: m.participant ? `${m.participant.firstName} ${m.participant.lastName}` : null,
      hasPassword: !!m.user.passwordHash, disabled: !!m.user.disabledAt, lastLogin: m.user.lastLoginAt?.toISOString() ?? null,
      linkExpires: m.user.accessLinks[0]?.expiresAt.toISOString() ?? null, isYou: m.userId === s.userId,
    }));
  const linked = new Set(members.map((m) => m.participantId).filter(Boolean));
  const waiting: Waiting[] = participants.filter((p) => !linked.has(p.id)).map((p) => ({ participantId: p.id, name: `${p.firstName} ${p.lastName}`, role: p.role.name, email: p.email }));
  return (
    <>
      <PageHeader title="Sign-in & access" description="Nobody can sign in unless you invite them here. You make a one-time link for each person and send it to them yourself; they choose their own password." />
      <AccessManager people={people} waiting={waiting} timezone={program.timezone} />
    </>
  );
}
