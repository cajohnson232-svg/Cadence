import { setRequestStatus } from "@/app/actions";

const btn = "rounded border border-line bg-white px-1.5 py-0.5 text-xs hover:bg-surface";

/** Approve / deny, or switch an approved request back off (and on again). */
export function RequestStatusButtons({ id, status, returnTo = "/requests" }: { id: string; status: string; returnTo?: string }) {
  return (
    <span className="inline-flex gap-1">
      {status !== "APPROVED" && <form action={setRequestStatus.bind(null, id, "APPROVED", returnTo)}><button className={btn}>Approve</button></form>}
      {status !== "DENIED" && <form action={setRequestStatus.bind(null, id, "DENIED", returnTo)}><button className={btn}>{status === "APPROVED" ? "Turn off" : "Deny"}</button></form>}
    </span>
  );
}
