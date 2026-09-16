import { describe, it, expect } from "vitest";
import { roundUpToScale } from "../src/points.js";

describe("округление до шкалы", () => {
  const scale = [0, 0.5, 1, 2, 3, 5, 8, 10, 13, 20, 40];

  it("поднимает сумму до ближайшего значения шкалы", () => {
    expect(roundUpToScale(7, scale)).toBe(8);
  });

  it("оставляет точное совпадение как есть", () => {
    expect(roundUpToScale(20, scale)).toBe(20);
  });

  it("не превышает максимум шкалы", () => {
    expect(roundUpToScale(41, scale)).toBe(40);
  });
});
