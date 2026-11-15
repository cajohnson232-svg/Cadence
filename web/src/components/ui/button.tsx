import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/util";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-brand text-white hover:bg-brand-dark",
        outline: "border border-line bg-white hover:bg-surface",
        ghost: "hover:bg-surface",
        danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
      },
      size: { default: "h-9 px-3.5", sm: "h-8 px-2.5 text-[13px]" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ className, variant, size, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props}>{children}</button>;
}
