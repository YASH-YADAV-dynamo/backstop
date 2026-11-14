import { isNearAccountId } from "@/lib/validate";

export const BAD_POLICY_MESSAGE = "The policy parameter must be a NEAR account id (2-64 characters: lowercase letters, digits, - _ and dots).";

/** What a person sees when they type something that is not a vault account (the /app form and the dashboard link). */
export const BAD_VAULT_INPUT = "That isn't a NEAR account name (like alice.backstop.near).";

/** `undefined` = not given; `null` = given but invalid. */
export function parsePolicyParam(value: string | null | undefined): string | undefined | null {
  if (value === null || value === undefined || value === "") return undefined;
  return isNearAccountId(value) ? value : null;
}
