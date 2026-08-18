import * as ToggleGroup from "@radix-ui/react-toggle-group";
import type { SettledRange } from "../../../src/contracts";
import { isSettledRange, SETTLED_RANGES } from "../lib/settled-range";

export function RangeSelector({ value, onChange }: { value: SettledRange; onChange: (value: SettledRange) => void }) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => { if (isSettledRange(next)) onChange(next); }}
      className="flex h-[34px] items-center gap-0.5 rounded-[11px] bg-black/[0.07] p-[3px]"
      aria-label="Settled time range"
    >
      {SETTLED_RANGES.map((range) => (
        <ToggleGroup.Item
          key={range}
          value={range}
          className="h-7 rounded-lg px-2.5 text-[10px] font-semibold text-neutral-500 transition-colors hover:text-neutral-900 data-[state=on]:bg-white data-[state=on]:text-neutral-950 data-[state=on]:shadow-sm"
        >
          {range}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
