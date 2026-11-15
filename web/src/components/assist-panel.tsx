"use client";

// Plain English on the left, the proposed structured rule on the right. Saving needs an explicit click.
import { useState, useTransition } from "react";
import type { Proposal } from "@/lib/rule-interpreter";
import { emptyDraft, type RuleDraft, type RuleFormState, type RuleRefs } from "@/lib/rule-types";
import { RuleForm } from "./rule-form";
import { Button } from "./ui/button";
import { Label, Textarea } from "./ui/input";
import { Card } from "./ui/misc";

type Result = { proposal: Proposal; interpreter: string } | { error: string };
const EXAMPLES = [
  "Dr. Kim can't work overnights at LBJ from Jan 10 to Jan 24",
  "Dr. Nguyen cannot work Thursdays",
  "PGY-1s should have no more than 5 nights",
  "Chen must not work with Diaz",
  "Try to keep Dr. Lee off the Sunday before boards",
];

export function AssistPanel({ refs, interpret, save }: {
  refs: RuleRefs;
  interpret: (text: string) => Promise<Result>;
  save: (prev: RuleFormState, fd: FormData) => Promise<RuleFormState>;
}) {
  const [text, setText] = useState("");
  const [res, setRes] = useState<{ proposal: Proposal; interpreter: string; text: string; n: number } | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const run = () => start(async () => {
    const r = await interpret(text);
    if ("error" in r) { setError(r.error); setRes(null); } else { setError(""); setRes({ ...r, text: text.trim(), n: (res?.n ?? 0) + 1 }); }
  });
  const draft = (p: Proposal, original: string): RuleDraft => ({
    ...emptyDraft(), scope: p.scope, institutionId: p.institutionId ?? "", roleId: p.roleId ?? "", participantId: p.participantId ?? "",
    template: p.template, params: p.params, level: p.level, weight: String(p.weight ?? 5), activeFrom: p.activeFrom ?? "", activeTo: p.activeTo ?? "",
    notes: p.notes, needsReview: p.needsReview, originalText: original, source: "AI_ASSISTED",
  });
  return (
    <div className="space-y-5">
      <Card className="max-w-4xl p-5">
        <Label htmlFor="restriction">Restriction, in plain English</Label>
        <Textarea id="restriction" value={text} onChange={(e) => setText(e.target.value)} placeholder="Dr. Patel can't work overnights at County during her second trimester, Jan–Mar" className="min-h-24" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" onClick={run} disabled={pending || !text.trim()}>{pending ? "Reading…" : res ? "Read it again" : "Turn into a rule"}</Button>
          <span className="text-xs text-muted">Try:</span>
          {EXAMPLES.map((e) => <button key={e} type="button" onClick={() => setText(e)} className="rounded border border-line bg-white px-1.5 py-0.5 text-xs text-muted hover:bg-surface">{e}</button>)}
        </div>
        {error && <p role="alert" className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      </Card>
      {res && (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" data-testid="proposal">
          <Card className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">What you wrote</h2>
            <blockquote className="mt-2 border-l-2 border-brand pl-3 text-[15px]" data-testid="original-text">{res.text}</blockquote>
            <h2 className="mt-5 text-sm font-semibold uppercase tracking-wide text-muted">How it was read</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{res.proposal.explanation.map((x, i) => <li key={i}>{x}</li>)}</ul>
            <p className="mt-4 text-xs text-muted">Interpreter: {res.interpreter}. Your original wording is saved with the rule.</p>
          </Card>
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Proposed rule: check and change anything before saving</h2>
            {res.proposal.needsReview && <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">This could not be matched to a template, so it is proposed as a custom rule flagged for manual review. Pick a template yourself if one fits.</div>}
            <RuleForm key={res.n} action={save} initial={draft(res.proposal, res.text)} refs={refs} cancelHref="/rules" submitLabel="Confirm and save rule" />
          </Card>
        </div>
      )}
    </div>
  );
}
