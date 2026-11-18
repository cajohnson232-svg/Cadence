// Assignments: one line per participant (not per participant per interval). Choose a person to set up
// their interval: institutions, adjustments, time off and preferences.
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Flash } from "@/components/entity-pages";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageHeader, td, th } from "@/components/ui/misc";
import { cn } from "@/lib/util";

type SP = Record<string, string | undefined>;

export default async function Assignments({ searchParams }: { searchParams: Promise<SP> }) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const [roles, intervals, people] = await Promise.all([
    db.role.findMany({ where: { programId: s.programId, archivedAt: null }, orderBy: [{ level: "asc" }, { name: "asc" }] }),
    db.interval.findMany({ where: { programId: s.programId }, orderBy: { startDate: "desc" } }),
    db.participant.findMany({
      where: { programId: s.programId, archivedAt: null, ...(sp.role ? { roleId: sp.role } : {}),
        ...(sp.q ? { OR: [{ firstName: { contains: sp.q, mode: "insensitive" as const } }, { lastName: { contains: sp.q, mode: "insensitive" as const } }] } : {}) },
      include: { role: true, assignments: { select: { startDate: true, endDate: true } } },
    }),
  ]);
  const sort = sp.sort === "first" ? "first" : "last";
  people.sort((a, b) => sort === "first"
    ? a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName)
    : a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  const current = intervals.find((i) => i.status !== "PUBLISHED") ?? intervals[0];
  const inIv = (p: (typeof people)[number], iv: (typeof intervals)[number]) => p.assignments.some((a) => a.startDate <= iv.endDate && a.endDate >= iv.startDate);
  const recent = intervals.slice(0, 4).reverse();
  return (
    <>
      <PageHeader title="Assignments" description="Choose a participant to set up an interval for them: where they work, extra or fewer shifts, required time off, no nights, personal academic days and notes. Shift counts and eligible shifts come from their role." />
      <Flash sp={sp} />
      <form className="mb-4 flex flex-wrap items-end gap-3" data-testid="assignment-filters">
        <label className="text-sm"><span className="mb-1 block font-medium">Search</span><Input name="q" defaultValue={sp.q ?? ""} placeholder="Name" className="w-56" /></label>
        <label className="text-sm"><span className="mb-1 block font-medium">Role</span>
          <Select name="role" defaultValue={sp.role ?? ""} className="w-48"><option value="">All roles</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></label>
        <label className="text-sm"><span className="mb-1 block font-medium">Sort by</span>
          <Select name="sort" defaultValue={sort} className="w-40"><option value="last">Last name</option><option value="first">First name</option></Select></label>
        <Button variant="outline">Show</Button>
      </form>
      <Card className="overflow-x-auto">
        <table className="w-full" data-testid="assignment-people">
          <thead className="border-b border-line bg-surface"><tr>
            <th className={th}>Participant</th><th className={th}>Role</th>
            {recent.map((iv) => <th key={iv.id} className={cn(th, "text-center")}>{iv.name}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-line">
            {people.map((p) => (
              <tr key={p.id} className={cn(!p.active && "text-muted")}>
                <td className={td}>
                  <Link href={`/assignments/${p.id}${current ? `?interval=${current.id}` : ""}`} className="font-medium text-brand hover:underline">
                    {sort === "first" ? `${p.firstName} ${p.lastName}` : `${p.lastName}, ${p.firstName}`}
                  </Link>{!p.active && <Badge className="ml-2">Inactive</Badge>}
                </td>
                <td className={td}>{p.role.name}</td>
                {recent.map((iv) => (
                  <td key={iv.id} className={cn(td, "text-center")}>
                    <Link href={`/assignments/${p.id}?interval=${iv.id}`} className="hover:underline">
                      {inIv(p, iv) ? <Badge tone="green">Assigned</Badge> : <span className="text-xs text-muted">–</span>}
                    </Link>
                  </td>
                ))}
              </tr>
            ))}
            {!people.length && <tr><td colSpan={2 + recent.length} className="px-3 py-6 text-center text-sm text-muted">Nobody matches. Add people under Participants.</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}
