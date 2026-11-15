import { cn } from "@/lib/util";

const tones = {
  gray: "bg-slate-100 text-slate-700",
  green: "bg-emerald-50 text-emerald-800",
  amber: "bg-amber-50 text-amber-800",
  red: "bg-red-50 text-red-700",
  blue: "bg-sky-50 text-sky-800",
  brand: "bg-brand-soft text-brand-dark",
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = "gray", className, children, ...p }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", tones[tone], className)} {...p}>{children}</span>;
}
export function Card({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-white", className)} {...p}>{children}</div>;
}
export function PageHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
export function Notice({ tone = "blue", children }: { tone?: Tone; children: React.ReactNode }) {
  return <div className={cn("mb-4 rounded-md px-3 py-2 text-sm", tones[tone])}>{children}</div>;
}
export const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted";
export const td = "px-3 py-2 align-top text-sm";
