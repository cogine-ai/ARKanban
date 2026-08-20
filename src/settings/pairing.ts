import { randomBytes } from "node:crypto";

export type PairingOffer = {
  code: string;
  hostId: string;
  label: string;
  token: string;
  createdAt: number;
  expiresAt: number;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const offers = new Map<string, PairingOffer>();

export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let raw = "";
  for (const byte of bytes) raw += CODE_ALPHABET[byte % CODE_ALPHABET.length]!;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function createPairingOffer(input: {
  hostId: string;
  label: string;
  token: string;
  ttlMs?: number;
  now?: number;
}): PairingOffer {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? 10 * 60_000;
  // One active offer per process keeps the UI simple and avoids a pile of stale codes.
  offers.clear();
  const offer: PairingOffer = {
    code: generatePairingCode(),
    hostId: input.hostId,
    label: input.label,
    token: input.token,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  offers.set(offer.code, offer);
  return offer;
}

export function peekPairingOffer(now = Date.now()): PairingOffer | undefined {
  for (const [code, offer] of offers) {
    if (offer.expiresAt <= now) {
      offers.delete(code);
      continue;
    }
    return offer;
  }
  return undefined;
}

/**
 * Redeems a one-time pairing code. Success consumes the offer so a replay cannot
 * mint a second hub registration with the same code.
 */
export function redeemPairingOffer(
  code: string,
  now = Date.now(),
): { hostId: string; label: string; token: string } | undefined {
  const normalized = code.trim().toUpperCase();
  const offer = offers.get(normalized);
  if (!offer) return undefined;
  offers.delete(normalized);
  if (offer.expiresAt <= now) return undefined;
  return { hostId: offer.hostId, label: offer.label, token: offer.token };
}

export function clearPairingOffers(): void {
  offers.clear();
}

export function generateSharedToken(): string {
  return randomBytes(24).toString("base64url");
}
