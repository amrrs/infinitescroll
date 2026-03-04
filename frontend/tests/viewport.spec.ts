import { describe, it, expect } from "vitest";
import type { ImageViewModel } from "../src/features/tiles/tile-store";

describe("ImageViewModel", () => {
  it("satisfies the expected shape", () => {
    const img: ImageViewModel = {
      index: 0,
      prompt: "sunset over mountains",
      status: "ready",
      image: "https://example.com/img.jpg"
    };
    expect(img.index).toBe(0);
    expect(img.status).toBe("ready");
  });
});
