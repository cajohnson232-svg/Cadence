// A small config-driven CRUD engine. Each entity is described once (fields, list columns,
// validation) in entities.tsx; the list page, the form and the save/delete actions are generic.
import type { ReactNode } from "react";
import { hhmm, parseYmd, toMinutes, ymd } from "./util";

export type Opt = { value: string; label: string };
export type Ctx = { programId: string; userId: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;
export type Values = Record<string, Row>;

export type FieldType =
  | "text" | "email" | "tel" | "textarea" | "number" | "checkbox" | "date" | "datetime"
  | "time" /* minutes after midnight */ | "hours" /* stored as minutes */ | "select" | "multi" | "weekdays";

export type Field = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: Opt[] | ((ctx: Ctx) => Promise<Opt[]>);
  numeric?: boolean; // select whose value is stored as a number
  join?: { relation: string; key: string }; // multi: many-to-many through a join table
  min?: number;
  max?: number;
  step?: number;
  default?: string | string[];
  virtual?: boolean; // shown in the form, not written to the row
};
export type FieldView = Omit<Field, "options"> & { options?: Opt[] };
export type FormValues = Record<string, string | string[]>;
export type FormState = { errors?: Record<string, string>; message?: string; values?: FormValues; at?: number };

export type Check = { errors?: Record<string, string> };
export type Entity = {
  slug: string;
  model: string; // Prisma delegate name
  title: string;
  singular: string;
  description?: string;
  fields: Field[];
  columns: { label: string; cell: (row: Row) => ReactNode }[];
  include?: object;
  orderBy: object | object[];
  search?: string[]; // field paths, e.g. "lastName" or "participant.lastName"
  filters?: { name: string; label: string; options: Opt[] | ((ctx: Ctx) => Promise<Opt[]>); where: (value: string) => object }[];
  where?: object; // rows this entity covers (e.g. only vacations)
  fixed?: object; // values set on every create
  stamp?: boolean; // record createdById
  archivable?: boolean; // has archivedAt: referenced rows are archived instead of deleted
  hasActive?: boolean;
  rowHref?: (row: Row) => string;
  prepare?: (v: Values, ctx: Ctx, id: string | null) => Promise<void>;
  validate?: (v: Values, ctx: Ctx, id: string | null) => Promise<Check>;
  decorate?: (rows: Row[], ctx: Ctx) => Promise<void>;
  extra?: (row: Row, ctx: Ctx) => Promise<ReactNode>;
};

export function parseForm(fields: Field[], fd: FormData) {
  const values: Values = {};
  const errors: Record<string, string> = {};
  const raw: FormValues = {};
  for (const f of fields) {
    if (f.type === "multi" || f.type === "weekdays") {
      const all = fd.getAll(f.name).map(String);
      raw[f.name] = all;
      values[f.name] = f.type === "weekdays" ? all.map(Number).sort() : all;
      if (f.required && !all.length) errors[f.name] = "Choose at least one";
      continue;
    }
    if (f.type === "checkbox") {
      values[f.name] = fd.get(f.name) === "on";
      raw[f.name] = values[f.name] ? "on" : "";
      continue;
    }
    const s = String(fd.get(f.name) ?? "").trim();
    raw[f.name] = s;
    if (!s) {
      values[f.name] = null;
      if (f.required) errors[f.name] = "Required";
      continue;
    }
    if (f.type === "number" || f.type === "hours") {
      const n = Number(s);
      if (!Number.isFinite(n)) errors[f.name] = "Enter a number";
      else if (f.min !== undefined && n < f.min) errors[f.name] = `Must be at least ${f.min}`;
      else if (f.max !== undefined && n > f.max) errors[f.name] = `Must be at most ${f.max}`;
      else if (f.type === "number" && !Number.isInteger(n)) errors[f.name] = "Enter a whole number";
      values[f.name] = f.type === "hours" ? Math.round(n * 60) : n;
    } else if (f.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) errors[f.name] = "Enter a date";
      values[f.name] = parseYmd(s);
    } else if (f.type === "datetime") {
      values[f.name] = new Date(s.length === 16 ? s + ":00.000Z" : s);
      if (Number.isNaN(values[f.name].getTime())) errors[f.name] = "Enter a date and time";
    } else if (f.type === "time") {
      if (!/^\d{2}:\d{2}$/.test(s)) errors[f.name] = "Enter a time";
      values[f.name] = toMinutes(s);
    } else if (f.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) {
      errors[f.name] = "Enter an email address";
      values[f.name] = s;
    } else {
      values[f.name] = f.numeric ? Number(s) : s;
    }
  }
  return { values, errors, raw };
}

export function rowToForm(fields: Field[], row: Row | null): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = row ? row[f.name] : undefined;
    if (!row) out[f.name] = f.default ?? (f.type === "multi" || f.type === "weekdays" ? [] : "");
    else if (f.type === "multi") out[f.name] = f.join ? (row[f.join.relation] ?? []).map((x: Row) => x[f.join!.key]) : [];
    else if (f.type === "weekdays") out[f.name] = (v ?? []).map(String);
    else if (f.type === "checkbox") out[f.name] = v ? "on" : "";
    else if (f.type === "date") out[f.name] = ymd(v);
    else if (f.type === "datetime") out[f.name] = v ? (v as Date).toISOString().slice(0, 16) : "";
    else if (f.type === "time") out[f.name] = v == null ? "" : hhmm(v);
    else if (f.type === "hours") out[f.name] = v == null ? "" : String(+(v / 60).toFixed(2));
    else out[f.name] = v == null ? "" : String(v);
  }
  return out;
}

export function toData(fields: Field[], v: Values, update: boolean) {
  const data: Values = {};
  for (const f of fields) {
    if (f.virtual) continue;
    if (f.type === "multi" && f.join) {
      const create = (v[f.name] as string[]).map((id) => ({ [f.join!.key]: id }));
      data[f.join.relation] = update ? { deleteMany: {}, create } : { create };
    } else data[f.name] = v[f.name];
  }
  return data;
}

/** Turns "participant.lastName" + "smi" into { participant: { lastName: { contains: "smi" } } }. */
export function searchWhere(paths: string[], q: string) {
  return {
    OR: paths.map((p) =>
      p.split(".").reduceRight<object>((acc, key) => ({ [key]: acc }), { contains: q, mode: "insensitive" }),
    ),
  };
}

export async function resolveFields(fields: Field[], ctx: Ctx): Promise<FieldView[]> {
  return Promise.all(
    fields.map(async (f) => ({ ...f, options: typeof f.options === "function" ? await f.options(ctx) : f.options })),
  );
}

/** Database errors -> something an admin can act on. */
export function friendlyDbError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const code = (e as { code?: string })?.code;
  if (code === "P2002" || /Unique constraint|duplicate key/i.test(msg)) return "That already exists (a name, code, email or date must be unique).";
  if (/Assignment_no_overlap/.test(msg)) return "This participant already has an assignment covering some of those dates.";
  if (/Interval_no_overlap/.test(msg)) return "Another interval already covers some of those dates.";
  if (code === "P2003" || /foreign key|violates RESTRICT/i.test(msg)) return "This is still used elsewhere, so it cannot be deleted.";
  if (/violates check constraint "(\w+)"/.test(msg)) return `The database refused this (rule ${/"(\w+)"/.exec(msg)![1]}).`;
  return "Could not save: " + msg.split("\n").slice(-1)[0].slice(0, 200);
}
