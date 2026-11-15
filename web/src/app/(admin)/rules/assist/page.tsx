import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { ruleRefs } from "@/lib/rules";
import { interpretText, saveRule } from "@/app/actions";
import { AssistPanel } from "@/components/assist-panel";
import { PageHeader } from "@/components/ui/misc";

export default async function Assist() {
  const s = await requireAdmin();
  const { refs } = await ruleRefs(s.programId);
  return (
    <>
      <PageHeader title="Other restrictions" description="Type a restriction the way you would say it. It is turned into a proposed rule for you to check, change and confirm. Nothing is saved until you confirm.">
        <Link href="/rules" className="text-sm text-brand hover:underline">← All rules</Link>
      </PageHeader>
      <AssistPanel refs={refs} interpret={interpretText} save={saveRule.bind(null, null)} />
    </>
  );
}
