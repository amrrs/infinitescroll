import type { WebSocket } from "ws";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  type ClientEvent,
  type ServerEvent
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

type SessionContext = {
  socket: WebSocket;
  feed: FeedStore;
  openai: OpenAIResponsesWsClient;
  referenceImageUrl?: string;
  guidanceText?: string;
  generation: number;
};

export class SessionOrchestrator {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly feedStores = new Map<string, FeedStore>();
  private readonly fal: FalRealtimeTileClient;

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
    const openai = new OpenAIResponsesWsClient(
      env.OPENAI_API_KEY,
      env.OPENAI_MODEL,
      (prompts) => this.handlePrompts(sessionId, prompts),
      (error) => {
        console.error(`[orchestrator] OpenAI error for ${sessionId}:`, error.message);
        this.emit(sessionId, { type: "error", message: `OpenAI: ${error.message}` });
      },
      (connected) => {
        console.log(`[orchestrator] OpenAI status → ${connected ? "connected" : "disconnected"} for ${sessionId}`);
        this.emitConnectionStatus(sessionId);
      }
    );
    openai.connect();
    this.sessions.set(sessionId, { socket, feed, openai, generation: 0 });

    console.log(`[orchestrator] Session ${sessionId} registered`);
    this.emitConnectionStatus(sessionId);
    this.emit(sessionId, { type: "feed_state", feed: feed.getState() });

    // Re-emit after OpenAI has had time to connect (guard against missed callback)
    setTimeout(() => this.emitConnectionStatus(sessionId), 3000);
  }

  unregisterSession(sessionId: string) {
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

    if (event.type === "reset_feed") {
      session.generation += 1;
      session.feed.reset("");
      session.referenceImageUrl = undefined;
      session.guidanceText = undefined;
      // Kill the current OpenAI connection so pending responses are discarded
      session.openai.destroy();
      const openai = new OpenAIResponsesWsClient(
        env.OPENAI_API_KEY,
        env.OPENAI_MODEL,
        (prompts) => this.handlePrompts(sessionId, prompts),
        (error) => {
          console.error(`[orchestrator] OpenAI error for ${sessionId}:`, error.message);
          this.emit(sessionId, { type: "error", message: `OpenAI: ${error.message}` });
        },
        (connected) => {
          console.log(`[orchestrator] OpenAI status → ${connected ? "connected" : "disconnected"} for ${sessionId}`);
          this.emitConnectionStatus(sessionId);
        }
      );
      openai.connect();
      session.openai = openai;
      console.log(`[orchestrator] Feed reset for ${sessionId}, generation=${session.generation}`);
      this.emit(sessionId, { type: "feed_state", feed: session.feed.getState() });
      this.emitConnectionStatus(sessionId);
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

      // Fire 2 immediate images so users see progress while OpenAI thinks
      this.submitImmediateLoadMore(sessionId, theme);

      const imageCount = session.feed.imageCount();
      const diversityHint = this.buildDiversityHint(session.feed);
      try {
        await session.openai.enqueueUserMessage(
          `Generate 3 more transformation prompts for the user's reference image.
Theme: "${theme}". We already have ${imageCount} variations.
Each prompt transforms the SAME reference photo with a new artistic treatment.
Write short prompts (1-2 sentences) starting with "Turn this into..." or "Restyle as...".
Every prompt must be a distinctly different visual treatment from prior ones.
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

  private handlePrompts(sessionId: string, prompts: string[]) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`[orchestrator] Received ${prompts.length} prompts from OpenAI, ref=${Boolean(session.referenceImageUrl)}`);

    if (prompts.length === 0) {
      this.emit(sessionId, { type: "error", message: "OpenAI returned no prompts. Please retry." });
      return;
    }

    const seenPrompts = new Set(
      session.feed.getState().images.map((img) => this.normalizePrompt(img.prompt))
    );

    for (let i = 0; i < prompts.length; i++) {
      const uniquePrompt = this.ensureUniquePrompt(prompts[i], seenPrompts, session.feed.imageCount() + i);
      const expandedPrompt = this.deLiteralizePrompt(uniquePrompt, session.guidanceText);
      console.log(`[orchestrator]   prompt: "${expandedPrompt.slice(0, 120)}..."`);

      const slot = session.feed.allocateSlot(expandedPrompt);
      this.emit(sessionId, { type: "image_status", index: slot.index, status: "generating" });

      this.fal.submit({
        sessionId,
        index: slot.index,
        prompt: expandedPrompt,
        priority: 1,
        referenceImageUrl: session.referenceImageUrl,
        seed: Math.floor(Math.random() * 1_000_000) + slot.index
      });
    }

    this.emit(sessionId, { type: "feed_state", feed: session.feed.getState() });
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

  private submitImmediateLoadMore(sessionId: string, theme: string) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.referenceImageUrl) return;

    const styleAxes = [
      "vintage film photography with grain, warm faded tones, and soft vignetting",
      "bold pop-art graphic style with halftone dots, saturated primaries, and thick outlines",
      "ethereal double-exposure blending nature elements with dreamlike translucency",
      "noir charcoal sketch with deep shadows, sharp highlights, and crosshatching",
      "glitch-art distortion with RGB channel splits, scan lines, and data-moshing",
      "miniature tilt-shift effect with selective focus and saturated toy-like colors",
      "watercolor wash with soft bleeding edges, translucent layers, and visible brush strokes",
      "infrared photography with magenta foliage, milky-white skies, and surreal contrast"
    ];
    const baseIdx = session.feed.imageCount();
    const prompts = [
      `Turn this into ${styleAxes[(baseIdx + 0) % styleAxes.length]}, guided by: ${theme}`,
      `Restyle as ${styleAxes[(baseIdx + 1) % styleAxes.length]}, inspired by: ${theme}`
    ];

    for (const prompt of prompts) {
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

  private deLiteralizePrompt(prompt: string, guidanceText?: string): string {
    if (!guidanceText) return prompt;
    const guidance = guidanceText.trim();
    if (!guidance) return prompt;

    const escaped = guidance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "ig");
    const replaced = prompt.replace(regex, "the core concept");
    return replaced.replace(/\s+/g, " ").trim();
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
