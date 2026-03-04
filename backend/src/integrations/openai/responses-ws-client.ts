import WebSocket from "ws";

type PromptsHandler = (prompts: string[]) => void;
type ErrorHandler = (error: Error) => void;
type StatusChangeHandler = (connected: boolean) => void;

type QueueItem = {
  payload: Record<string, unknown>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const OPENAI_WS_URL = "wss://api.openai.com/v1/responses";
const RECONNECT_DELAY_MS = 3000;

const PROMPTS_SCHEMA = {
  type: "json_schema" as const,
  name: "image_prompts",
  strict: true,
  schema: {
    type: "object",
    properties: {
      prompts: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["prompts"],
    additionalProperties: false
  }
};

export class OpenAIResponsesWsClient {
  private ws: WebSocket | null = null;
  private readonly queue: QueueItem[] = [];
  private inFlight = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lifetimeTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  private messageQueue: string[] = [];
  private processingMessages = false;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly onPrompts: PromptsHandler,
    private readonly onError?: ErrorHandler,
    private readonly onStatusChange?: StatusChangeHandler
  ) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  connect() {
    if (!this.apiKey) {
      console.log("[openai-ws] No API key configured, skipping connection");
      return;
    }
    if (this.ws || this.destroyed) return;

    console.log("[openai-ws] Connecting...");
    this.ws = new WebSocket(OPENAI_WS_URL, {
      headers: { Authorization: `Bearer ${this.apiKey}` }
    });

    this.ws.on("open", () => {
      console.log("[openai-ws] Connected");
      this.scheduleLifetimeRotation(55 * 60 * 1000);
      this.onStatusChange?.(true);
      this.flushQueue();
    });

    this.ws.on("message", (raw) => {
      this.messageQueue.push(raw.toString());
      this.drainMessages();
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[openai-ws] Closed code=${code} reason=${reason?.toString() ?? ""}`);
      this.ws = null;
      this.inFlight = false;
      this.onStatusChange?.(false);
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });

    this.ws.on("error", (error) => {
      console.error("[openai-ws] Error:", error.message);
      this.onError?.(error);
    });
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    this.ws?.close();
    this.ws = null;
    for (const item of this.queue) {
      item.reject(new Error("Client destroyed"));
    }
    this.queue.length = 0;
  }

  async enqueueUserMessage(text: string, instructions: string): Promise<void> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const payload: Record<string, unknown> = {
      type: "response.create",
      model: this.model,
      instructions,
      text: { format: PROMPTS_SCHEMA },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }]
        }
      ]
    };
    return this.enqueue(payload);
  }

  private enqueue(payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this.flushQueue();
    });
  }

  private flushQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = true;

    const jsonPayload = JSON.stringify(next.payload);
    console.log("[openai-ws] Sending:", next.payload.type);

    this.ws.send(jsonPayload, (err) => {
      if (err) {
        console.error("[openai-ws] Send error:", err.message);
        next.reject(err);
        this.inFlight = false;
        return;
      }
      next.resolve();
    });
  }

  private async drainMessages() {
    if (this.processingMessages) return;
    this.processingMessages = true;
    try {
      while (this.messageQueue.length > 0) {
        const msg = this.messageQueue.shift()!;
        await this.handleMessage(msg);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError?.(err);
    } finally {
      this.processingMessages = false;
    }
  }

  private async handleMessage(rawMessage: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const eventType = event.type as string;

    if (eventType === "error") {
      const errMsg = (event.error as Record<string, unknown>)?.message ?? "OpenAI websocket error";
      console.error("[openai-ws] API error:", errMsg);
      this.onError?.(new Error(String(errMsg)));
      this.inFlight = false;
      this.flushQueue();
      return;
    }

    if (eventType === "response.completed") {
      console.log("[openai-ws] Response completed");
      this.inFlight = false;
      this.flushQueue();
      return;
    }

    if (eventType === "response.failed") {
      const response = event.response as Record<string, unknown> | undefined;
      const errDetail = response?.error ?? response?.status_details;
      console.error("[openai-ws] Response failed:", JSON.stringify(errDetail));
      this.onError?.(new Error(`Response failed: ${JSON.stringify(errDetail)}`));
      this.inFlight = false;
      this.flushQueue();
      return;
    }

    if (eventType !== "response.output_item.done") return;

    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return;

    const content = item.content as Array<Record<string, unknown>> | undefined;
    if (!content || content.length === 0) return;

    const textPart = content.find((c) => c.type === "output_text");
    if (!textPart || typeof textPart.text !== "string") return;

    try {
      const parsed = JSON.parse(textPart.text);
      if (Array.isArray(parsed.prompts) && parsed.prompts.length > 0) {
        console.log(`[openai-ws] Parsed ${parsed.prompts.length} prompts from structured output`);
        this.onPrompts(parsed.prompts.filter((p: unknown) => typeof p === "string" && p.trim().length > 0));
      } else {
        console.warn("[openai-ws] Structured output had no prompts:", textPart.text.slice(0, 200));
      }
    } catch {
      console.error("[openai-ws] Failed to parse structured output:", textPart.text.slice(0, 200));
    }
  }

  private scheduleLifetimeRotation(delayMs: number) {
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    this.lifetimeTimer = setTimeout(() => {
      console.log("[openai-ws] Rotating connection (lifetime limit)");
      this.ws?.close();
    }, delayMs);
  }
}
