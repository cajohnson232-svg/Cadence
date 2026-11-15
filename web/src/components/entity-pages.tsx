import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { ENTITIES } from "@/lib/entities";
import { resolveFields, rowToForm, searchWhere, type Row } from "@/lib/crud";
import { removeEntity, restoreEntity, saveEntity } from "@/app/actions";
import { EntityForm } from "./entity-form";
import { Button, buttonVariants } from "./ui/button";
import { Input, Select } from "./ui/input";
import { Card, Notice, PageHeader, td, th } from "./ui/misc";

type SP = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const model = (name: string) => (db as any)[name];

export function Flash({ sp }: { sp: SP }) {
  return <>{sp.notice && <Notice tone="green">{sp.notice}</Notice>}{sp.error && <Notice tone="red">{sp.error}</Notice>}</>;
}

export async function EntityListPage({ slug, sp }: { slug: string; sp: SP }) {
  const e = ENTITIES[slug];
  if (!e) notFound();
  const s = await requireAdmin();
  const ctx = { programId: s.programId, userId: s.userId };
  const and: object[] = [{ programId: s.programId }];
  if (e.where) and.push(e.where);
  if (e.archivable && sp.archived !== "1") and.push({ archivedAt: null });
  if (sp.q && e.search) and.push(searchWhere(e.search, sp.q));
  const filters = await Promise.all((e.filters ?? []).map(async (f) => ({ ...f, options: typeof f.options === "function" ? await f.options(ctx) : f.options })));
  for (const f of filters) if (sp[f.name]) and.push(f.where(sp[f.name]!));
  const rows: Row[] = await model(e.model).findMany({ where: { AND: and }, include: e.include, orderBy: e.orderBy, take: 500 });
  await e.decorate?.(rows, ctx);
  const filtered = !!sp.q || filters.some((f) => sp[f.name]) || sp.archived === "1";
  return (
    <>
      <PageHeader title={e.title} description={e.description}>
        <Link href={`/${slug}/new`} className={buttonVariants()}>New {e.singular}</Link>
      </PageHeader>
      <Flash sp={sp} />
      <form className="mb-3 flex flex-wrap items-center gap-2" role="search">
        {e.search && <Input name="q" defaultValue={sp.q} placeholder={`Search ${e.title.toLowerCase()}…`} className="w-64" aria-label="Search" />}
        {filters.map((f) => (
          <Select key={f.name} name={f.name} defaultValue={sp[f.name] ?? ""} className="w-auto" aria-label={f.label}>
            <option value="">All: {f.label.toLowerCase()}</option>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        ))}
        {e.archivable && <label className="flex items-center gap-1.5 text-sm text-muted"><input type="checkbox" name="archived" value="1" defaultChecked={sp.archived === "1"} /> Show archived</label>}
        <Button variant="outline" size="sm">Filter</Button>
        {filtered && <Link href={`/${slug}`} className="text-sm text-brand hover:underline">Clear</Link>}
        <span className="ml-auto text-sm text-muted">{rows.length} {rows.length === 1 ? e.singular : e.title.toLowerCase()}</span>
      </form>
      <Card className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-line bg-surface"><tr>{e.columns.map((c) => <th key={c.label} className={th}>{c.label}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className={r.archivedAt ? "opacity-60" : undefined}>
                {e.columns.map((c, i) => (
                  <td key={c.label} className={td}>
                    {i === 0 ? <Link href={e.rowHref?.(r) ?? `/${slug}/${r.id}`} className="font-medium text-brand hover:underline">{c.cell(r)}</Link> : c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && <tr><td className="px-3 py-8 text-center text-sm text-muted" colSpan={e.columns.length}>{filtered ? "Nothing matches." : `No ${e.title.toLowerCase()} yet.`}</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}

export async function EntityFormPage({ slug, id, sp }: { slug: string; id: string | null; sp: SP }) {
  const e = ENTITIES[slug];
  if (!e) notFound();
  const s = await requireAdmin();
  const ctx = { programId: s.programId, userId: s.userId };
  const row: Row = id ? await model(e.model).findFirst({ where: { AND: [{ id, programId: s.programId }, e.where ?? {}] }, include: e.include }) : null;
  if (id && !row) notFound();
  const fields = await resolveFields(e.fields, ctx);
  return (
    <>
      <PageHeader title={id ? `Edit ${e.singular}` : `New ${e.singular}`} description={e.description}>
        <Link href={`/${slug}`} className="text-sm text-brand hover:underline">← All {e.title.toLowerCase()}</Link>
      </PageHeader>
      <Flash sp={sp} />
      {row?.archivedAt && <Notice tone="amber">This {e.singular} is archived. It stays on past records but cannot be picked for new ones.</Notice>}
      <Card className="max-w-4xl p-5">
        <EntityForm action={saveEntity.bind(null, slug, id)} fields={fields} cancelHref={`/${slug}`}
          initial={{ ...rowToForm(e.fields, row), ...(id ? {} : Object.fromEntries(e.fields.filter((f) => typeof sp[f.name] === "string" && f.type !== "multi" && f.type !== "weekdays").map((f) => [f.name, sp[f.name]!]))) }} />
      </Card>
      {row && (await e.extra?.(row, ctx))}
      {row && (
        <div className="mt-6 flex max-w-4xl items-center gap-3 border-t border-line pt-4">
          {row.archivedAt ? (
            <form action={restoreEntity.bind(null, slug, row.id)}><Button variant="outline" size="sm">Restore</Button></form>
          ) : (
            <form action={removeEntity.bind(null, slug, row.id)}><Button variant="danger" size="sm">Delete</Button></form>
          )}
          <span className="text-xs text-muted">{e.archivable ? "If anything still uses it, it is archived instead of deleted." : "Cannot be deleted while something else refers to it."}</span>
        </div>
      )}
    </>
  );
}
