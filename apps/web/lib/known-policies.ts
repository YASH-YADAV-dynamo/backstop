/** The policies this browser knows for one owner (one per chain). Pure helpers; storage lives in policy-context. */
import { z } from "zod";
import { isNearAccountId } from "@/lib/validate";

const listSchema = z.array(z.string());

/** Stored JSON list -> valid NEAR account ids. Bad JSON or a wrong shape is an empty list. */
export function parsePolicyList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = listSchema.safeParse(JSON.parse(raw));
    return parsed.success ? dedupe(parsed.data.filter(isNearAccountId)) : [];
  } catch {
    return [];
  }
}

export const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)];

/** Every source in order: factory answer, saved list, the site's default policy. Invalid ids are dropped. */
export function mergeKnown(factory: readonly string[] | undefined, saved: readonly string[], envDefault: string | undefined): string[] {
  return dedupe([...(factory ?? []), ...saved, ...(envDefault ? [envDefault] : [])]).filter(isNearAccountId);
}

/** Saved list after the user picked `id`: it moves to the front, so it is the default on the next visit. */
export const withChosen = (saved: readonly string[], id: string): string[] => dedupe([id, ...saved]);
export const without = (saved: readonly string[], id: string): string[] => saved.filter((x) => x !== id);
