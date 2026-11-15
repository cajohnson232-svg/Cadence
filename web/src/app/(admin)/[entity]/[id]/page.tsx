import { EntityFormPage } from "@/components/entity-pages";

export default async function Page({ params, searchParams }: { params: Promise<{ entity: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await params;
  return <EntityFormPage slug={p.entity} id={p.id} sp={await searchParams} />;
}
