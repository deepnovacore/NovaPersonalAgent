'use client';
import { useEffect, useRef } from 'react';
import type { Clip, Line } from '../lib/scenes';
import { sitePath } from '../lib/site-path';
import { DeviceFrame } from './device-frame';

export function Exchange({ lines, en }: { lines: Line[]; en: boolean }) {
  return (
    <ol className="exchange">
      {lines.map((line, i) => (
        <li key={i} className={`turn turn-${line.who}`}>
          {line.who === 'nova' ? (
            <span className="who">Nova</span>
          ) : (
            <span className="sr-only">{en ? 'You:' : '你：'}</span>
          )}
          <q className="said">{en ? line.en : line.zh}</q>
        </li>
      ))}
    </ol>
  );
}

// Plays muted while on screen, pauses off screen; static under reduced motion.
export function ClipPlayer({ clip, label }: { clip: Clip; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.35 },
    );
    io.observe(video);
    return () => io.disconnect();
  }, []);
  return (
    <div className={`clip clip-${clip.device}`}>
      <DeviceFrame kind={clip.device} width={clip.width} height={clip.height}>
        <video
          ref={ref}
          muted
          loop
          playsInline
          controls
          preload="none"
          poster={sitePath(`/media/clips/${clip.name}.webp`)}
          aria-label={label}
        >
          <source
            src={sitePath(`/media/clips/${clip.name}.mp4`)}
            type="video/mp4"
          />
        </video>
      </DeviceFrame>
    </div>
  );
}
