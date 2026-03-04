import type { WebSocket } from "ws";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  type ClientEvent,
  type ServerEvent,
  GenerateImagesToolSchema
} from "@infinitecanvas/shared";
import { FeedStore } from "../domain/feed/feed-store.js";
import { env } from "../config/env.js";
import { OpenAIResponsesWsClient } from "../integrations/openai/responses-ws-client.js";
import { FalRealtimeTileClient, type FalImageJob } from "../integrations/fal/fal-realtime-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(resolve(__dirname, "../config/system-prompt.txt"), "utf-8");

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

const EXPANSION_AXES = [
  "camera distance and lens language",
  "subject emphasis and composition geometry",
  "lighting setup and contrast style",
  "environment/time/weather framing",
  "color palette and visual mood"
];

const ENABLE_LOCAL_PROMPT_FALLBACK = false;

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
  referenceImageUrl?: string;
  guidanceText?: string;
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
      if (!event.referenceImage) {
        this.emit(sessionId, { type: "error", message: "A reference image is required for Flux 2 Klein." });
        return;
      }
      // New prompt should start a fresh feed, not mix with prior themes.
      session.feed.reset(event.text);
      session.referenceImageUrl = event.referenceImage;
      session.guidanceText = event.text;
      // Fire the first image immediately so the user sees something fast.
      this.submitImmediateFirstImage(sessionId, event.text);

      // Ask OpenAI for 3 more (we already submitted 3 immediate ones above).
      try {
        const diversityHint = this.buildDiversityHint(session.feed);
        await session.openai.enqueueUserMessage(
          `Generate 3 transformation prompts for the user's reference image.
Direction: "${event.text}"
Each prompt transforms the uploaded photo. Write 1-2 sentence prompts starting with "Turn this into..." or "Restyle as...".
Call generate_images once with 3 prompts.
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
      if (ENABLE_LOCAL_PROMPT_FALLBACK) {
        this.scheduleFollowupFallback(sessionId, theme, event.count, session.feed.imageCount());
      }
      try {
        await session.openai.enqueueUserMessage(
          `Generate ${event.count} more transformation prompts for the user's reference image.
Theme: "${theme}". We already have ${imageCount} variations.
Each prompt transforms the SAME reference photo with a new artistic treatment.
Write short prompts (1-2 sentences) starting with "Turn this into..." or "Restyle as...".
Every prompt must be a distinctly different visual treatment from prior ones.
Call generate_images exactly once.
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

    console.log(`[orchestrator] generate_images: ${parsed.data.images.length} images, ref=${Boolean(session.referenceImageUrl)}`);
    for (const img of parsed.data.images) {
      console.log(`[orchestrator]   prompt: "${img.prompt.slice(0, 120)}..." prio=${img.priority}`);
    }

    if (parsed.data.images.length === 0) {
      if (ENABLE_LOCAL_PROMPT_FALLBACK) {
        const theme = session.feed.getState().theme;
        this.submitFallbackBatch(sessionId, theme, 5);
        session.openai.enqueueFunctionOutput(callId, {
          status: "accepted",
          queued: 5,
          mode: "fallback"
        });
      } else {
        this.emit(sessionId, {
          type: "error",
          message: "OpenAI returned an empty prompt batch. Please retry."
        });
        session.openai.enqueueFunctionOutput(callId, {
          status: "rejected",
          queued: 0,
          mode: "empty_openai_batch"
        });
      }
      return;
    }

    const indices: number[] = [];
    const seenPrompts = new Set(
      session.feed.getState().images.map((img) => this.normalizePrompt(img.prompt))
    );

    for (const img of parsed.data.images) {
      const uniquePrompt = this.ensureUniquePrompt(img.prompt, seenPrompts, session.feed.imageCount() + indices.length);
      const expandedPrompt = this.deLiteralizePrompt(uniquePrompt, session.guidanceText);
      const slot = session.feed.allocateSlot(expandedPrompt);
      indices.push(slot.index);

      this.emit(sessionId, { type: "image_status", index: slot.index, status: "generating" });

      const job: FalImageJob = {
        sessionId,
        index: slot.index,
        prompt: expandedPrompt,
        priority: img.priority,
        referenceImageUrl: session.referenceImageUrl,
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
    if (typeof imageData !== "string" || imageData.length === 0) {
      this.onFalError(job, new Error("fal returned invalid image payload"));
      return;
    }
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
    if (!session || !session.referenceImageUrl) return;

    const immediatePrompts = [
      `Turn this into a refined version with enhanced lighting and polished details inspired by: ${theme}`,
      `Restyle as a cinematic scene with dramatic color grading and moody atmosphere, guided by: ${theme}`,
      `Apply a bold artistic transformation with vibrant colors and stylized rendering inspired by: ${theme}`
    ];

    for (const prompt of immediatePrompts) {
      const slot = session.feed.allocateSlot(prompt);
      this.emit(sessionId, { type: "image_status", index: slot.index, status: "generating" });
      this.fal.submit({
        sessionId,
        index: slot.index,
        prompt,
        priority: 1,
        referenceImageUrl: session.referenceImageUrl,
        seed: Math.floor(Math.random() * 1_000_000) + slot.index
      });
    }

    this.emit(sessionId, { type: "feed_state", feed: session.feed.getState() });
  }

  private scheduleFollowupFallback(sessionId: string, theme: string, count = 5, baselineCount = 0) {
    this.clearFollowupFallback(sessionId);
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      // Only fallback if no new slots were allocated since this request.
      if (session.feed.imageCount() <= baselineCount) {
        console.warn(`[orchestrator] OpenAI follow-up timeout for ${sessionId}; using fallback prompts`);
        this.submitFallbackBatch(sessionId, theme, count);
      }
    }, 8000);
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
      const prompt = this.deLiteralizePrompt(this.buildFallbackPrompt(theme, i), session.guidanceText ?? theme);
      const slot = session.feed.allocateSlot(prompt);
      this.emit(sessionId, { type: "image_status", index: slot.index, status: "generating" });
      const job: FalImageJob = {
        sessionId,
        index: slot.index,
        prompt,
        priority: 2,
        referenceImageUrl: session.referenceImageUrl,
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

  private buildFallbackPrompt(theme: string, index: number): string {
    const modifier = FALLBACK_VARIATIONS[index % FALLBACK_VARIATIONS.length];
    const axis = EXPANSION_AXES[index % EXPANSION_AXES.length];
    const concept = this.toConcept(theme);
    const sceneTemplates = [
      `A high-impact hero composition centered on ${concept}, with one dominant subject, strong visual hierarchy, and clean negative space for optional title text`,
      `Dynamic mid-action scene expressing ${concept}, with layered depth from foreground to background and a clear focal point`,
      `Cinematic wide frame interpreting ${concept} in a fresh setting, combining environmental storytelling with a readable central subject`,
      `Editorial-style close-up built around ${concept}, emphasizing texture, expression, and controlled background separation`,
      `Bold concept-art interpretation of ${concept}, with graphic shape language, intentional contrast, and clear composition geometry`
    ];
    const base = sceneTemplates[index % sceneTemplates.length];
    return `${base}. Focus on ${axis}. ${modifier}.`;
  }

  private deLiteralizePrompt(prompt: string, guidanceText?: string): string {
    if (!guidanceText) return prompt;
    const guidance = guidanceText.trim();
    if (!guidance) return prompt;

    const escaped = guidance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "ig");
    const replaced = prompt.replace(regex, "the core concept");
    return replaced.replace(/\s+/g, " ").trim();
  }

  private toConcept(guidanceText: string): string {
    const cleaned = guidanceText
      .toLowerCase()
      .replace(/["']/g, "")
      .replace(/\b(ideas?|idea|for|about|please|generate|make|create|image|images|prompt|prompts)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "the user's creative direction";
    return cleaned;
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
