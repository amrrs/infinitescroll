import { describe, it, expect } from "vitest";
import { FeedStore } from "../src/domain/feed/feed-store.js";

describe("FeedStore", () => {
  it("allocates slots with sequential indices", () => {
    const store = new FeedStore("test-1");
    const a = store.allocateSlot("sunset over mountains");
    const b = store.allocateSlot("moonlit forest");
    expect(a.index).toBe(0);
    expect(b.index).toBe(1);
    expect(store.imageCount()).toBe(2);
  });

  it("sets image url and status to ready", () => {
    const store = new FeedStore("test-2");
    store.allocateSlot("ocean waves");
    store.setImage(0, "https://example.com/img.jpg");
    const state = store.getState();
    expect(state.images[0].imageUrl).toBe("https://example.com/img.jpg");
    expect(state.images[0].status).toBe("ready");
  });

  it("tracks theme", () => {
    const store = new FeedStore("test-3");
    store.setTheme("cyberpunk cities");
    expect(store.getState().theme).toBe("cyberpunk cities");
  });

  it("sets status on existing images", () => {
    const store = new FeedStore("test-4");
    store.allocateSlot("test prompt");
    store.setStatus(0, "generating");
    expect(store.getState().images[0].status).toBe("generating");
    store.setStatus(0, "failed");
    expect(store.getState().images[0].status).toBe("failed");
  });
});
