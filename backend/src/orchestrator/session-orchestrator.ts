import type { WebSocket } from "ws";
import {
  type ClientEvent,
  type ServerEvent,
  GenerateImagesToolSchema
} from "@infinitecanvas/shared";
import { FeedStore } from "../domain/feed/feed-store.js";
import { env } from "../config/env.js";
import { OpenAIResponsesWsClient } from "../integrations/openai/responses-ws-client.js";
import { FalRealtimeTileClient, type FalImageJob } from "../integrations/fal/fal-realtime-client.js";

const SYSTEM_PROMPT = `You are the creative engine for Infinite Scroll, a never-ending AI image feed.

YOUR JOB:
1. When the user describes a theme (e.g. "cyberpunk cities", "underwater worlds", "cozy cafes"), generate a batch of unique, vivid image prompts using the generate_images tool.
2. Each prompt should be a self-contained, detailed description for an image generation model (Flux).
3. Every image should be visually distinct but connected by the theme. Vary composition, subjects, lighting, angles, and mood.
4. Include style keywords: lighting, camera angle, art style, color palette, atmosphere.
5. When asked for more images (load_more), continue the theme with fresh variations. Never repeat a previous prompt. Surprise the user with creative new angles.

RULES:
- Generate 6 images per batch by default
- Each prompt should be 1-3 sentences, rich in visual detail
- Prioritize variety: different subjects, perspectives, times of day, weather, close-ups vs wide shots
- All images priority 1 for initial batch, priority 2 for load_more batches
- Include the themeContext field to track the running theme for continuity
`;

const VARIATION_MODIFIERS = [
  "new subject focus, different composition, distinct time of day, and alternate camera lens",
  "different environment, fresh color palette, and a contrasting mood with unique framing",
  "change perspective dramatically, include a new focal subject, and vary lighting style",
  "switch to a different scene narrative and visual style while preserving the theme intent"
];

const FALLBACK_VARIATIONS = [
  "wide cinematic establishing shot, dramatic lighting, highly detailed",
  "close-up subject focus, shallow depth of field, rich textures",
  "aerial perspective, layered composition, atmospheric haze",
  "night-time scene, neon accents, reflective surfaces, moody contrast",
  "golden-hour lighting, expansive environment, painterly color grading"
];

const tools = [
  {
    type: "function",
    name: "generate_images",
    description: "Generate a batch of image prompts for the infinite scroll feed. Each prompt will be sent to an image generation model.",
    parameters: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "Detailed image generation prompt with style, lighting, composition" },
              priority: { type: "integer", enum: [1, 2, 3], description: "1=immediate, 2=next, 3=background" }
            },
            required: ["prompt", "priority"]
          }
        },
        themeContext: { type: "string", description: "Running theme description for continuity across batches" }
      },
      required: ["images"]
    }
  }
];

type SessionContext = {
  socket: WebSocket;
  feed: FeedStore;
  openai: OpenAIResponsesWsClient;
};

