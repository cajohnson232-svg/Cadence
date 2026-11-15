"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/util";

const GROUPS: { title: string; items: [string, string][] }[] = [
  { title: "Setup", items: [["/institutions", "Institutions"], ["/roles", "Roles"], ["/participants", "Participants"], ["/shifts", "Shifts"], ["/categories", "Shift categories"]] },
  { title: "Schedule", items: [["/intervals", "Intervals"], ["/assignments", "Assignments"], ["/special-days", "Special Staffing Days"]] },
  { title: "Time Off & Preferences", items: [["/academic-days", "Academic Days"], ["/vacation", "Vacation"], ["/requests", "Requests Off"], ["/adjustments", "Adjustments"]] },
  { title: "Rules", items: [["/rules", "Rules"], ["/rules/assist", "Other Restrictions"]] },
];

export function Nav({ owner }: { owner: boolean }) {
  const path = usePathname();
  const current = [...GROUPS.flatMap((g) => g.items), ["/settings", ""], ["/access", ""]].map(([h]) => h).filter((h) => path === h || path.startsWith(h + "/")).sort((a, b) => b.length - a.length)[0];
  const link = (href: string, label: string) => (
    <Link key={href} href={href} aria-current={current === href ? "page" : undefined}
      className={cn("block rounded-md px-2.5 py-1.5 text-sm", current === href ? "bg-brand-soft font-medium text-brand-dark" : "text-ink/80 hover:bg-surface")}>
      {label}
    </Link>
  );
  return (
    <nav aria-label="Main" className="space-y-5">
      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.title}</div>
          {g.items.map(([href, label]) => link(href, label))}
        </div>
      ))}
      <div className="border-t border-line pt-3">
        {link("/settings", "Program settings")}
        {owner && link("/access", "Sign-in & access")}
      </div>
    </nav>
  );
}
