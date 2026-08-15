import { useCallback, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

/**
 * Minimal history-API router.
 *
 * Deliberately not a dependency: the app needs path matching, a link that does
 * not reload the page, and query-string access. Everything else a router
 * library brings — loaders, nested outlets, its own data cache — would sit
 * beside the collector context and duplicate it.
 *
 * The History API fires no event for pushState/replaceState, so programmatic
 * navigation notifies subscribers explicitly; popstate covers back and forward.
 */

const listeners = new Set<() => void>();

function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

// useSyncExternalStore requires a referentially stable snapshot, so the string
// is cached and only rebuilt when the location actually changes. Resolved
// lazily so importing this module never touches the DOM — matchPath is pure
// and is used where no document exists.
let snapshot: string | undefined;
let popstateBound = false;

function notify(): void {
  const next = currentLocation();
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function getSnapshot(): string {
  snapshot ??= currentLocation();
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  if (!popstateBound) {
    popstateBound = true;
    window.addEventListener("popstate", notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type NavigateOptions = { replace?: boolean };

export function navigate(to: string, options: NavigateOptions = {}): void {
  if (to === currentLocation()) return;
  window.history[options.replace ? "replaceState" : "pushState"]({}, "", to);
  notify();
}

export function useLocation(): { pathname: string; search: string; searchParams: URLSearchParams } {
  const value = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => {
    const separator = value.indexOf("?");
    const pathname = separator === -1 ? value : value.slice(0, separator);
    const search = separator === -1 ? "" : value.slice(separator);
    return { pathname, search, searchParams: new URLSearchParams(search) };
  }, [value]);
}

export function useNavigate(): (to: string, options?: NavigateOptions) => void {
  return useCallback((to: string, options?: NavigateOptions) => navigate(to, options), []);
}

/**
 * Matches a path against a `/segment/:param` pattern.
 * Returns the captured params, or undefined when the pattern does not apply.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return undefined;

  const params: Record<string, string> = {};
  for (const [index, part] of patternParts.entries()) {
    const actual = pathParts[index]!;
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (part !== actual) return undefined;
  }
  return params;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean };

/**
 * A real anchor, so the destination can be opened in a new tab, copied, and
 * read by assistive technology. Only plain left clicks are intercepted;
 * everything the browser handles better is left alone.
 */
export function Link({ to, replace, onClick, target, children, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (target && target !== "_self") return;
    event.preventDefault();
    navigate(to, { replace });
  };
  return (
    <a href={to} onClick={handleClick} {...(target ? { target } : {})} {...rest}>
      {children}
    </a>
  );
}
