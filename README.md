# Infinite Scroll

An endless AI image feed powered by **OpenAI Responses WebSocket** (prompt generation) and **fal.ai Flux 2 Klein Realtime WebSocket** (image generation). Describe a theme and scroll through a never-ending stream of AI-generated images.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER (React + Vite)                                             │
│                                                                     │
│  ┌─────────────┐  WebSocket   ┌──────────────────────────────────┐  │
│  │  ScrollFeed  │◄──(/feed)──►│  Backend (Express + ws)          │  │
│  │  ChatInput   │             │                                  │  │
│  │              │             │  ┌──────────────────────────┐    │  │
│  │  Status bar: │             │  │  SessionOrchestrator     │    │  │
│  │  OpenAI Live │             │  │                          │    │  │
│  │  fal Live    │             │  │  ┌────────────────────┐  │    │  │
│  └─────────────┘             │  │  │  OpenAI Responses   │──┼────┼──► wss://api.openai.com
│                               │  │  │  WebSocket Client   │◄─┼────┼──  (persistent WS)
│                               │  │  │  [GPT-4.1]          │  │    │  │
│                               │  │  └────────────────────┘  │    │  │
│                               │  │                          │    │  │
│                               │  │  ┌────────────────────┐  │    │  │
│                               │  │  │  fal.ai Realtime    │──┼────┼──► wss://fal.run
│                               │  │  │  (Priority Queue)   │◄─┼────┼──  (Flux 2 Klein)
│                               │  │  │  [3 concurrent]     │  │    │  │
│                               │  │  └────────────────────┘  │    │  │
│                               │  └──────────────────────────┘    │  │
│                               └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Connections

There are **three connections** managed by the system:

#### 1. Browser ↔ Backend WebSocket (`/feed`)

The frontend opens a persistent WebSocket to the backend at `/feed`. This carries all real-time communication:

| Direction | Event | Purpose |
|-----------|-------|---------|
| Client → Server | `session_init` | Registers the session, restores state if reconnecting |
| Client → Server | `user_prompt` | User describes a theme (e.g. "cyberpunk cities") |
| Client → Server | `load_more` | Triggered by infinite scroll when nearing the bottom |
| Server → Client | `feed_state` | Full feed snapshot (on connect / reconnect) |
| Server → Client | `image_update` | An image finished generating — includes URL |
| Server → Client | `image_status` | Status change (pending → generating → ready/failed) |
| Server → Client | `error` | Error messages |

#### 2. Backend ↔ OpenAI Responses WebSocket (`wss://api.openai.com/v1/responses`)

The backend maintains a persistent WebSocket to OpenAI's Responses API. This is used instead of REST for lower latency and connection reuse:

- **Sends** `response.create` with user messages and tool definitions
- **Receives** `response.output_item.done` with function calls (the `generate_images` tool)
- **Sends back** `function_call_output` with the result
- Maintains conversation context via `previous_response_id` chaining
- Auto-reconnects and rotates connections before the 60-minute limit

#### 3. Backend ↔ fal.ai Realtime WebSocket (`fal-ai/flux-2/klein/realtime`)

fal.ai uses **Realtime WebSockets** (via `fal.realtime.connect()`). The backend wraps it in a priority queue with concurrency control to manage throughput:

- **Priority 1**: First batch of images (user just typed a prompt)
- **Priority 2**: Load-more batches (infinite scroll)
- **Priority 3**: Background/low-priority
- **Concurrency**: 3 parallel image generations
- **Retries**: Up to 3 attempts with exponential backoff
- **Model**: Flux 2 Klein Realtime

The frontend shows **"OpenAI Live"** and **"fal Live"** badges in the top bar. The backend sends `connection_status` events so the UI reflects the real-time state of both services.

### Data Flow

```
1. User types "underwater kingdoms"
       │
       ▼
2. Frontend sends { type: "user_prompt", text: "underwater kingdoms" }
       │  (Browser → Backend WebSocket)
       ▼
3. Backend sends to OpenAI via Responses WebSocket:
   { type: "response.create", input: [{ role: "user", content: "..." }] }
       │
       ▼
4. OpenAI calls generate_images tool with 6 creative prompts like:
   "A bioluminescent coral throne room deep beneath the Pacific,
    shafts of blue light filtering through the water..."
       │
       ▼
5. Backend allocates image slots, sends status updates to frontend,
   and queues 6 fal.ai jobs (3 run concurrently)
       │
       ▼
6. fal.ai generates each image via Flux 2 Klein Realtime WebSocket
       │
       ▼
7. As each image completes, backend sends:
   { type: "image_update", index: 0, image: "https://...", status: "ready" }
       │  (Backend → Browser WebSocket)
       ▼
8. Frontend renders image in the feed immediately
       │
       ▼
9. User scrolls near bottom → frontend sends { type: "load_more", count: 6 }
       │
       ▼
10. Steps 3-8 repeat with "generate 6 MORE images..." → endless scroll
```

## Project Structure

```
├── packages/shared/        Shared TypeScript types (Zod schemas)
├── backend/
│   ├── src/
│   │   ├── server/          Express + WebSocket server
│   │   ├── ws/client/       Browser WebSocket handler
│   │   ├── orchestrator/    Session orchestrator (ties everything together)
│   │   ├── integrations/
│   │   │   ├── openai/      OpenAI Responses WebSocket client
│   │   │   └── fal/         fal.ai image generation with priority queue
│   │   ├── domain/feed/     Feed state store
│   │   └── config/          Environment config
│   └── tests/
└── frontend/
    ├── src/
    │   ├── app/             App component + WebSocket connection
    │   └── features/
    │       ├── feed/        ScrollFeed (infinite scroll + IntersectionObserver)
    │       ├── chat/        ChatInput
    │       └── tiles/       ImageViewModel type
    └── tests/
```

## Tech Stack

| Layer    | Tech |
|----------|------|
| Frontend | React 18, Vite 5, TypeScript |
| Backend  | Express, ws (WebSocket), TypeScript |
| AI       | OpenAI Responses WebSocket (GPT-4.1), fal.ai Flux 2 Klein Realtime |
| Shared   | Zod schemas, TypeScript |

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env with your API keys:
#   OPENAI_API_KEY=sk-...
#   FAL_KEY=...

# Run both servers
npm run dev
```

Frontend: http://localhost:5173  
Backend: http://localhost:8787
