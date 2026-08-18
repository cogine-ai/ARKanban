import { formatDateTime, formatExact } from "../lib/format";

/**
 * A displayed instant that can be pinned down.
 *
 * The visible text stays compact so rows stay readable, and the exact zoned
 * timestamp is one hover away. `dateTime` carries the unambiguous instant for
 * anything reading the page rather than looking at it.
 */
export function Timestamp({ value, className }: { value?: number; className?: string }) {
  if (!value) return <span className={className}>Not observed</span>;
  return (
    <time className={className} dateTime={new Date(value).toISOString()} title={formatExact(value)}>
      {formatDateTime(value)}
    </time>
  );
}
