import { useEffect, useRef, useCallback } from "react";
import type { ImageViewModel } from "../tiles/tile-store";

type Props = {
  images: ImageViewModel[];
  loading: boolean;
  onLoadMore: () => void;
};

export const ScrollFeed = ({ images, loading, onLoadMore }: Props) => {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const ratioClass = useCallback((index: number) => {
    const mode = index % 4;
    if (mode === 0) return "aspect-wide";
    if (mode === 1) return "aspect-square";
    if (mode === 2) return "aspect-tall";
    return "aspect-cinema";
  }, []);

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const entry = entries[0];
      if (entry?.isIntersecting && images.length > 0 && !loading) {
        onLoadMore();
      }
    },
    [images.length, loading, onLoadMore]
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(handleIntersect, {
      root: containerRef.current,
      rootMargin: "400px",
      threshold: 0
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleIntersect]);

  const sorted = [...images].sort((a, b) => a.index - b.index);

  return (
    <div className="feed-container" ref={containerRef}>
      <div className="feed-list">
        {sorted.map((img) => (
          <div key={img.index} className={`feed-row ${img.status}`}>
            <div className={`feed-image-wrap ${ratioClass(img.index)}`}>
              {img.image ? (
                <img
                  src={img.image}
                  alt={img.prompt || `Image #${img.index}`}
                  className="feed-image"
                  loading="lazy"
                />
              ) : (
                <div className="feed-placeholder">
                  <div className="feed-placeholder-inner">
                    <div className="feed-splash">
                      <span className="feed-orb orb-a" />
                      <span className="feed-orb orb-b" />
                      <span className="feed-orb orb-c" />
                    </div>
                    <div className="feed-spinner" />
                    <p className="feed-loading-text">Cooking pixels...</p>
                  </div>
                </div>
              )}
            </div>
            <div className="feed-info">
              <span className="feed-index">#{img.index + 1}</span>
              {img.prompt ? (
                <p className="feed-prompt">{img.prompt}</p>
              ) : (
                <p className="feed-prompt muted">Generating prompt...</p>
              )}
              <span className={`feed-status ${img.status}`}>
                {img.status === "ready" ? "Ready" : img.status === "generating" ? "Generating..." : img.status === "failed" ? "Failed" : "Pending"}
              </span>
            </div>
          </div>
        ))}

        {loading && (
          <div className="feed-row loading-row">
            <div className="feed-image-wrap aspect-wide">
              <div className="feed-placeholder">
                <div className="feed-placeholder-inner">
                  <div className="feed-splash">
                    <span className="feed-orb orb-a" />
                    <span className="feed-orb orb-b" />
                    <span className="feed-orb orb-c" />
                  </div>
                  <div className="feed-spinner" />
                  <p className="feed-loading-text">Cooking pixels...</p>
                </div>
              </div>
            </div>
            <div className="feed-info">
              <p className="feed-prompt muted">Loading more images...</p>
            </div>
          </div>
        )}
      </div>

      <div ref={sentinelRef} className="feed-sentinel" />
    </div>
  );
};
