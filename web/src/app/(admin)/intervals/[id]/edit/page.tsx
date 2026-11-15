import { EntityFormPage } from "@/components/entity-pages";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  return <EntityFormPage slug="intervals" id={(await params).id} sp={await searchParams} />;
}
