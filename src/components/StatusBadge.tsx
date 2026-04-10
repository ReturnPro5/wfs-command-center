import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  variant: "healthy" | "warning" | "critical" | "info";
  children: React.ReactNode;
  className?: string;
}

export function StatusBadge({ variant, children, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variant === "healthy" && "status-badge-healthy",
        variant === "warning" && "status-badge-warning",
        variant === "critical" && "status-badge-critical",
        variant === "info" && "status-badge-info",
        className
      )}
    >
      {children}
    </span>
  );
}
