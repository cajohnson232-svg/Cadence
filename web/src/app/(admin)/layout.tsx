import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { signOut } from "@/app/actions";
import { Nav } from "@/components/nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const s = await requireAdmin();
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-line bg-white px-3 py-4">
        <div className="mb-5 px-2.5">
          <div className="text-lg font-semibold tracking-tight text-brand-dark">Cadence</div>
          <div className="text-xs text-muted">{s.programName}</div>
        </div>
        <Nav owner={s.access === "ADMIN"} />
        <div className="mt-6 border-t border-line px-2.5 pt-3 text-xs text-muted">
          <div className="font-medium text-ink">{s.userName}</div>
          <div>{s.access === "ADMIN" ? "Administrator" : "Chief"}</div>
          <div className="mt-1 flex gap-3">
            <Link href="/account" className="text-brand hover:underline">Your account</Link>
            <form action={signOut}><button className="text-brand hover:underline">Sign out</button></form>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
    </div>
  );
}
