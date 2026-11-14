import { describe, expect, it } from "vitest";
import { mergeKnown, parsePolicyList, withChosen, without } from "@/lib/known-policies";

describe("the per-owner list of known policies", () => {
  it("bad JSON or a wrong shape is an empty list", () => {
    expect(parsePolicyList("not json")).toEqual([]);
    expect(parsePolicyList('{"a":1}')).toEqual([]);
    expect(parsePolicyList(null)).toEqual([]);
  });
  it("ids that are not NEAR accounts are dropped and duplicates collapse", () => {
    expect(parsePolicyList('["a.backstop.near","a.backstop.near","NOT VALID","a-arb.backstop.near"]')).toEqual(["a.backstop.near", "a-arb.backstop.near"]);
  });
  it("factory, saved and default are merged in that order without duplicates", () => {
    expect(mergeKnown(["f.near"], ["s.near", "f.near"], "d.near")).toEqual(["f.near", "s.near", "d.near"]);
    expect(mergeKnown(undefined, [], undefined)).toEqual([]);
  });
  it("choosing a policy moves it to the front and forgetting removes it", () => {
    expect(withChosen(["a.near", "b.near"], "b.near")).toEqual(["b.near", "a.near"]);
    expect(without(["a.near", "b.near"], "a.near")).toEqual(["b.near"]);
  });
});
