import http from "node:http";
import express from "express";
import { attachFeedSocketServer } from "../ws/client/canvas-socket.js";
import { env } from "../config/env.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
attachFeedSocketServer(server);

server.listen(env.PORT, () => {
  console.log(`backend listening on ${env.PORT}`);
});
