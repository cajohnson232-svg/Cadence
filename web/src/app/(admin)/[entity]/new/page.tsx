import { EntityFormPage } from "@/components/entity-pages";

export default async function Page({ params, searchParams }: { params: Promise<{ entity: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  return <EntityFormPage slug={(await params).entity} id={null} sp={await searchParams} />;
}
