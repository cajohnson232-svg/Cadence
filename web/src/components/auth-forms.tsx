"use client";
// The forms people use before they are signed in (sign in, choose a password, first-time setup)
// and the one for changing a password. Each shows the server's answer under the form.
import { useActionState } from "react";
import { changePasswordAction, joinAction, setupAction, signInAction, type FormMsg } from "@/app/account-actions";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { MIN_PASSWORD } from "@/lib/password-rules";

function Message({ state }: { state: FormMsg }) {
  if (!state?.error && !state?.notice) return null;
  return <p role="alert" className={state.error ? "rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" : "rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"}>{state.error ?? state.notice}</p>;
}
const hint = `At least ${MIN_PASSWORD} characters. A few words together work well.`;

export function SignInForm() {
  const [state, action, pending] = useActionState(signInAction, null);
  return (
    <form action={action} className="space-y-4">
      <div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="username" required autoFocus /></div>
      <div><Label htmlFor="password">Password</Label><Input id="password" name="password" type="password" autoComplete="current-password" required /></div>
      <Message state={state} />
      <Button disabled={pending} className="w-full">{pending ? "Signing in…" : "Sign in"}</Button>
    </form>
  );
}

export function JoinForm({ token, email, reset }: { token: string; email: string; reset: boolean }) {
  const [state, action, pending] = useActionState(joinAction.bind(null, token), null);
  if (state?.expired) return <Message state={state} />;
  return (
    <form action={action} className="space-y-4" key={state?.at ?? 0}>
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <div><Label htmlFor="password">{reset ? "New password" : "Choose a password"}</Label><Input id="password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} autoFocus />
        <p className="mt-1 text-xs text-muted">{hint}</p></div>
      <div><Label htmlFor="again">Type it again</Label><Input id="again" name="again" type="password" autoComplete="new-password" required /></div>
      <Message state={state} />
      <Button disabled={pending} className="w-full">{pending ? "Saving…" : reset ? "Save password and sign in" : "Create my sign-in"}</Button>
    </form>
  );
}

export function SetupForm({ timezones, keyRequired }: { timezones: string[]; keyRequired: boolean }) {
  const [state, action, pending] = useActionState(setupAction, null);
  return (
    <form action={action} className="space-y-4">
      {keyRequired && (
        <div><Label htmlFor="key">Setup key</Label><Input id="key" name="key" type="password" autoComplete="off" required />
          <p className="mt-1 text-xs text-muted">The value of SETUP_KEY in your hosting service&apos;s settings. It proves this site is yours to set up.</p></div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div><Label htmlFor="name">Your name</Label><Input id="name" name="name" autoComplete="name" required /></div>
        <div><Label htmlFor="email">Your email</Label><Input id="email" name="email" type="email" autoComplete="username" required /></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><Label htmlFor="password">Choose a password</Label><Input id="password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} /></div>
        <div><Label htmlFor="again">Type it again</Label><Input id="again" name="again" type="password" autoComplete="new-password" required /></div>
      </div>
      <p className="-mt-2 text-xs text-muted">{hint}</p>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Start with</legend>
        <label className="flex items-start gap-2 text-sm"><input type="radio" name="start" value="demo" defaultChecked className="mt-1" />
          <span>The demo program<span className="block text-xs text-muted">Made-up people, two hospitals and one interval ready to schedule, so you can try everything straight away. You can wipe it and start your own program later, under Program settings.</span></span></label>
        <label className="flex items-start gap-2 text-sm"><input type="radio" name="start" value="empty" className="mt-1" />
          <span>An empty program<span className="block text-xs text-muted">Just the standard rules, shift categories and PGY roles. You enter your own hospitals, people and shifts.</span></span></label>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><Label htmlFor="programName">Program name</Label><Input id="programName" name="programName" placeholder="Only needed for an empty program" /></div>
        <div><Label htmlFor="timezone">Timezone</Label><Select id="timezone" name="timezone" defaultValue="America/Chicago">{timezones.map((t) => <option key={t}>{t}</option>)}</Select></div>
      </div>
      <Message state={state} />
      <Button disabled={pending}>{pending ? "Setting up…" : "Set up this site"}</Button>
    </form>
  );
}

export function ChangePasswordForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(changePasswordAction, null);
  return (
    <form action={action} className="space-y-4" key={state?.notice ? state.at : 0}>
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <div><Label htmlFor="current">Current password</Label><Input id="current" name="current" type="password" autoComplete="current-password" required /></div>
      <div><Label htmlFor="password">New password</Label><Input id="password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} />
        <p className="mt-1 text-xs text-muted">{hint}</p></div>
      <div><Label htmlFor="again">Type it again</Label><Input id="again" name="again" type="password" autoComplete="new-password" required /></div>
      <Message state={state} />
      <Button disabled={pending}>{pending ? "Saving…" : "Change password"}</Button>
    </form>
  );
}
