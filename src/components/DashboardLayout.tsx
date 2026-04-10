import { useLocation } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Package,
  TrendingUp,
  RefreshCw,
  Truck,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Overview", to: "/", icon: LayoutDashboard },
  { label: "Inventory Health", to: "/inventory", icon: Package },
  { label: "Sales & Velocity", to: "/sales", icon: TrendingUp },
  { label: "Replenishment", to: "/replenishment", icon: RefreshCw },
  { label: "Inbound Shipments", to: "/inbound", icon: Truck },
  { label: "Exceptions & Alerts", to: "/alerts", icon: AlertTriangle },
] as const;

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col border-r bg-sidebar transition-all duration-200",
          collapsed ? "w-16" : "w-60"
        )}
      >
        {/* Logo */}
        <div className="flex h-14 items-center border-b border-sidebar-border px-4">
          {!collapsed && (
            <span className="text-base font-bold tracking-tight text-sidebar-foreground">
              WFS Operations
            </span>
          )}
          {collapsed && (
            <span className="text-base font-bold text-sidebar-primary mx-auto">W</span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-2">
          {navItems.map((item) => {
            const isActive = item.to === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(item.to);

            return (
              <a
                key={item.to}
                href={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-primary"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </a>
            );
          })}
        </nav>

        {/* Collapse toggle */}
        <div className="border-t border-sidebar-border p-2">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex w-full items-center justify-center rounded-md p-2 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main
        className={cn(
          "flex-1 transition-all duration-200",
          collapsed ? "ml-16" : "ml-60"
        )}
      >
        <div className="p-6 max-w-[1400px]">
          {children}
        </div>
      </main>
    </div>
  );
}
