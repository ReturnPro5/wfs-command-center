import { cn } from "@/lib/utils";

interface DataTableShellProps {
  children: React.ReactNode;
  className?: string;
}

export function DataTableShell({ children, className }: DataTableShellProps) {
  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden", className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {children}
        </table>
      </div>
    </div>
  );
}

export function Thead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b bg-muted/50">
      {children}
    </thead>
  );
}

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn("px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={cn("px-4 py-3 whitespace-nowrap", className)}>
      {children}
    </td>
  );
}
