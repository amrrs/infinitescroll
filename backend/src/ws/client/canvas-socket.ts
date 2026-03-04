import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientEventSchema } from "@infinitecanvas/shared";
import { SessionOrchestrator } from "../../orchestrator/session-orchestrator.js";

type SocketWithMeta = WebSocket & { sessionId?: string; isAlive?: boolean; initialized?: boolean };

export const attachFeedSocketServer = (server: import("node:http").Server) => {
  const wss = new WebSocketServer({ server, path: "/feed" });
  const orchestrator = new SessionOrchestrator();

  wss.on("connection", (socket: SocketWithMeta, _req: IncomingMessage) => {
    console.log("[ws-server] New connection");
    socket.isAlive = true;
    socket.initialized = false;
    socket.sessionId = randomUUID();

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", async (rawData) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawData.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Malformed JSON" }));
        return;
      }

      const parsed = ClientEventSchema.safeParse(parsedJson);
      if (!parsed.success) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid client event payload" }));
        return;
      }

      if (parsed.data.type === "session_init") {
        const requestedId = parsed.data.sessionId;
        if (socket.initialized && socket.sessionId !== requestedId) {
          orchestrator.unregisterSession(socket.sessionId!);
        }
        socket.sessionId = requestedId;
        orchestrator.registerSession(socket.sessionId, socket);
        socket.initialized = true;
        console.log("[ws-server] Session initialized:", socket.sessionId);
        return;
      }

      if (!socket.initialized) {
        socket.send(JSON.stringify({ type: "error", message: "Send session_init first" }));
        return;
      }

      try {
        await orchestrator.onClientEvent(socket.sessionId!, parsed.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Internal server error";
        socket.send(JSON.stringify({ type: "error", message }));
      }
    });

    socket.on("close", () => {
      console.log("[ws-server] Connection closed:", socket.sessionId);
      if (socket.initialized) {
        orchestrator.unregisterSession(socket.sessionId!);
      }
    });

    socket.on("error", () => {
      // swallow to prevent unhandled crash
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const candidate = socket as SocketWithMeta;
      if (!candidate.isAlive) {
        candidate.terminate();
        continue;
      }
      candidate.isAlive = false;
      candidate.ping();
    }
  }, 15_000);

  wss.on("close", () => clearInterval(heartbeat));
};
