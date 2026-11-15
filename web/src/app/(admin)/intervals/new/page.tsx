import { EntityFormPage } from "@/components/entity-pages";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return <EntityFormPage slug="intervals" id={null} sp={await searchParams} />;
}
