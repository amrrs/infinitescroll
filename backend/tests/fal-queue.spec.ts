import { describe, it, expect } from "vitest";
import { FalRealtimeTileClient, type FalImageJob } from "../src/integrations/fal/fal-realtime-client.js";

describe("FalRealtimeTileClient priority ordering", () => {
  it("processes priority 1 before 2 before 3", async () => {
    const results: number[] = [];
    const client = new FalRealtimeTileClient(
      undefined,
      1,
      (job: FalImageJob) => { results.push(job.priority); },
      () => {}
    );

    client.submit({ sessionId: "s", index: 0, prompt: "p3", priority: 3, seed: 1 });
    client.submit({ sessionId: "s", index: 1, prompt: "p1", priority: 1, seed: 2 });
    client.submit({ sessionId: "s", index: 2, prompt: "p2", priority: 2, seed: 3 });

    await new Promise((r) => setTimeout(r, 100));
    expect(results[0]).toBe(1);
    expect(results[1]).toBe(2);
    expect(results[2]).toBe(3);
  });
});
