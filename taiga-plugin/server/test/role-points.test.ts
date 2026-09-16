import { describe, it, expect } from "vitest";
import { withRoleTag } from "../src/role-points.js";

describe("тег роли", () => {
  it("снимает прежнюю роль и ставит новую", () => {
    expect(withRoleTag(["front", "оплата"], "back")).toEqual(["оплата", "back"]);
  });

  it("не плодит дубликаты", () => {
    expect(withRoleTag(["back"], "back")).toEqual(["back"]);
  });

  it("не трогает прочие теги", () => {
    expect(withRoleTag(["оплата"], "ux")).toEqual(["оплата", "ux"]);
  });
});
