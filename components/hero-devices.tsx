'use client';
import { useEffect, useRef } from 'react';
import { sitePath } from '../lib/site-path';
import { DeviceFrame } from './device-frame';

function Loop({ name, label, width, height }: { name: string; label: string; width: number; height: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    video.play().catch(() => {});
  }, []);
  return (
    <video
      ref={ref}
      muted
      loop
      playsInline
      preload="metadata"
      poster={sitePath(`/media/clips/${name}.webp`)}
      aria-label={label}
      width={width}
      height={height}
    >
      <source src={sitePath(`/media/clips/${name}.mp4`)} type="video/mp4" />
    </video>
  );
}

export function HeroDevices({ en = false }: { en?: boolean }) {
  return (
    <div className="hero-devices">
      <DeviceFrame kind="mac" width={1920} height={1126} className="hero-mac">
        <Loop
          name="computer-use"
          width={1920}
          height={1126}
          label={en ? 'Nova searching for a video and liking it on a Mac' : 'Nova 在 Mac 上搜索视频并点赞'}
        />
      </DeviceFrame>
      <DeviceFrame kind="phone" width={900} height={2002} className="hero-phone">
        <Loop
          name="phone-docx"
          width={900}
          height={2002}
          label={en ? 'Nova reading a paper and writing a document on an iPhone' : 'Nova 在 iPhone 上读论文、写文档'}
        />
      </DeviceFrame>
    </div>
  );
}
