'use client';

// The named hooks plus the namespace: the file annotates handlers with `React.PointerEvent`, and this
// repo's eslint flags the ambient namespace as `no-undef`.
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { mmss } from './helpers';

// Inline call-recording player (play/pause + click/drag seek + time + download).
// The recording is loaded as a Blob object URL (fetched lazily on first play/seek)
// so it's fully seekable — the raw proxy stream reports Infinity duration until
// buffered and ignores currentTime seeks (jumping back to 0). The scrubber is a
// custom bar (not a native range input) so clicking anywhere jumps to that point.
export function AudioPlayer({
  src,
  durationHint,
}: {
  src: string;
  durationHint?: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  // Streamed audio reports Infinity/NaN duration until buffered — fall back to the
  // known call duration (hint) for the bar + total display.
  const total =
    Number.isFinite(dur) && dur > 0
      ? dur
      : durationHint && durationHint > 0
        ? durationHint
        : 0;
  const hasTotal = total > 0;
  const pct = hasTotal ? (Math.min(cur, total) / total) * 100 : 0;

  // Fetch the recording into a Blob object URL once and point the <audio> at it.
  const ensureBlob = useCallback(async (): Promise<string> => {
    if (blobUrlRef.current) return blobUrlRef.current;
    const res = await fetch(src);
    if (!res.ok) throw new Error(String(res.status));
    const url = URL.createObjectURL(await res.blob());
    blobUrlRef.current = url;
    setBlobUrl(url);
    return url;
  }, [src]);

  // Load the seekable blob into the audio element (once). Returns true on success.
  const loadBlob = useCallback(async (): Promise<boolean> => {
    if (blobUrlRef.current) return true;
    setLoading(true);
    try {
      const url = await ensureBlob();
      if (ref.current) {
        ref.current.src = url;
        ref.current.load();
      }
      return true;
    } catch {
      return false; // fall back to the stream src already on the element
    } finally {
      setLoading(false);
    }
  }, [ensureBlob]);

  // Seek to a fraction of the bar's width from a pointer X coordinate.
  const seekToClientX = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      const a = ref.current;
      if (!bar || !a || !hasTotal) return;
      const rect = bar.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const t = frac * total;
      setCur(t);
      if (blobUrlRef.current) {
        a.currentTime = t;
      } else {
        // Not loaded yet — remember where to land, then load; onLoadedMetadata applies it.
        pendingSeekRef.current = t;
        void loadBlob();
      }
    },
    [hasTotal, total, loadBlob]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasTotal) return;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekToClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) seekToClientX(e.clientX);
  };
  const endDrag = () => setDragging(false);

  const toggle = async () => {
    const a = ref.current;
    if (!a) return;
    if (!a.paused) {
      a.pause();
      return;
    }
    await loadBlob();
    void a.play();
  };

  const download = async () => {
    setDownloading(true);
    try {
      const url = await ensureBlob();
      const a = document.createElement('a');
      a.href = url;
      a.download = 'call-recording.mp3';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      window.open(src, '_blank', 'noopener');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-2.5 py-2">
      <button
        type="button"
        onClick={toggle}
        disabled={loading}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-slate-900 text-white transition-colors hover:bg-slate-800 disabled:opacity-70"
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : playing ? (
          <Pause className="size-3.5" />
        ) : (
          <Play className="size-3.5 translate-x-px" />
        )}
      </button>

      <div
        ref={barRef}
        role="slider"
        aria-label="Seek recording"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(Math.min(cur, total))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          'group relative flex h-4 flex-1 items-center',
          hasTotal ? 'cursor-pointer' : 'cursor-default'
        )}
      >
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full rounded-full bg-slate-900"
            style={{ width: `${pct}%` }}
          />
        </div>
        {hasTotal && (
          <div
            className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-slate-900 shadow-sm"
            style={{ left: `${pct}%` }}
          />
        )}
      </div>

      <span className="shrink-0 text-[10px] tabular-nums text-gray-500">
        {mmss(cur)} / {hasTotal ? mmss(total) : '--:--'}
      </span>
      <button
        type="button"
        onClick={download}
        disabled={downloading}
        aria-label="Download recording"
        title="Download recording"
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
      >
        {downloading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Download className="size-3.5" />
        )}
      </button>
      <audio
        ref={ref}
        src={blobUrl ?? src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget;
          if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration);
          if (pendingSeekRef.current != null) {
            a.currentTime = pendingSeekRef.current;
            pendingSeekRef.current = null;
          }
        }}
        onDurationChange={(e) => {
          const a = e.currentTarget;
          if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration);
        }}
        onTimeUpdate={(e) => {
          if (!dragging) setCur(e.currentTarget.currentTime);
        }}
        onEnded={() => {
          setPlaying(false);
          setCur(0);
        }}
      />
    </div>
  );
}
