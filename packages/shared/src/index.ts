import { z } from "zod";

export const ImageStatusSchema = z.enum(["pending", "generating", "ready", "failed"]);
export type ImageStatus = z.infer<typeof ImageStatusSchema>;

export const FeedImageSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  prompt: z.string(),
  imageUrl: z.string().nullable(),
  status: ImageStatusSchema,
  lastUpdated: z.number()
});
export type FeedImage = z.infer<typeof FeedImageSchema>;

export const FeedStateSchema = z.object({
  id: z.string(),
  theme: z.string(),
  images: z.array(FeedImageSchema),
  nextIndex: z.number().int().nonnegative()
});
export type FeedState = z.infer<typeof FeedStateSchema>;

// ── Client Events ──

export const SessionInitEventSchema = z.object({
  type: z.literal("session_init"),
  sessionId: z.string()
});
export type SessionInitEvent = z.infer<typeof SessionInitEventSchema>;

export const UserPromptEventSchema = z.object({
  type: z.literal("user_prompt"),
  text: z.string().min(1),
  referenceImage: z.string().optional()
});
export type UserPromptEvent = z.infer<typeof UserPromptEventSchema>;

export const LoadMoreEventSchema = z.object({
  type: z.literal("load_more"),
  count: z.number().int().min(1).max(12).default(6)
});
export type LoadMoreEvent = z.infer<typeof LoadMoreEventSchema>;

export const ResetFeedEventSchema = z.object({
  type: z.literal("reset_feed")
});
export type ResetFeedEvent = z.infer<typeof ResetFeedEventSchema>;

export const ClientEventSchema = z.discriminatedUnion("type", [
  SessionInitEventSchema,
  UserPromptEventSchema,
  LoadMoreEventSchema,
  ResetFeedEventSchema
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

// ── Server Events ──

export const ImageUpdateEventSchema = z.object({
  type: z.literal("image_update"),
  index: z.number().int().nonnegative(),
  prompt: z.string(),
  image: z.string(),
  status: ImageStatusSchema
});
export type ImageUpdateEvent = z.infer<typeof ImageUpdateEventSchema>;

export const ImageStatusEventSchema = z.object({
  type: z.literal("image_status"),
  index: z.number().int().nonnegative(),
  status: ImageStatusSchema
});
export type ImageStatusEvent = z.infer<typeof ImageStatusEventSchema>;

export const FeedStateEventSchema = z.object({
  type: z.literal("feed_state"),
  feed: FeedStateSchema
});
export type FeedStateEvent = z.infer<typeof FeedStateEventSchema>;

export const ConnectionStatusEventSchema = z.object({
  type: z.literal("connection_status"),
  openai: z.enum(["connected", "disconnected", "unconfigured"]),
  fal: z.enum(["ready", "unavailable"])
});
export type ConnectionStatusEvent = z.infer<typeof ConnectionStatusEventSchema>;

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string()
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  ImageUpdateEventSchema,
  ImageStatusEventSchema,
  FeedStateEventSchema,
  ConnectionStatusEventSchema,
  ErrorEventSchema
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ── Tool Schemas ──

export const GenerateImageItemSchema = z.object({
  prompt: z.string(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)])
});
export type GenerateImageItem = z.infer<typeof GenerateImageItemSchema>;

export const GenerateImagesToolSchema = z.object({
  version: z.literal("1").default("1"),
  images: z.array(GenerateImageItemSchema).min(1).max(12),
  themeContext: z.string().optional()
});
export type GenerateImagesToolPayload = z.infer<typeof GenerateImagesToolSchema>;
