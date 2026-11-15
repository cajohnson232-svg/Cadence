// The unified rule list: hard and soft, every scope, one screen.
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { ruleRefs } from "@/lib/rules";
import { TEMPLATE, TEMPLATES, engineStatus, ruleText } from "@/lib/rule-templates";
import { toggleRule } from "@/app/actions";
import { Flash } from "@/components/entity-pages";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge, Card, PageHeader, td, th, type Tone } from "@/components/ui/misc";
import { cn, ymd } from "@/lib/util";

const engineTone: Record<string, Tone> = { enforced: "green", "stored only": "gray", "needs review": "amber" };
const SCOPE = { PROGRAM: "Whole program", INSTITUTION: "Institution", ROLE: "Role", PARTICIPANT: "Participant" } as const;

export default async function RulesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const { names } = await ruleRefs(s.programId);
  const all = await db.rule.findMany({
    where: { programId: s.programId, archivedAt: null },
    orderBy: [{ level: "asc" }, { priority: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  const rows = all.map((r) => {
    const target = r.scope === "PROGRAM" ? "Whole program" : names[(r.institutionId ?? r.roleId ?? r.participantId)!] ?? "?";
    return { r, target, text: ruleText(r.template, r.params, names), ...engineStatus(r) };
  }).filter(({ r, text, target, status }) => {
    const q = sp.q?.toLowerCase();
    if (q && ![text, target, r.notes ?? "", r.originalText ?? "", TEMPLATE[r.template]?.label ?? ""].some((x) => x.toLowerCase().includes(q))) return false;
    if (sp.scope && r.scope !== sp.scope) return false;
    if (sp.level && r.level !== sp.level) return false;
    if (sp.engine && status !== sp.engine) return false;
    if (sp.group && TEMPLATE[r.template]?.group !== sp.group) return false;
    return true;
  });
  const filtered = ["q", "scope", "level", "engine", "group"].some((k) => sp[k]);
  const groups = [...new Set(TEMPLATES.map((t) => t.group))];
  return (
    <>
      <PageHeader title="Rules" description="Every constraint and preference in one place. Hard rules must never be violated; soft rules are goals the engine works through in priority order. Vacations, requests off and academic days become rules automatically for each interval (see an interval's Compiled rules tab).">
        <Link href="/rules/assist" className={buttonVariants({ variant: "outline" })}>Describe in plain English</Link>
        <Link href="/rules/new" className={buttonVariants()}>New rule</Link>
      </PageHeader>
      <Flash sp={sp} />
      <form className="mb-3 flex flex-wrap items-center gap-2" role="search">
        <Input name="q" defaultValue={sp.q} placeholder="Search rules…" className="w-56" aria-label="Search" />
        <Select name="scope" defaultValue={sp.scope ?? ""} className="w-auto" aria-label="Scope"><option value="">All: scope</option>{Object.entries(SCOPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Select name="level" defaultValue={sp.level ?? ""} className="w-auto" aria-label="Level"><option value="">All: hard and soft</option><option value="HARD">Hard</option><option value="SOFT">Soft</option></Select>
        <Select name="group" defaultValue={sp.group ?? ""} className="w-auto" aria-label="Kind"><option value="">All: kinds</option>{groups.map((g) => <option key={g} value={g}>{g}</option>)}</Select>
        <Select name="engine" defaultValue={sp.engine ?? ""} className="w-auto" aria-label="Engine"><option value="">All: engine status</option><option value="enforced">Enforced</option><option value="stored only">Stored only</option><option value="needs review">Needs review</option></Select>
        <Button variant="outline" size="sm">Filter</Button>
        {filtered && <Link href="/rules" className="text-sm text-brand hover:underline">Clear</Link>}
        <span className="ml-auto text-sm text-muted">{rows.length} of {all.length} rules</span>
      </form>
      <Card className="overflow-x-auto">
        <table className="w-full" data-testid="rules-table">
          <thead className="border-b border-line bg-surface"><tr>{["Rule", "Applies to", "Level", "Active", "Source", "Engine", ""].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ r, target, text, status }) => (
              <tr key={r.id} className={cn(!r.enabled && "opacity-55")}>
                <td className={td}>
                  <Link href={`/rules/${r.id}`} className="font-medium text-brand hover:underline">{text}</Link>
                  <div className="text-xs text-muted">{TEMPLATE[r.template]?.label ?? r.template}{r.notes ? ` · ${r.notes}` : ""}</div>
                  {r.originalText && r.originalText !== text && <div className="text-xs italic text-muted">“{r.originalText}”</div>}
                </td>
                <td className={td}>{target}{r.scope !== "PROGRAM" && <div className="text-xs text-muted">{SCOPE[r.scope]}</div>}</td>
                <td className={cn(td, "whitespace-nowrap")}>
                  {r.level === "HARD" ? <Badge tone="red">Hard</Badge> : <Badge tone="blue">Soft</Badge>}
                  {r.level === "SOFT" && <div className="text-xs text-muted">priority {r.priority ?? "—"} · weight {r.weight}</div>}
                </td>
                <td className={cn(td, "whitespace-nowrap text-xs text-muted")}>{r.activeFrom || r.activeTo ? `${r.activeFrom ? ymd(r.activeFrom) : "…"} to ${r.activeTo ? ymd(r.activeTo) : "…"}` : "Always"}</td>
                <td className={td}>{r.source === "SYSTEM" ? <Badge>System</Badge> : r.source === "AI_ASSISTED" ? <Badge tone="blue">AI-assisted</Badge> : <span className="text-xs text-muted">Manual</span>}</td>
                <td className={td}><Badge tone={engineTone[status]}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge></td>
                <td className={td}><form action={toggleRule.bind(null, r.id, !r.enabled)}><button className="whitespace-nowrap rounded border border-line bg-white px-1.5 py-0.5 text-xs hover:bg-surface">{r.enabled ? "Switch off" : "Switch on"}</button></form></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-muted">{filtered ? "Nothing matches." : "No rules yet."}</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}
