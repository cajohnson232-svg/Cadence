// Claude, through Anthropic's Messages API, for the plain-English boxes:
//   * "Other restrictions"        -> a proposed rule
//   * a backup shift's rules      -> proposed backup rules (and which roles may take it)
//   * a special staffing day      -> proposed changes to that day's shifts
//
// Switched on by setting ANTHROPIC_API_KEY on the server. AI_PROVIDER=mock forces the keyword stand-in;
// ANTHROPIC_MODEL picks the model (default below). Without a key, or if a call fails, the keyword
// stand-in answers instead and the page says so.
//
// Every answer is only a proposal: the administrator sees it next to their own words, edits it, and
// nothing is saved until they confirm. What is sent: the text typed, and the program's names and ids
// for participants, roles, institutions, shift categories and shifts. Nothing else from the database.
// The answer is forced into a fixed shape (one tool call) and checked again on the server before use.

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const URL = "https://api.anthropic.com/v1/messages";

export const aiConfigured = () => !!process.env.ANTHROPIC_API_KEY && (process.env.AI_PROVIDER ?? "").toLowerCase() !== "mock";
export const aiModel = () => process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
export const aiLabel = () => (aiConfigured() ? `Claude (${aiModel()})` : "keyword stand-in (no AI key set)");

/** Ask Claude to answer by filling in one tool's input. Returns that input, or throws with a short reason. */
export async function askForTool<T>(opts: { system: string; user: string; tool: { name: string; description: string; input_schema: object }; maxTokens?: number }): Promise<T> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no API key");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(process.env.ANTHROPIC_TIMEOUT_MS || 45_000));
  let res: Response;
  try {
    res = await fetch(process.env.ANTHROPIC_BASE_URL ? `${process.env.ANTHROPIC_BASE_URL.replace(/\/$/, "")}/v1/messages` : URL, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: aiModel(), max_tokens: opts.maxTokens ?? 2000, system: opts.system,
        tools: [opts.tool], tool_choice: { type: "tool", name: opts.tool.name },
        messages: [{ role: "user", content: opts.user }],
      }),
    });
  } catch (e) {
    throw new Error((e as Error).name === "AbortError" ? "the AI took too long to answer" : "the AI could not be reached");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let why = `the AI service answered ${res.status}`;
    try { const j = await res.json(); if (j?.error?.message) why += `: ${String(j.error.message).slice(0, 160)}`; } catch { /* not JSON */ }
    if (res.status === 401) why = "the AI key was refused (check ANTHROPIC_API_KEY)";
    if (res.status === 429) why = "the AI service is busy or the account's limit was reached";
    throw new Error(why);
  }
  const body = await res.json();
  const call = (body?.content ?? []).find((c: { type: string; name?: string }) => c.type === "tool_use" && c.name === opts.tool.name);
  if (!call || typeof call.input !== "object") throw new Error("the AI answered in an unexpected form");
  return call.input as T;
}

/** The program's names, as compact lines the model can refer to by id. */
export function contextBlock(ctx: {
  today: string; roles?: { id: string; name: string }[]; institutions?: { id: string; name: string; shortCode?: string }[];
  categories?: { id: string; name: string; isNight?: boolean }[]; participants?: { id: string; name: string }[];
  shifts?: { id: string; name: string; start: string; hours: number; headcount: number; category: string; days?: string }[];
}): string {
  const out = [`Today: ${ctx.today}`];
  const list = (title: string, rows: string[] | undefined) => { if (rows?.length) out.push(`${title}:`, ...rows.map((r) => `  ${r}`)); };
  list("Roles (id: name)", ctx.roles?.map((r) => `${r.id}: ${r.name}`));
  list("Institutions (id: name, code)", ctx.institutions?.map((i) => `${i.id}: ${i.name}${i.shortCode ? `, ${i.shortCode}` : ""}`));
  list("Shift categories (id: name)", ctx.categories?.map((c) => `${c.id}: ${c.name}${c.isNight ? " (night)" : ""}`));
  list("Participants (id: name)", ctx.participants?.map((p) => `${p.id}: ${p.name}`));
  list("Shifts (id: name, start, hours, people, category)", ctx.shifts?.map((s) => `${s.id}: ${s.name}, ${s.start}, ${s.hours}h, ${s.headcount}, ${s.category}${s.days ? `, ${s.days}` : ""}`));
  return out.join("\n");
}
