import { config } from "dotenv";
import { z } from "zod";

config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8787),
  OPENAI_API_KEY: z.string().optional(),
  FAL_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini")
});

export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);
