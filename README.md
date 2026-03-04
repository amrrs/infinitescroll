# Infinite Scroll

![Infinite Scroll Screenshot](infinitescroll-screenshot.jpeg)

An endless AI image feed. Upload a reference image, describe a direction, and scroll through AI-generated variations — powered by **OpenAI WebSocket** + **fal.ai Flux 2 Klein Realtime WebSocket**.

## How It Works

1. Upload a **reference image** + type a creative direction
2. **OpenAI** (via WebSocket) expands your direction into transformation prompts
3. **Flux 2 Klein** (via fal.ai Realtime WebSocket) applies each prompt to your reference image
4. Scroll down — more variations generate as you go

## Architecture

```
Browser (React)  ←WebSocket→  Backend (Express)  ←WebSocket→  OpenAI (prompt expansion)
                                                  ←WebSocket→  fal.ai Flux 2 Klein (img2img)
```

- **3 WebSocket connections**: Browser↔Backend, Backend↔OpenAI, Backend↔fal.ai
- **3 concurrent** image generations via priority queue
- **Immediate first images** fire before OpenAI responds for fast perceived speed

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React, Vite, TypeScript |
| Backend | Express, ws, TypeScript |
| AI (prompts) | OpenAI Responses WebSocket (gpt-4.1-nano) |
| AI (images) | fal.ai Flux 2 Klein Realtime WebSocket |
| Shared | Zod schemas |

## Setup

```bash
npm install
cp backend/.env.example backend/.env
# Add your keys: OPENAI_API_KEY, FAL_KEY
npm run dev
```

Frontend: http://localhost:5173 — Backend: http://localhost:8787

## Customizing the System Prompt

Edit `backend/src/config/system-prompt.txt` to change how OpenAI generates transformation prompts. Restart the backend after editing.
