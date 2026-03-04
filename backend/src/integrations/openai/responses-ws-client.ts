import WebSocket from "ws";

type ToolHandler = (args: unknown, callId: string) => Promise<void> | void;
type ErrorHandler = (error: Error) => void;
type StatusChangeHandler = (connected: boolean) => void;

type QueueItem = {
  payload: Record<string, unknown>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const OPENAI_WS_URL = "wss://api.openai.com/v1/responses";
const RECONNECT_DELAY_MS = 3000;

export class OpenAIResponsesWsClient {
  private ws: WebSocket | null = null;
  private readonly queue: QueueItem[] = [];
  private inFlight = false;
  private lastResponseId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lifetimeTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  private messageQueue: string[] = [];
  private processingMessages = false;
  private pendingToolOutputs: Array<{ type: string; call_id: string; output: string }> = [];

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly tools: unknown[],
    private readonly handlers: Record<string, ToolHandler>,
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
    this.pendingToolOutputs.length = 0;
  }

  async enqueueUserMessage(text: string, instructions: string): Promise<void> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const payload: Record<string, unknown> = {
      type: "response.create",
      model: this.model,
      instructions,
      tools: this.tools,
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

  enqueueFunctionOutput(callId: string, output: Record<string, unknown>): void {
    this.pendingToolOutputs.push({
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output)
    });
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

    if (this.lastResponseId) {
      next.payload.previous_response_id = this.lastResponseId;
    }

    const jsonPayload = JSON.stringify(next.payload);
    console.log("[openai-ws] Sending:", next.payload.type, "prevId:", this.lastResponseId?.slice(-12) ?? "none");

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
      const response = event.response as Record<string, unknown> | undefined;
      this.lastResponseId = (response?.id as string) ?? this.lastResponseId;
      console.log("[openai-ws] Response completed, id:", this.lastResponseId);
      this.sendPendingToolOutputs();
      return;
    }

    if (eventType === "response.failed") {
      const response = event.response as Record<string, unknown> | undefined;
      const errDetail = response?.error ?? response?.status_details;
      console.error("[openai-ws] Response failed:", JSON.stringify(errDetail));
      this.onError?.(new Error(`Response failed: ${JSON.stringify(errDetail)}`));
      this.pendingToolOutputs.length = 0;
      this.inFlight = false;
      this.flushQueue();
      return;
    }

    if (eventType !== "response.output_item.done") return;

    const item = event.item as Record<string, unknown> | undefined;
    if (!item || item.type !== "function_call") return;
    const toolName = item.name as string;
    const handler = this.handlers[toolName];
    if (!handler) {
      console.warn("[openai-ws] No handler for tool:", toolName);
      return;
    }

    let args: unknown = {};
    try {
      args = JSON.parse((item.arguments as string) ?? "{}");
    } catch {
      args = {};
    }

    console.log("[openai-ws] Tool call:", toolName, "callId:", item.call_id);
    await handler(args, item.call_id as string);
  }

  private sendPendingToolOutputs() {
    if (this.pendingToolOutputs.length === 0) {
      this.inFlight = false;
      this.flushQueue();
      return;
    }

    const outputs = this.pendingToolOutputs.splice(0);
    console.log(`[openai-ws] Sending ${outputs.length} tool output(s) together`);

    const payload: Record<string, unknown> = {
      type: "response.create",
      model: this.model,
      tools: this.tools,
      input: outputs
    };

    // Tool outputs MUST be sent before any queued user messages.
    // Use unshift so they jump ahead of load_more / user_prompt payloads
    // that may have been enqueued while we were waiting for OpenAI.
    const item: QueueItem = {
      payload,
      resolve: () => {},
      reject: () => {}
    };
    this.queue.unshift(item);
    this.inFlight = false;
    this.flushQueue();
  }

  private scheduleLifetimeRotation(delayMs: number) {
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    this.lifetimeTimer = setTimeout(() => {
      console.log("[openai-ws] Rotating connection (lifetime limit)");
      this.ws?.close();
    }, delayMs);
  }
}
