/**
 * Host-qualified identity helpers.
 *
 * A node always speaks local ids. A hub rewrites them as `hostId::localId` so
 * two Gateways that both emit `task:ta_…` cannot collide in one board, and so
 * detail routes can proxy back to the owning node.
 */

export const HOST_ID_SEPARATOR = "::";

const HOST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidHostId(value: string): boolean {
  return HOST_ID_PATTERN.test(value);
}

export function qualifyId(hostId: string, localId: string): string {
  if (localId.includes(HOST_ID_SEPARATOR)) return localId;
  return `${hostId}${HOST_ID_SEPARATOR}${localId}`;
}

export function splitQualifiedId(qualified: string): { hostId: string; localId: string } | undefined {
  const index = qualified.indexOf(HOST_ID_SEPARATOR);
  if (index <= 0) return undefined;
  const hostId = qualified.slice(0, index);
  const localId = qualified.slice(index + HOST_ID_SEPARATOR.length);
  if (!hostId || !localId) return undefined;
  return { hostId, localId };
}

export function stampHostId<T extends { hostId?: string }>(value: T, hostId: string): T & { hostId: string } {
  return { ...value, hostId };
}
