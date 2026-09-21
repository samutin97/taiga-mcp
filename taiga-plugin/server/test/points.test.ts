import { describe, it, expect, vi } from "vitest";
import { roundUpToScale, pointScale } from "../src/points.js";
import type { ToolContext } from "../src/context.js";

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

  it("пустая шкала возвращает сумму как есть", () => {
    expect(roundUpToScale(5, [])).toBe(5);
  });

  it("сумма 0 совпадает с нулевым значением шкалы", () => {
    expect(roundUpToScale(0, scale)).toBe(0);
  });

  it("поднимает дробную сумму до ближайшего дробного значения шкалы", () => {
    expect(roundUpToScale(0.3, scale)).toBe(0.5);
  });
});

describe("pointScale", () => {
  it("отфильтровывает «?» (null) и сортирует значения по возрастанию", async () => {
    const ctx = {
      client: {
        list: vi.fn(async () => ({
          items: [
            { id: 1, name: "?", value: null },
            { id: 8, name: "8", value: 8 },
            { id: 2, name: "0", value: 0 },
            { id: 4, name: "1", value: 1 },
            { id: 7, name: "5", value: 5 },
          ],
          total: 5,
          page: 1,
          hasMore: false,
        })),
      },
    } as unknown as ToolContext;

    await expect(pointScale(ctx, 1)).resolves.toEqual([0, 1, 5, 8]);
    expect(ctx.client.list).toHaveBeenCalledWith("/points", { project: 1, page_size: 1000 });
  });
});
