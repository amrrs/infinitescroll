import type { ImageStatus } from "@infinitecanvas/shared";

export type ImageViewModel = {
  index: number;
  prompt: string;
  status: ImageStatus;
  image: string | null;
};
