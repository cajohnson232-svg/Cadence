"use client";
// Follows an engine run: asks the server every two seconds what the engine is doing, and opens
// the result as soon as it has been imported. The run itself does not depend on this page being open.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clockTime } from "@/lib/schedule-view";

export type Progress = { status: string; phase: string; open: number | null; elapsed: number; budget: number };

export function RunProgress({ statusUrl, reviewUrl, initial }: { statusUrl: string; reviewUrl: string; initial: Progress }) {
  const router = useRouter();
  const [p, setP] = useState({ ...initial, at: Date.now() });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      try {
        const r = await fetch(statusUrl, { cache: "no-store" });
        if (stopped) return;
        if (r.ok && r.headers.get("content-type")?.includes("json")) {
          const j: Progress = await r.json();
          setP({ ...j, at: Date.now() });
          if (j.status === "DONE") return router.replace(reviewUrl);
          if (j.status !== "RUNNING" && j.status !== "QUEUED") return router.refresh();
        }
      } catch { /* a dropped request: just ask again */ }
      if (!stopped) timer = setTimeout(ask, 2000);
    };
    timer = setTimeout(ask, 1200);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; clearTimeout(timer); clearInterval(clock); };
  }, [statusUrl, reviewUrl, router]);

  const elapsed = p.elapsed + Math.max(0, (now - p.at) / 1000);
  const pct = p.budget ? Math.min(100, (elapsed / p.budget) * 100) : 0;
  return (
    <div data-testid="run-progress" data-status={p.status}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium" aria-live="polite">{p.status === "DONE" ? "Opening the schedule…" : `${p.phase}…`}</p>
        <p className="text-xs tabular-nums text-muted">
          {clockTime(elapsed)}{p.budget ? ` of up to about ${clockTime(p.budget)}` : ""}
          {p.open !== null ? ` · ${p.open} shift${p.open === 1 ? "" : "s"} open so far` : ""}
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Time used">
        <div className="h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted">The bar shows time used, not how good the schedule is yet. You can leave this page; the run carries on and the result will be here when you come back.</p>
    </div>
  );
}
