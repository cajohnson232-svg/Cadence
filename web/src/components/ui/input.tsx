import { cn } from "@/lib/util";

const base = "w-full rounded-md border border-line bg-white px-3 text-sm placeholder:text-muted/70 disabled:bg-surface";

export function Input({ className, ...p }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, "h-9", className)} {...p} />;
}
export function Textarea({ className, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, "py-2 min-h-20", className)} {...p} />;
}
export function Select({ className, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(base, "h-9 pr-8", className)} {...p}>{children}</select>;
}
export function Label({ className, children, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-[13px] font-medium mb-1", className)} {...p}>{children}</label>;
}
