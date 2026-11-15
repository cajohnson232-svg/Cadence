"use client";
import { useActionState } from "react";
import { startOver } from "@/app/account-actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function StartOverForm({ programName }: { programName: string }) {
  const [state, action, pending] = useActionState(startOver, null);
  return (
    <form action={action} className="mt-4 space-y-3" data-testid="start-over">
      <div><Label htmlFor="confirm">To confirm, type the program&apos;s name: <span className="font-mono">{programName}</span></Label><Input id="confirm" name="confirm" autoComplete="off" required /></div>
      <div><Label htmlFor="newName">Name for the new, empty program (optional)</Label><Input id="newName" name="newName" autoComplete="off" /></div>
      {state?.error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      <Button variant="danger" disabled={pending}>{pending ? "Removing everything…" : "Remove everything and start over"}</Button>
    </form>
  );
}
