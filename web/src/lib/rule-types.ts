// Shared by the rule form (browser) and the save action (server). No server imports here.
import type { Opt } from "./crud";

export type RuleDraft = {
  scope: "PROGRAM" | "INSTITUTION" | "ROLE" | "PARTICIPANT";
  institutionId: string; roleId: string; participantId: string;
  template: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
  level: "HARD" | "SOFT";
  weight: string; priority: string;
  activeFrom: string; activeTo: string;
  notes: string;
  enabled: boolean;
  needsReview: boolean;
  originalText: string;
  source: "SYSTEM" | "MANUAL" | "AI_ASSISTED";
};
export type RuleFormState = { errors?: Record<string, string>; message?: string; draft?: RuleDraft };
/** Choices for anything a rule can point at, keyed by the x-ref name used in rule-templates.json. */
export type RuleRefs = Record<"Institution" | "Role" | "Participant" | "Area" | "ShiftCategory" | "Shift", Opt[]>;

export const emptyDraft = (): RuleDraft => ({
  scope: "PROGRAM", institutionId: "", roleId: "", participantId: "", template: "", params: {}, level: "HARD", weight: "5", priority: "9",
  activeFrom: "", activeTo: "", notes: "", enabled: true, needsReview: false, originalText: "", source: "MANUAL",
});
