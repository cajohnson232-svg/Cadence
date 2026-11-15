"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { FieldView, FormState, FormValues } from "@/lib/crud";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { DOW, cn } from "@/lib/util";

export function EntityForm({ action, fields, initial, cancelHref, submitLabel = "Save" }: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  fields: FieldView[];
  initial: FormValues;
  cancelHref: string;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const vals = state.values ?? initial;
  const one = (n: string) => (vals[n] as string) ?? "";
  const many = (n: string) => (vals[n] as string[]) ?? [];
  // start time + length -> "ends 07:00 the next day", worked out as you type
  const timed = fields.some((f) => f.name === "startMinute") && fields.some((f) => f.name === "durationMinutes");
  const endsText = (start: string, hours: string) => {
    const h = Number(hours);
    if (!/^\d{2}:\d{2}$/.test(start) || !hours || !Number.isFinite(h) || h <= 0) return "";
    const end = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + Math.round(h * 60);
    const hh = String(Math.floor((end % 1440) / 60)).padStart(2, "0"), mm = String(end % 60).padStart(2, "0");
    return `Ends ${hh}:${mm}${end > 1440 ? " the next day (crosses midnight)" : end === 1440 ? " (midnight)" : ""}`;
  };
  const [ends, setEnds] = useState(() => (timed ? endsText(one("startMinute"), one("durationMinutes")) : ""));
  const onChange = (e: React.FormEvent<HTMLFormElement>) => {
    if (!timed) return;
    const fd = new FormData(e.currentTarget);
    setEnds(endsText(String(fd.get("startMinute") ?? ""), String(fd.get("durationMinutes") ?? "")));
  };
  return (
    <form action={formAction} onChange={onChange} className="space-y-4" noValidate>
      {state.message && <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</div>}
      {/* Re-mounted after each failed save: the browser resets a form once its action finishes, and
          a <select> would otherwise fall back to its first-render choice instead of what was submitted. */}
      <div key={state.at ?? 0} className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        {fields.map((f) => {
          const err = state.errors?.[f.name];
          const wide = f.type === "textarea" || f.type === "multi" || f.type === "weekdays" || f.type === "checkbox";
          const common = { id: f.name, name: f.name, "aria-invalid": !!err, className: err ? "border-red-400" : undefined };
          return (
            <div key={f.name} className={cn(wide && "sm:col-span-2")}>
              {f.type === "checkbox" ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name={f.name} defaultChecked={one(f.name) === "on"} className="mt-0.5 size-4 accent-[var(--color-brand)]" />
                  <span>{f.label}</span>
                </label>
              ) : (
                <>
                  <Label htmlFor={f.name}>{f.label}{f.required && <span className="text-red-600"> *</span>}</Label>
                  {f.type === "textarea" ? <Textarea {...common} defaultValue={one(f.name)} placeholder={f.placeholder} />
                  : f.type === "select" ? (
                    <Select {...common} defaultValue={one(f.name)}>
                      {[{ value: "", label: f.required ? "Choose…" : "—" }, ...(f.options ?? [])].map((o) => (
                        <option key={"o" + o.value} value={o.value}>{o.label}</option>
                      ))}
                    </Select>
                  ) : f.type === "multi" ? (
                    <div className="grid gap-x-4 gap-y-1 rounded-md border border-line bg-white p-3 sm:grid-cols-2">
                      {f.options?.map((o) => (
                        <label key={o.value} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" name={f.name} value={o.value} defaultChecked={many(f.name).includes(o.value)} className="size-4 accent-[var(--color-brand)]" />
                          {o.label}
                        </label>
                      ))}
                      {!f.options?.length && <span className="text-sm text-muted">Nothing to choose from yet.</span>}
                    </div>
                  ) : f.type === "weekdays" ? (
                    <div className="flex flex-wrap gap-1.5">
                      {DOW.map((d, i) => (
                        <label key={d} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-white px-2.5 py-1.5 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
                          <input type="checkbox" name={f.name} value={i} defaultChecked={many(f.name).includes(String(i))} className="size-3.5 accent-[var(--color-brand)]" />
                          {d}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <Input {...common} defaultValue={one(f.name)} placeholder={f.placeholder}
                      type={f.type === "datetime" ? "datetime-local" : f.type === "hours" ? "number" : f.type}
                      min={f.min} max={f.max} step={f.step ?? (f.type === "hours" ? 0.25 : undefined)} />
                  )}
                </>
              )}
              {timed && f.name === "durationMinutes" && ends && !err && <p className="mt-1 text-xs font-medium text-brand-dark" data-testid="ends">{ends}</p>}
              {f.help && !err && <p className="mt-1 text-xs text-muted">{f.help}</p>}
              {err && <p className="mt-1 text-xs font-medium text-red-700">{err}</p>}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : submitLabel}</Button>
        <Link href={cancelHref} className={buttonVariants({ variant: "ghost" })}>Cancel</Link>
      </div>
    </form>
  );
}
