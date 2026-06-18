import * as React from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface CategoryFilterProps {
  options: Array<{ label: string; count: number }>;
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
}

export function CategoryFilter({
  options,
  selected,
  onChange,
  placeholder = "All categories",
}: CategoryFilterProps) {
  const [open, setOpen] = React.useState(false);

  const toggle = (label: string) => {
    if (selected.includes(label)) {
      onChange(selected.filter((s) => s !== label));
    } else {
      onChange([...selected, label]);
    }
  };

  const clear = () => onChange([]);

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-border bg-secondary px-3 py-2 text-sm shadow-sm hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-ring",
              selected.length === 0 && "text-muted-foreground"
            )}
          >
            <span className="truncate">
              {selected.length === 0
                ? placeholder
                : `${selected.length} categor${selected.length === 1 ? "y" : "ies"} selected`}
            </span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <div className="max-h-80 overflow-y-auto p-1">
            {options.length === 0 && (
              <div className="px-2 py-3 text-sm text-muted-foreground">No categories found</div>
            )}
            {options.map(({ label, count }) => (
              <label
                key={label}
                className="flex cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <Checkbox
                  checked={selected.includes(label)}
                  onCheckedChange={() => toggle(label)}
                />
                <span className="flex-1 truncate">{label}</span>
                <span className="text-xs text-muted-foreground">{count.toLocaleString()}</span>
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((label) => (
            <Badge key={label} variant="secondary" className="gap-1 pr-1">
              <span className="truncate max-w-[180px]">{label}</span>
              <button
                type="button"
                onClick={() => toggle(label)}
                className="rounded-sm hover:bg-muted"
                aria-label={`Remove ${label}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <button
            type="button"
            onClick={clear}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