export class SessionOrchestrator {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly feedStores = new Map<string, FeedStore>();
  private readonly fal: FalRealtimeTileClient;
  private readonly followupFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.fal = new FalRealtimeTileClient(env.FAL_KEY, 3, this.onFalImage.bind(this), this.onFalError.bind(this));
  }

  private getOrCreateFeed(sessionId: string): FeedStore {
    let feed = this.feedStores.get(sessionId);
    if (!feed) {
      feed = new FeedStore(sessionId);
      this.feedStores.set(sessionId, feed);
    }
    return feed;
  }

  registerSession(sessionId: string, socket: WebSocket) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.openai.destroy();
    }

    const feed = this.getOrCreateFeed(sessionId);
    const openai = new OpenAIResponsesWsClient(env.OPENAI_API_KEY, env.OPENAI_MODEL, tools, {
      generate_images: async (args, callId) => this.handleGenerateImages(sessionId, args, callId)
    }, (error) => {
      console.error(`[orchestrator] OpenAI error for ${sessionId}:`, error.message);
      this.emit(sessionId, { type: "error", message: `OpenAI: ${error.message}` });
    }, (connected) => {
      this.emitConnectionStatus(sessionId);
    });
    openai.connect();
    this.sessions.set(sessionId, { socket, feed, openai });

    console.log(`[orchestrator] Session ${sessionId} registered`);
    this.emitConnectionStatus(sessionId);
    this.emit(sessionId, { type: "feed_state", feed: feed.getState() });
  }

  unregisterSession(sessionId: string) {
    this.clearFollowupFallback(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.openai.destroy();
      this.sessions.delete(sessionId);
      console.log(`[orchestrator] Session ${sessionId} unregistered`);
    }
  }

  async onClientEvent(sessionId: string, event: ClientEvent) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (event.type === "session_init") {
      this.emit(sessionId, { type: "feed_state", feed: session.feed.getState() });
      return;
    }

    if (event.type === "user_prompt") {
      // New prompt should start a fresh feed, not mix with prior themes.
      session.feed.reset(event.text);
      this.emit(sessionId, { type: "feed_state", feed: session.feed.getState() });

      // Fast-first-image: immediately submit one job using the user's exact intent,
      // then let OpenAI generate varied follow-ups.
      this.submitImmediateFirstImage(sessionId, event.text);
      this.scheduleFollowupFallback(sessionId, event.text);
      try {
        const diversityHint = this.buildDiversityHint(session.feed);
        await session.openai.enqueueUserMessage(
          `Generate 5 additional images for the theme: "${event.text}".
The first image is already being generated from the user's prompt.

MANDATORY OUTPUT SHAPE FOR THIS BATCH:
- Do NOT repeat the user's exact first prompt.
- All 5 images must explore distinct visual angles (subject, setting, scale, time, weather, mood, or camera language).
- Keep every prompt grounded in the same original theme; no off-theme drift.
- You MUST call the generate_images tool exactly once for this request.
${diversityHint}`,
          SYSTEM_PROMPT
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown OpenAI error";
        this.emit(sessionId, { type: "error", message });
      }
      return;
    }

    if (event.type === "load_more") {
      const theme = session.feed.getState().theme;
      if (!theme) {
        this.emit(sessionId, { type: "error", message: "Send a prompt first" });
        return;
      }
      const imageCount = session.feed.imageCount();
      const diversityHint = this.buildDiversityHint(session.feed);
      this.scheduleFollowupFallback(sessionId, theme, event.count);
      try {
        await session.openai.enqueueUserMessage(
          `Generate ${event.count} more images continuing the "${theme}" theme.
We already have ${imageCount} images.
MANDATORY: Every new prompt must be meaningfully different from prior prompts and from each other.
Avoid repeated nouns, duplicated scene setups, and near-identical camera framing.
${diversityHint}`,
          SYSTEM_PROMPT
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown OpenAI error";
        this.emit(sessionId, { type: "error", message });
      }
      return;
    }
  }

  private async handleGenerateImages(sessionId: string, args: unknown, callId: string) {
    this.clearFollowupFallback(sessionId);
    const parsed = GenerateImagesToolSchema.safeParse(args);
    if (!parsed.success) {
      console.error("[orchestrator] Invalid generate_images:", parsed.error.message);
      this.emit(sessionId, { type: "error", message: "Invalid generate_images payload from LLM" });
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (parsed.data.themeContext) {
      session.feed.setTheme(parsed.data.themeContext);
    }

    console.log(`[orchestrator] generate_images: ${parsed.data.images.length} images`);

    if (parsed.data.images.length === 0) {
      const theme = session.feed.getState().theme;
      this.submitFallbackBatch(sessionId, theme, 5);
      session.openai.enqueueFunctionOutput(callId, {
        status: "accepted",
        queued: 5,
        mode: "fallback"
      });
      return;
    }

    const indices: number[] = [];
    const seenPrompts = new Set(
      session.feed.getState().images.map((img) => this.normalizePrompt(img.prompt))
    );

    for (const img of parsed.data.images) {
      const uniquePrompt = this.ensureUniquePrompt(img.prompt, seenPrompts, session.feed.imageCount() + indices.length);
      const slot = session.feed.allocateSlot(uniquePrompt);
      indices.push(slot.index);

      this.emit(sessionId, { type: "image_status", index: slot.index, status: "generating" });

      const job: FalImageJob = {
        sessionId,
        index: slot.index,
        prompt: uniquePrompt,
        priority: img.priority,
        seed: Math.floor(Math.random() * 1_000_000) + slot.index
      };
      this.fal.submit(job);
    }

    // Send full state so frontend gets prompt text for all slots
    this.emit(sessionId, { type: "feed_state", feed: session.feed.getState() });

    session.openai.enqueueFunctionOutput(callId, {
      status: "accepted",
      queued: indices.length,
      indices
    });
  }

  private onFalImage(job: FalImageJob, imageData: string) {
    const session = this.sessions.get(job.sessionId);
    if (!session) return;
    const isUrl = imageData.startsWith("http://") || imageData.startsWith("https://");
    const imageForClient = isUrl ? imageData : `data:image/jpeg;base64,${imageData}`;
    session.feed.setImage(job.index, imageForClient);
    this.emit(job.sessionId, {
      type: "image_update",
      index: job.index,
      prompt: job.prompt,
      image: imageForClient,
      status: "ready"
    });
  }

  private onFalError(job: FalImageJob, error: Error) {
    const session = this.sessions.get(job.sessionId);
    if (session) {
      session.feed.setStatus(job.index, "failed");
    }
    this.emit(job.sessionId, {
      type: "error",
      message: `Image #${job.index} failed: ${error.message}`
    });
    this.emit(job.sessionId, { type: "image_status", index: job.index, status: "failed" });
  }

  private emitConnectionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.emit(sessionId, {
      type: "connection_status",
      openai: !session.openai.configured ? "unconfigured" : session.openai.connected ? "connected" : "disconnected",
      fal: this.falReady ? "ready" : "unavailable"
    });
  }

  private get falReady(): boolean {
    return Boolean(env.FAL_KEY);
  }

  private buildDiversityHint(feed: FeedStore): string {
    const recent = feed.getState().images.slice(-12).map((img) => img.prompt.trim()).filter(Boolean);
    if (recent.length === 0) {
      return "No prior prompts exist yet. Maximize diversity within this batch.";
    }
    const bullets = recent.map((p) => `- ${p}`).join("\n");
    return `Avoid repeating or lightly rewording these prior prompts:\n${bullets}`;
  }

  private submitImmediateFirstImage(sessionId: string, theme: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const firstPrompt = `${theme}. Ultra-detailed, strong composition, high visual clarity.`;
    const slot = session.feed.allocateSlot(firstPrompt);
    this.emit(sessionId, { type: "image_status", index: slot.index, status: "generating" });
    this.emit(sessionId, { type: "feed_state", feed: session.feed.getState() });

    const job: FalImageJob = {
      sessionId,
      index: slot.index,
      prompt: firstPrompt,
      priority: 1,
      seed: Math.floor(Math.random() * 1_000_000) + slot.index
    };
    this.fal.submit(job);
  }

  private scheduleFollowupFallback(sessionId: string, theme: string, count = 5) {
    this.clearFollowupFallback(sessionId);
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      // If OpenAI does not produce tool output quickly, backfill with server-side prompts.
      // We key on "still no new slots since request" by checking low growth heuristically.
      if (session.feed.imageCount() <= 1 || count > 0) {
        console.warn(`[orchestrator] OpenAI follow-up timeout for ${sessionId}; using fallback prompts`);
        this.submitFallbackBatch(sessionId, theme, count);
      }
    }, 4500);
    this.followupFallbackTimers.set(sessionId, timer);
  }

  private clearFollowupFallback(sessionId: string) {
    const timer = this.followupFallbackTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.followupFallbackTimers.delete(sessionId);
    }
  }

  private submitFallbackBatch(sessionId: string, theme: string, count: number) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (let i = 0; i < count; i += 1) {
      const modifier = FALLBACK_VARIATIONS[i % FALLBACK_VARIATIONS.length];
      const prompt = `${theme}. ${modifier}.`;
      const slot = session.feed.allocateSlot(prompt);
      this.emit(sessionId, { type: "image_status", index: slot.index, status: "generating" });
      const job: FalImageJob = {
        sessionId,
        index: slot.index,
        prompt,
        priority: 2,
        seed: Math.floor(Math.random() * 1_000_000) + slot.index
      };
      this.fal.submit(job);
    }
    this.emit(sessionId, { type: "feed_state", feed: session.feed.getState() });
  }

  private normalizePrompt(prompt: string): string {
    return prompt.toLowerCase().replace(/\s+/g, " ").trim();
  }

  private ensureUniquePrompt(prompt: string, seenPrompts: Set<string>, salt: number): string {
    let candidate = prompt.trim();
    let normalized = this.normalizePrompt(candidate);
    if (!seenPrompts.has(normalized)) {
      seenPrompts.add(normalized);
      return candidate;
    }

    const modifier = VARIATION_MODIFIERS[salt % VARIATION_MODIFIERS.length];
    candidate = `${candidate}. Variation requirement: ${modifier}.`;
    normalized = this.normalizePrompt(candidate);
    seenPrompts.add(normalized);
    return candidate;
  }

  private emit(sessionId: string, event: ServerEvent) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      session.socket.send(JSON.stringify(event));
    } catch {
      // socket already closed
    }
  }
}
