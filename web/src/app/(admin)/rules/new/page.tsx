import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { ruleRefs } from "@/lib/rules";
import { emptyDraft } from "@/lib/rule-types";
import { saveRule } from "@/app/actions";
import { RuleForm } from "@/components/rule-form";
import { Card, PageHeader } from "@/components/ui/misc";

export default async function NewRule() {
  const s = await requireAdmin();
  const { refs } = await ruleRefs(s.programId);
  return (
    <>
      <PageHeader title="New rule" description="Pick a template and fill in its details. Can't find one that fits? Describe it in plain English instead.">
        <Link href="/rules" className="text-sm text-brand hover:underline">← All rules</Link>
      </PageHeader>
      <Card className="max-w-4xl p-5"><RuleForm action={saveRule.bind(null, null)} initial={emptyDraft()} refs={refs} cancelHref="/rules" /></Card>
    </>
  );
}
