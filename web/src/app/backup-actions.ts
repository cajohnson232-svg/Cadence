"use server";
// A backup shift's rules: read plain words into proposed rules, then save what the administrator confirms.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { proposeBackupRules, type BackupProposal } from "@/lib/assist";
import { cleanBackupRules, type BackupRules } from "@/lib/backup-rules";

export async function readBackupRules(shiftId: string, text: string): Promise<BackupProposal | { error: string }> {
  const s = await requireAdmin();
  if (!(await db.shift.findFirst({ where: { id: shiftId, programId: s.programId, isBackup: true } }))) return { error: "That backup shift does not exist." };
  if (text.trim().length < 4) return { error: "Describe the rules first." };
  const roles = await db.role.findMany({ where: { programId: s.programId, archivedAt: null }, orderBy: { level: "asc" } });
  return proposeBackupRules(text.slice(0, 2000), { today: new Date().toISOString().slice(0, 10), roles: roles.map((r) => ({ id: r.id, name: r.name, level: r.level })) });
}

export async function saveBackupRules(shiftId: string, input: { text: string; rules: BackupRules; eligibleRoleIds: string[] | null }): Promise<{ error?: string; notice?: string }> {
  const s = await requireAdmin();
  const shift = await db.shift.findFirst({ where: { id: shiftId, programId: s.programId, isBackup: true } });
  if (!shift) return { error: "That backup shift does not exist." };
  const rules = cleanBackupRules(input.rules);
  const roles = await db.role.findMany({ where: { programId: s.programId } });
  const known = new Set(roles.map((r) => r.id));
  const elig = input.eligibleRoleIds?.filter((r) => known.has(r)) ?? null;
  if (elig && !elig.length) return { error: "At least one role must be able to take backup." };
  await db.$transaction([
    db.shift.update({ where: { id: shiftId }, data: { backupRules: rules, backupRulesText: input.text.trim().slice(0, 4000) || null } }),
    ...(elig ? roles.map((r) => db.shiftRole.upsert({ where: { shiftId_roleId: { shiftId, roleId: r.id } },
      create: { shiftId, roleId: r.id, eligible: elig.includes(r.id) }, update: { eligible: elig.includes(r.id) } })) : []),
  ]);
  revalidatePath("/", "layout");
  return { notice: "Backup rules saved." + (elig ? " Role eligibility updated below." : "") };
}
