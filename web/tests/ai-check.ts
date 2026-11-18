// The Claude connection, checked against a local stand-in for Anthropic's API (no key or network needed):
// the request carries the key, version, model and a forced tool; the answer is checked and cleaned before use;
// anything unknown is dropped; and failures (bad key, timeout, odd answer) fall back to the keyword stand-in.
//
//   npm run db:reset && npx tsx tests/ai-check.ts
import "dotenv/config";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let failed = 0;
const ok = (c: unknown, what: string) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) failed++; };
type Seen = { headers: Record<string, unknown>; body: any };
const seen: Seen[] = [];
let reply: (body: any) => { status: number; json: any } | "hang" = () => ({ status: 500, json: {} });

async function main() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ headers: req.headers, body });
      const r = reply(body);
      if (r === "hang") return;                         // never answers: the client must time out
      res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "test-key-123";
  delete process.env.AI_PROVIDER;
  const tool = (name: string, input: unknown) => ({ status: 200, json: { content: [{ type: "text", text: "Here you go." }, { type: "tool_use", id: "t1", name, input }] } });

  const { interpretWithFallback, getRuleInterpreter } = await import("../src/lib/rule-interpreter");
  const { proposeBackupRules, proposeSpecialDay } = await import("../src/lib/assist");
  const { aiLabel } = await import("../src/lib/ai");
  const ctx = { today: "2026-11-17", roles: [{ id: "role_pgy1", name: "PGY-1" }, { id: "role_pgy2", name: "PGY-2" }],
    institutions: [{ id: "inst_lbj", name: "LBJ Hospital", shortCode: "LBJ" }], categories: [{ id: "cat_night", name: "Night", isNight: true }],
    participants: [{ id: "p08", name: "Harper Kim", lastName: "Kim", roleId: "role_pgy2" }] };

  ok(aiLabel().startsWith("Claude (claude-sonnet-5-5)"), `with a key set, Claude is used (${aiLabel()})`);

  // 1. a rule
  reply = (b) => tool(b.tool_choice.name, { template: "unavailable", params: { category_ids: ["cat_night"], institution_ids: ["inst_lbj"] }, scope: "PARTICIPANT",
    participantId: "p08", roleId: "role_made_up", level: "HARD", activeFrom: "2027-01-01", activeTo: "2027-03-31", needsReview: false, explanation: ["Kim cannot work nights at LBJ."] });
  const r1 = await interpretWithFallback("Kim can't do overnights at LBJ Jan-Mar", ctx);
  const req = seen.at(-1)!;
  ok(req.headers["x-api-key"] === "test-key-123" && req.headers["anthropic-version"] === "2023-06-01", "the request carries the key and the API version");
  ok(req.body.model === "claude-sonnet-5-5" && req.body.tool_choice?.type === "tool" && req.body.tool_choice.name === "propose_rule" && req.body.tools[0].input_schema.properties.template.enum.includes("unavailable"),
    "it asks the model to answer by filling in one fixed form (forced tool use)");
  ok(/p08: Harper Kim/.test(req.body.messages[0].content) && !/@/.test(req.body.messages[0].content), "it sends names and ids, not email addresses");
  ok(r1.proposal.template === "unavailable" && r1.proposal.participantId === "p08" && r1.proposal.roleId === null && r1.proposal.activeTo === "2027-03-31" && !r1.fellBack,
    "Claude's rule is used, with an id it was not given (a made-up role) dropped");
  reply = (b) => tool(b.tool_choice.name, { template: "not_a_template", params: {}, scope: "PARTICIPANT", participantId: "someone_else", level: "HARD", needsReview: false, explanation: [] });
  const r2 = await interpretWithFallback("something odd", ctx);
  ok(r2.proposal.template === "custom" && r2.proposal.needsReview && r2.proposal.participantId === null, "an unknown template becomes a custom rule flagged for review; an unknown person is dropped");

  // 2. backup rules
  reply = (b) => tool(b.tool_choice.name, { max_per_person: 4, min_days_between: 2, rest_before_hours: 12, rest_after_hours: 0, counts_as_shift: false,
    eligible_role_ids: ["role_pgy2", "role_bogus"], not_understood: "rotate fairly between pods", explanation: ["At most 4 each."] });
  const b1 = await proposeBackupRules("PGY-2 only, max 4 each, 2 days apart, 12h off before. Rotate fairly between pods.", { today: "2026-11-17", roles: [{ id: "role_pgy1", name: "PGY-1", level: 1 }, { id: "role_pgy2", name: "PGY-2", level: 2 }] });
  ok(b1.rules.max_per_person === 4 && b1.rules.min_days_between === 2 && b1.rules.rest_before_hours === 12 && b1.by.startsWith("Claude"), "backup rules come back from Claude");
  ok(JSON.stringify(b1.eligibleRoleIds) === '["role_pgy2"]' && b1.rules.not_understood === "rotate fairly between pods", "unknown roles are dropped and what could not be expressed is kept as not understood");
  reply = (b) => tool(b.tool_choice.name, { max_per_person: 999, min_days_between: -3, rest_before_hours: 500, rest_after_hours: 0, counts_as_shift: "yes", eligible_role_ids: null, not_understood: "", explanation: [] });
  const b2 = await proposeBackupRules("silly numbers", { today: "2026-11-17", roles: [] });
  ok(b2.rules.max_per_person === 31 && b2.rules.min_days_between === 0 && b2.rules.rest_before_hours === 48 && b2.rules.counts_as_shift === false, "out-of-range numbers are brought back into range");

  // 3. special day
  const shifts = [{ id: "s_ft", name: "Fast track", startMinute: 600, durationMinutes: 480, minParticipants: 1, categoryId: "cat_day", runsThatDay: true, active: true },
    { id: "s_dm", name: "Day M", startMinute: 420, durationMinutes: 480, minParticipants: 1, categoryId: "cat_day", runsThatDay: true, active: true }];
  reply = (b) => tool(b.tool_choice.name, { lines: [
    { action: "REMOVE", shift_id: "s_ft" }, { action: "CHANGE", shift_id: "s_dm", start: "09:00", hours: 6, people: null },
    { action: "CHANGE", shift_id: null }, { action: "ADD", shift_id: null, name: "Extra evening", category_id: "cat_day", start: "15:00", hours: 8, people: 1 },
    { action: "EXPLODE", shift_id: "s_dm" }], explanation: ["Fast track closed."] });
  const d1 = await proposeSpecialDay("No fast track; Day M 9-3; extra evening 15:00 for 8h", { today: "2026-11-17", date: "2027-01-18", institution: "MHH", shifts, categories: [{ id: "cat_day", name: "Day", isNight: false }] });
  ok(d1.lines.length === 3 && d1.lines[0].action === "REMOVE" && d1.lines[1].startMinute === 540 && d1.lines[1].durationMinutes === 360 && d1.lines[2].name === "Extra evening",
    "special-day changes come back as lines; a change with no shift, and an unknown change, are dropped");

  // 4. failures fall back to the keyword stand-in, and say why
  reply = () => ({ status: 401, json: { error: { message: "invalid x-api-key" } } });
  const f1 = await interpretWithFallback("Kim can't do nights", ctx);
  ok(f1.fellBack === "the AI key was refused (check ANTHROPIC_API_KEY)" && /keyword/.test(f1.interpreter) && f1.proposal.template === "unavailable", "a refused key falls back to the stand-in, with the reason");
  reply = () => ({ status: 200, json: { content: [{ type: "text", text: "I would rather chat." }] } });
  const f2 = await proposeBackupRules("max 3 each", { today: "2026-11-17", roles: [] });
  ok(/keyword stand-in, because the AI answered in an unexpected form/.test(f2.by) && f2.rules.max_per_person === 3, "an answer without the form falls back too");
  process.env.ANTHROPIC_TIMEOUT_MS = "800";
  reply = () => "hang";
  const t0 = Date.now();
  const f3 = await proposeSpecialDay("No fast track", { today: "2026-11-17", date: "2027-01-18", institution: "MHH", shifts, categories: [] });
  ok(/took too long/.test(f3.by) && Date.now() - t0 < 5000 && f3.lines[0]?.action === "REMOVE", "a slow answer times out and falls back");
  delete process.env.ANTHROPIC_TIMEOUT_MS;

  // 5. switched off
  process.env.AI_PROVIDER = "mock";
  ok(/keyword/.test(getRuleInterpreter().name) && /stand-in/.test(aiLabel()), "AI_PROVIDER=mock uses the stand-in even with a key");
  delete process.env.AI_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
  const n = seen.length;
  await interpretWithFallback("Kim can't do nights", ctx);
  ok(seen.length === n && /no AI key/.test(aiLabel()), "without a key, nothing is sent anywhere");

  server.close();
  console.log(failed ? `\n${failed} FAILED` : "\nAI CONNECTION CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
