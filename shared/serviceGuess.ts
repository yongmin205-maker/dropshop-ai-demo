/**
 * Lightweight keyword-based salon service guesser.
 *
 * Shared between the server agent (`server/salonAgent.ts → guessServiceCategory`)
 * and the client's optimistic Booking Draft preview (`client/src/pages/Salon.tsx`).
 * Before this file existed each side had its own copy and they could drift —
 * a server fix wouldn't reach the optimistic UI hint until someone manually
 * mirrored it. (CODE_AUDIT P1)
 *
 * The list intentionally lives in `shared/` so the type union and the
 * keyword table are the single source of truth, with no runtime DB
 * dependencies (so the client bundle stays lean).
 */

export type SalonServiceCategory =
  | "cut"
  | "perm"
  | "color"
  | "balayage"
  | "manicure"
  | "pedicure"
  | "hairspa";

const SERVICE_KEYWORDS: Record<SalonServiceCategory, string[]> = {
  // Order matters: more specific patterns come first so "balayage" doesn't
  // get swallowed by "color", and "perm" doesn't get matched by a generic cut.
  balayage: ["balayage", "highlight", "ombre", "babylight"],
  perm: ["perm", "permanent wave", "magic wave", "magic"],
  color: ["color", "colour", "dye", "single process", "root touch"],
  cut: ["cut", "trim", "haircut", "style", "blow"],
  manicure: ["manicure", "nails"],
  pedicure: ["pedicure", "pedi"],
  hairspa: ["spa", "treatment", "deep condition", "scalp"],
};

export function guessSalonService(body: string): SalonServiceCategory | null {
  const lower = body.toLowerCase();
  for (const [cat, kws] of Object.entries(SERVICE_KEYWORDS) as Array<
    [SalonServiceCategory, string[]]
  >) {
    if (kws.some((k) => lower.includes(k))) return cat;
  }
  return null;
}

export const SALON_SERVICE_KEYWORDS = SERVICE_KEYWORDS;
