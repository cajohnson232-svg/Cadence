// GET /api/calendar/<private token>  ->  the participant's schedule as an iCalendar feed.
// No sign-in: calendar apps cannot log in, so the unguessable token in the URL is the key.
import { calendarFor } from "@/lib/calendar";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const cal = await calendarFor((await params).token.replace(/\.ics$/, ""));
  if (!cal) return new Response("Calendar not found", { status: 404 });
  return new Response(cal.ics, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="cadence.ics"', "cache-control": "private, max-age=300" } });
}
