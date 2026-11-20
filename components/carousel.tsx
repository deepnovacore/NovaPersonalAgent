'use client';
import Image from 'next/image';
import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Shot } from './lightbox';

// Screenshots one at a time: swipe or scroll the track, use the arrows or the
// dots, or the arrow keys once focused. No autoplay. A click enlarges the shot.
export function Carousel({
  shots,
  start = 0,
  onOpen,
  label,
  en = false,
}: {
  shots: Shot[];
  start?: number;
  onOpen: (index: number) => void;
  label: string;
  en?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(0);
  const n = shots.length;

  function go(i: number) {
    const t = track.current;
    if (!t) return;
    const k = (i + n) % n;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)')
      .matches;
    t.scrollTo({
      left: k * t.clientWidth,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') go(cur + 1);
    else if (e.key === 'ArrowLeft') go(cur - 1);
    else return;
    e.preventDefault();
  }

  return (
    <section
      className="carousel"
      aria-roledescription={en ? 'carousel' : '轮播'}
      aria-label={label}
    >
      <div
        className="carousel-track"
        ref={track}
        onScroll={(e) => {
          const t = e.currentTarget;
          setCur(Math.round(t.scrollLeft / t.clientWidth));
        }}
      >
        {shots.map((s, i) => (
          <button
            key={s.src}
            type="button"
            className="carousel-slide"
            onClick={() => onOpen(start + i)}
            aria-label={`${s.title}${en ? ', enlarge' : '，放大'}`}
            tabIndex={i === cur ? 0 : -1}
            onKeyDown={onKey}
          >
            <Image
              src={s.src}
              alt=""
              width={s.width}
              height={s.height}
              unoptimized
            />
          </button>
        ))}
      </div>
      <div className="carousel-bar">
        <p aria-live="polite">
          <b>{shots[cur].title}</b>
          {shots[cur].caption}
        </p>
        <div className="carousel-nav">
          <button
            type="button"
            onClick={() => go(cur - 1)}
            aria-label={en ? 'Previous' : '上一张'}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="carousel-dots" aria-hidden="true">
            {shots.map((s, i) => (
              <i key={s.src} data-on={i === cur || undefined} />
            ))}
          </span>
          <button
            type="button"
            onClick={() => go(cur + 1)}
            aria-label={en ? 'Next' : '下一张'}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </section>
  );
}
