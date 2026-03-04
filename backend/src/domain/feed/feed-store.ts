import type { FeedImage, FeedState, ImageStatus } from "@infinitecanvas/shared";

export class FeedStore {
  private readonly state: FeedState;

  constructor(id: string) {
    this.state = {
      id,
      theme: "",
      images: [],
      nextIndex: 0
    };
  }

  getState(): FeedState {
    return this.state;
  }

  setTheme(theme: string) {
    this.state.theme = theme;
  }

  reset(theme: string) {
    this.state.theme = theme;
    this.state.images = [];
    this.state.nextIndex = 0;
  }

  allocateSlot(prompt: string): FeedImage {
    const img: FeedImage = {
      id: `img_${this.state.nextIndex}`,
      index: this.state.nextIndex,
      prompt,
      imageUrl: null,
      status: "pending",
      lastUpdated: Date.now()
    };
    this.state.images.push(img);
    this.state.nextIndex += 1;
    return img;
  }

  setStatus(index: number, status: ImageStatus) {
    const img = this.state.images.find((i) => i.index === index);
    if (img) {
      img.status = status;
      img.lastUpdated = Date.now();
    }
  }

  setImage(index: number, imageUrl: string) {
    const img = this.state.images.find((i) => i.index === index);
    if (img) {
      img.imageUrl = imageUrl;
      img.status = "ready";
      img.lastUpdated = Date.now();
    }
  }

  imageCount(): number {
    return this.state.images.length;
  }
}
