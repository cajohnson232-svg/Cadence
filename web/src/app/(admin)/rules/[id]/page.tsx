import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { rowToDraft, ruleRefs } from "@/lib/rules";
import { removeRule, saveRule } from "@/app/actions";
import { Flash } from "@/components/entity-pages";
import { RuleForm } from "@/components/rule-form";
import { Button } from "@/components/ui/button";
import { Card, Notice, PageHeader } from "@/components/ui/misc";

export default async function EditRule({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireAdmin();
  const { id } = await params;
  const r = await db.rule.findFirst({ where: { id, programId: s.programId }, include: { createdBy: true } });
  if (!r) notFound();
  const { refs } = await ruleRefs(s.programId);
  return (
    <>
      <PageHeader title="Edit rule" description={r.source === "SYSTEM" ? "A system rule: one of the limits and goals every program starts with. You can change its numbers or switch it off, but not delete it." : undefined}>
        <Link href="/rules" className="text-sm text-brand hover:underline">← All rules</Link>
      </PageHeader>
      <Flash sp={await searchParams} />
      {r.originalText && <Notice tone="blue"><span className="font-medium">Original wording, kept as written:</span> “{r.originalText}”</Notice>}
      <Card className="max-w-4xl p-5"><RuleForm action={saveRule.bind(null, id)} initial={rowToDraft(r)} refs={refs} cancelHref="/rules" /></Card>
      <div className="mt-6 flex max-w-4xl items-center gap-3 border-t border-line pt-4">
        {r.source !== "SYSTEM" && <form action={removeRule.bind(null, id)}><Button variant="danger" size="sm">Delete</Button></form>}
        <span className="text-xs text-muted">
          {r.source === "SYSTEM" ? "System rule" : r.source === "AI_ASSISTED" ? "Created from plain-English text and confirmed" : "Created"}
          {r.createdBy ? ` by ${r.createdBy.name}` : ""} on {r.createdAt.toISOString().slice(0, 10)}
        </span>
      </div>
    </>
  );
}
