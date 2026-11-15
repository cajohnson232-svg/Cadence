import { EntityListPage } from "@/components/entity-pages";

export default async function Page({ params, searchParams }: { params: Promise<{ entity: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  return <EntityListPage slug={(await params).entity} sp={await searchParams} />;
}
