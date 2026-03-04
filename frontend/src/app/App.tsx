import { useEffect, useRef, useState, useCallback } from "react";
import { ChatInput } from "../features/chat/ChatInput";
import { ScrollFeed } from "../features/feed/ScrollFeed";
import type { ImageViewModel } from "../features/tiles/tile-store";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/feed`;

function getSessionId(): string {
  let id = localStorage.getItem("is.sid");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("is.sid", id);
  }
  return id;
}

type ServiceStatus = {
  openai: "connected" | "disconnected" | "unconfigured";
  fal: "ready" | "unavailable";
};

const THEME_PILLS = [
  { label: "Cyberpunk Cities", icon: "\u{1F306}" },
  { label: "Underwater Worlds", icon: "\u{1F419}" },
  { label: "Dark Fantasy", icon: "\u{1F409}" },
  { label: "Retro Futurism", icon: "\u{1F680}" },
  { label: "Studio Ghibli", icon: "\u{1F343}" },
  { label: "Solarpunk Utopia", icon: "\u{1F33F}" },
  { label: "Cosmic Horror", icon: "\u{1F30C}" },
  { label: "Cozy Interiors", icon: "\u{1F56F}" },
  { label: "Ancient Ruins", icon: "\u{1F3DB}" },
  { label: "Neon Noir", icon: "\u{1F506}" },
];

const MOSAIC_IDS = [
  10, 11, 14, 15, 17, 18, 19, 20, 21, 22, 24, 25, 27, 28, 29,
  35, 36, 37, 39, 40, 42, 43, 47, 48, 49, 50, 54, 55, 57, 58,
];

const PEEK_CARDS = [
  {
    imageUrl: "https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=900&q=80",
    prompt: "Glacial mountain sunrise with surreal pastel haze"
  },
  {
    imageUrl: "https://images.unsplash.com/photo-1518709766631-a6a7f45921c3?auto=format&fit=crop&w=900&q=80",
    prompt: "Neon city canyon glowing through midnight rain"
  },
  {
    imageUrl: "https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=900&q=80",
    prompt: "Bioluminescent reef architecture beneath deep ocean"
  },
  {
    imageUrl: "https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=900&q=80",
    prompt: "Golden desert monument under cinematic storm light"
  },
];

const TICKER_BASE = 2274;
const HERO_WORDS = ["Endless", "Infinite"];

export const App = () => {
  const [images, setImages] = useState<ImageViewModel[]>([]);
  const [theme, setTheme] = useState("");
  const [wsStatus, setWsStatus] = useState<"connected" | "connecting" | "disconnected">("disconnected");
  const [services, setServices] = useState<ServiceStatus>({ openai: "disconnected", fal: "unavailable" });
  const [lastError, setLastError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tickerCount, setTickerCount] = useState(TICKER_BASE);
  const [heroWordIdx, setHeroWordIdx] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionId = useRef(getSessionId());
  const loadCooldown = useRef(false);
  const loadWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setTickerCount((c) => Math.max(1800, c + Math.floor(Math.random() * 9) - 2));
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setHeroWordIdx((i) => (i + 1) % HERO_WORDS.length);
    }, 2100);
    return () => clearInterval(interval);
  }, []);

  function safeSend(data: object) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (disposed) return;
      setWsStatus("connecting");
      const ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        wsRef.current = ws;
        setWsStatus("connected");
        ws.send(JSON.stringify({ type: "session_init", sessionId: sessionId.current }));
      };

      ws.onmessage = (ev) => {
        if (disposed) return;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === "connection_status") {
          setServices({
            openai: msg.openai as ServiceStatus["openai"],
            fal: msg.fal as ServiceStatus["fal"]
          });
        } else if (msg.type === "feed_state") {
          const feed = msg.feed as { theme: string; images: Array<{ index: number; prompt: string; status: string; imageUrl: string | null }> };
          setTheme(feed.theme || "");
          setImages((prev) => {
            const prevMap = new Map(prev.map((i) => [i.index, i]));
            return feed.images.map((img) => {
              const existing = prevMap.get(img.index);
              return {
                index: img.index,
                prompt: img.prompt || existing?.prompt || "",
                status: (img.imageUrl ? "ready" : img.status) as ImageViewModel["status"],
                image: img.imageUrl || existing?.image || null
              };
            });
          });
          if (loadWatchdog.current) {
            clearTimeout(loadWatchdog.current);
            loadWatchdog.current = null;
          }
          setLoading(false);
        } else if (msg.type === "image_update") {
          const prompt = msg.prompt as string;
          setImages((prev) => {
            const idx = msg.index as number;
            const existing = prev.find((i) => i.index === idx);
            if (existing) {
              return prev.map((i) =>
                i.index === idx
                  ? { ...i, prompt: prompt || i.prompt, image: msg.image as string, status: msg.status as ImageViewModel["status"] }
                  : i
              );
            }
            return [...prev, {
              index: idx,
              prompt,
              status: msg.status as ImageViewModel["status"],
              image: msg.image as string
            }];
          });
          if (loadWatchdog.current) {
            clearTimeout(loadWatchdog.current);
            loadWatchdog.current = null;
          }
          setLoading(false);
        } else if (msg.type === "image_status") {
          setImages((prev) => {
            const idx = msg.index as number;
            const existing = prev.find((i) => i.index === idx);
            if (existing) {
              return prev.map((i) =>
                i.index === idx
                  ? { ...i, status: msg.status as ImageViewModel["status"] }
                  : i
              );
            }
            return [...prev, {
              index: idx,
              prompt: "",
              status: msg.status as ImageViewModel["status"],
              image: null
            }];
          });
          if (loadWatchdog.current) {
            clearTimeout(loadWatchdog.current);
            loadWatchdog.current = null;
          }
          // We received generation progress; unlock loading gate so scroll can request again later.
          setLoading(false);
        } else if (msg.type === "error") {
          if (loadWatchdog.current) {
            clearTimeout(loadWatchdog.current);
            loadWatchdog.current = null;
          }
          setLastError(msg.message as string);
          setLoading(false);
          setTimeout(() => setLastError(null), 6000);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) {
          setWsStatus("disconnected");
          setServices({ openai: "disconnected", fal: "unavailable" });
          reconnectTimer = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {};
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (loadWatchdog.current) {
        clearTimeout(loadWatchdog.current);
        loadWatchdog.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const handlePrompt = useCallback((text: string) => {
    setImages([]);
    setTheme(text);
    setLoading(true);
    safeSend({ type: "user_prompt", text });
  }, []);

  const handleLoadMore = useCallback(() => {
    if (loading || loadCooldown.current) return;
    loadCooldown.current = true;
    setLoading(true);
    safeSend({ type: "load_more", count: 6 });
    setTimeout(() => { loadCooldown.current = false; }, 1200);
    if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
    loadWatchdog.current = setTimeout(() => {
      // Prevent permanent "loading" lock when backend/model stalls.
      setLoading(false);
      loadCooldown.current = false;
    }, 9000);
  }, [loading]);

  const hasImages = images.length > 0;
  const hasTheme = theme.length > 0;
  const inFeedView = hasImages || loading;

  const handleGoHome = useCallback(() => {
    setImages([]);
    setTheme("");
    setLoading(false);
  }, []);

  return (
    <div className="app">
      <header className="top-bar">
        <div className="top-bar-left">
          {inFeedView && (
            <button type="button" className="home-btn" onClick={handleGoHome} aria-label="Back to home">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <span>Home</span>
            </button>
          )}
          <h1 className="logo">
            <svg className="logo-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
              <defs>
                <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#c084fc" />
                  <stop offset="50%" stopColor="#6366f1" />
                  <stop offset="100%" stopColor="#38bdf8" />
                </linearGradient>
              </defs>
              <path d="M4 17v-4a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4" stroke="url(#logoGrad)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M4 13h16" stroke="url(#logoGrad)" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
              <path d="M8 9V5l4 4 4-4v4" stroke="url(#logoGrad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.9" />
            </svg>
            Infinite Scroll
          </h1>
        </div>
        <div className="top-actions">
          <div className="status-badges">
            <span className={`status-indicator ${wsStatus === "connected" && services.openai === "connected" ? "live" : services.openai === "unconfigured" ? "warn" : "down"}`}>
              <span className="status-dot" />
              <span>OpenAI</span>
            </span>
            <span className={`status-indicator ${wsStatus === "connected" && services.fal === "ready" ? "live" : services.fal === "unavailable" ? "warn" : "down"}`}>
              <span className="status-dot" />
              <span>fal</span>
            </span>
          </div>
          <button type="button" className="top-cta-btn">Create free feed</button>
        </div>
      </header>

      {!hasImages && !loading && (
        <div className="hero">
          {/* Parallax vertical mosaic background */}
          <div className="hero-mosaic" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((col) => (
              <div key={col} className={`mosaic-col mc-${col}`}>
                {MOSAIC_IDS.slice(col * 6, col * 6 + 6).map((pid) => (
                  <img
                    key={pid}
                    src={`https://picsum.photos/id/${pid}/300/400`}
                    className="mosaic-img"
                    alt=""
                    loading="lazy"
                  />
                ))}
                {MOSAIC_IDS.slice(col * 6, col * 6 + 6).map((pid) => (
                  <img
                    key={`d-${pid}`}
                    src={`https://picsum.photos/id/${pid}/300/400`}
                    className="mosaic-img"
                    alt=""
                    loading="lazy"
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="hero-overlay" />

          {/* Content */}
          <div className="hero-content">
            <h2 className="hero-title">
              <span key={heroWordIdx} className="hero-kinetic-word">
                {HERO_WORDS[heroWordIdx]}
              </span>{" "}
              AI Images
            </h2>

            {/* 3. Unified search & pills */}
            <div className="search-widget">
              <div className="search-input-wrapper">
                <ChatInput onSubmit={handlePrompt} placeholder="Search or describe your own theme..." />
              </div>
              <div className="search-suggestions">
                <span className="suggestions-label">Try:</span>
                <div className="pill-carousel">
                  {THEME_PILLS.map((pill) => (
                    <button
                      key={pill.label}
                      className="theme-pill"
                      onClick={() => handlePrompt(pill.label)}
                    >
                      <span className="pill-icon">{pill.icon}</span>
                      <span className="pill-label">{pill.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 6. Reworked social proof */}
            <div className="ticker">
              <span className="ticker-dot" />
              {tickerCount.toLocaleString()} creators generating live feeds right now
            </div>
          </div>

          {/* 4. Compelling peek grid */}
          <div className="hero-peek" aria-hidden="true">
            <div className="peek-grid">
              {PEEK_CARDS.map((card, i) => (
                <div key={card.imageUrl} className={`peek-card stagger-${i % 3}`}>
                  <img
                    src={card.imageUrl}
                    alt=""
                    className="peek-img"
                    loading="lazy"
                  />
                  <div className="peek-caption">{card.prompt}</div>
                </div>
              ))}
            </div>
            <div className="peek-scroll-hint">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span>scroll to explore</span>
            </div>
            <p className="hero-tech-note">
              Powered by OpenAI + fal.ai
            </p>
          </div>
        </div>
      )}

      {(hasImages || loading) && (
        <>
          {hasTheme && <p className="theme-label">{theme}</p>}
          <ScrollFeed images={images} loading={loading} onLoadMore={handleLoadMore} />
          <div className="bottom-chat">
            <ChatInput onSubmit={handlePrompt} placeholder="New theme..." />
          </div>
        </>
      )}

      {lastError && (
        <div className="error-toast" onClick={() => setLastError(null)}>
          {lastError}
        </div>
      )}
    </div>
  );
};
