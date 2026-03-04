import { fal } from "@fal-ai/client";

export type FalImageJob = {
  sessionId: string;
  index: number;
  prompt: string;
  priority: 1 | 2 | 3;
  seed: number;
  referenceImageUrl?: string;
  attempts?: number;
  generation?: number;
};

type OnImage = (job: FalImageJob, imageData: string) => void;
type OnError = (job: FalImageJob, error: Error) => void;

const FAL_REALTIME_APP = "fal-ai/flux-2/klein/realtime";
const EMPTY_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axXxK4AAAAASUVORK5CYII=";

export class FalRealtimeTileClient {
  private readonly queues: Record<1 | 2 | 3, FalImageJob[]> = { 1: [], 2: [], 3: [] };
  private active = 0;
  private drainQueued = false;

  constructor(
    private readonly falKey: string | undefined,
    private readonly concurrency: number,
    private readonly onImage: OnImage,
    private readonly onError: OnError
  ) {
    if (this.falKey) {
      fal.config({ credentials: this.falKey });
      console.log("[fal] Configured realtime app", FAL_REALTIME_APP);
    }
  }

  submit(job: FalImageJob) {
    this.queues[job.priority].push(job);
    this.scheduleDrain();
  }

  private scheduleDrain() {
    if (this.drainQueued) return;
    this.drainQueued = true;
    queueMicrotask(() => {
      this.drainQueued = false;
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.concurrency) {
      const next = this.dequeue();
      if (!next) return;
      this.active += 1;
      this.sendToFal(next);
    }
  }

  private dequeue(): FalImageJob | undefined {
    return this.queues[1].shift() ?? this.queues[2].shift() ?? this.queues[3].shift();
  }

  private async sendToFal(job: FalImageJob) {
    if (!this.falKey) {
      this.onImage(job, this.mockImage(job.prompt));
      this.active = Math.max(0, this.active - 1);
      this.scheduleDrain();
      return;
    }

    try {
      console.log(`[fal] Generating image #${job.index} (priority ${job.priority})`);
      const imageData = await this.generateRealtime(job);
      if (!imageData) {
        this.handleFailure(job, new Error("fal returned no image"));
        return;
      }

      console.log(`[fal] Image #${job.index} ready`);
      this.onImage(job, imageData);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleFailure(job, error);
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.scheduleDrain();
    }
  }

  private async generateRealtime(job: FalImageJob): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { connection.close(); } catch {}
        reject(new Error("fal realtime timeout"));
      }, 20000);

      const finalizeResolve = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { connection.close(); } catch {}
        resolve(value);
      };

      const finalizeReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { connection.close(); } catch {}
        reject(error);
      };

      const connection = fal.realtime.connect(FAL_REALTIME_APP, {
        onResult: (result: unknown) => {
          const imageData = this.extractImageData(result);
          if (imageData) {
            finalizeResolve(imageData);
          }
        },
        onError: (error: { message?: string }) => {
          finalizeReject(new Error(error?.message ?? "fal realtime error"));
        }
      });

      try {
        const refUrl = job.referenceImageUrl!;
        const refSize = refUrl.length > 100 ? `${Math.round(refUrl.length / 1024)}KB data-uri` : refUrl.slice(0, 60);
        const payload: Record<string, unknown> = {
          prompt: job.prompt,
          image_url: refUrl,
          image_size: "square_hd",
          num_inference_steps: 2,
          schedule_mu: 1.2,
          seed: job.seed
        };
        console.log(`[fal] Sending job #${job.index}: ref=${refSize}, steps=2, mu=1.2`);
        console.log(`[fal]   prompt: "${job.prompt.slice(0, 100)}..."`);
        connection.send(payload);
      } catch (error) {
        finalizeReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private extractImageData(result: unknown): string | undefined {
    const maybe = result as {
      images?: Array<unknown>;
      output?: { images?: Array<unknown> };
      data?: { images?: Array<unknown> };
    };
    const image =
      maybe.images?.[0] ??
      maybe.output?.images?.[0] ??
      maybe.data?.images?.[0];
    if (!image) return undefined;

    if (typeof image === "string") return image;
    if (typeof image === "object" && image !== null) {
      const record = image as Record<string, unknown>;
      const url = record.url;
      const content = record.content;
      if (typeof url === "string") return url;

      const normalized = this.normalizeContentToBase64(content);
      if (normalized) return normalized;
    }
    return undefined;
  }

  private normalizeContentToBase64(content: unknown): string | undefined {
    if (typeof content === "string") return content;

    if (content instanceof Uint8Array) {
      return Buffer.from(content).toString("base64");
    }

    if (ArrayBuffer.isView(content)) {
      const view = content as ArrayBufferView;
      return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
    }

    if (content instanceof ArrayBuffer) {
      return Buffer.from(content).toString("base64");
    }

    if (Array.isArray(content) && content.every((v) => typeof v === "number")) {
      return Buffer.from(content).toString("base64");
    }

    return undefined;
  }

  private handleFailure(job: FalImageJob, error: Error) {
    const attempts = job.attempts ?? 0;
    if (attempts >= 2) {
      console.error(`[fal] Image #${job.index} failed after ${attempts + 1} attempts:`, error.message);
      this.onError(job, error);
      return;
    }
    const retryDelayMs = 500 * (attempts + 1);
    console.log(`[fal] Retry image #${job.index} attempt=${attempts + 1}`);
    setTimeout(() => this.submit({ ...job, attempts: attempts + 1 }), retryDelayMs);
  }

  private mockImage(text: string): string {
    return Buffer.from(`mock:${text.slice(0, 64)}`).toString("base64");
  }
}
