import { describe, it, expect } from "vitest";
import { GenerateImagesToolSchema } from "../src/index.js";

describe("GenerateImagesToolSchema", () => {
  it("validates a correct payload", () => {
    const result = GenerateImagesToolSchema.safeParse({
      images: [
        { prompt: "sunset over mountains", priority: 1 },
        { prompt: "moonlit forest", priority: 2 }
      ],
      themeContext: "nature"
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 12 images", () => {
    const images = Array.from({ length: 13 }, (_, i) => ({
      prompt: `image ${i}`,
      priority: 1
    }));
    const result = GenerateImagesToolSchema.safeParse({ images });
    expect(result.success).toBe(false);
  });

  it("rejects empty images array", () => {
    const result = GenerateImagesToolSchema.safeParse({ images: [] });
    expect(result.success).toBe(false);
  });
});
