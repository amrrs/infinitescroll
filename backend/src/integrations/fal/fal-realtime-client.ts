import { fal } from "@fal-ai/client";

export type FalImageJob = {
  sessionId: string;
  index: number;
  prompt: string;
  priority: 1 | 2 | 3;
  seed: number;
  attempts?: number;
};

type OnImage = (job: FalImageJob, imageData: string) => void;
type OnError = (job: FalImageJob, error: Error) => void;

const FAL_MODEL = "fal-ai/flux/schnell";

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
      console.log("[fal] Configured with", FAL_MODEL);
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
      const result = await fal.subscribe(FAL_MODEL, {
        input: {
          prompt: job.prompt,
          image_size: "landscape_16_9",
          num_inference_steps: 4,
          seed: job.seed,
          num_images: 1,
          enable_safety_checker: false
        }
      });

      const image = (result.data as { images?: Array<{ url?: string; content?: string }> }).images?.[0];
      const imageData = image?.url ?? image?.content;
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
