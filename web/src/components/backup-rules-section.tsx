// The rules of a backup shift, on the shift's page.
import { db } from "@/lib/db";
import { aiLabel } from "@/lib/ai";
import { cleanBackupRules } from "@/lib/backup-rules";
import { BackupRulesForm } from "@/components/backup-rules-form";
import { Card } from "@/components/ui/misc";

export async function BackupRulesSection({ shiftId, programId }: { shiftId: string; programId: string }) {
  const [shift, roles, elig] = await Promise.all([
    db.shift.findUniqueOrThrow({ where: { id: shiftId } }),
    db.role.findMany({ where: { programId, archivedAt: null }, orderBy: { level: "asc" } }),
    db.shiftRole.findMany({ where: { shiftId } }),
  ]);
  const ok = new Map(elig.map((e) => [e.roleId, e.eligible]));
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">Backup rules</h2>
      <p className="mt-0.5 max-w-3xl text-sm text-muted">
        Every day of an interval, the schedule puts {shift.minParticipants === 1 ? "one person" : `${shift.minParticipants} people`} on this backup shift, after the clinical
        schedule is made. Whatever the rules say, nobody is on backup while on a shift, on vacation or required time off, or during their weekly 24 hours off.
      </p>
      <Card className="mt-2 p-4">
        <BackupRulesForm shiftId={shiftId} aiLabel={aiLabel()} text={shift.backupRulesText ?? ""} rules={cleanBackupRules(shift.backupRules)}
          roles={roles.map((r) => ({ id: r.id, name: r.name, eligible: ok.get(r.id) ?? true }))} />
      </Card>
    </section>
  );
}
