import { SpecialDayPage } from "@/app/special-day-page";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return <SpecialDayPage id={null} sp={sp} title="New special staffing day"
    initial={{ institutionId: sp.institutionId ?? "", date: sp.date ?? "", name: "", mode: "MODIFY", changeText: "", lines: [] }} />;
}
