'use client';
import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { galleryItems, mediaUrl } from '../lib/gallery';
import { scenes } from '../lib/scenes';
import { sitePath } from '../lib/site-path';
import { ClipPlayer, Exchange } from './exchange';

const stillById = new Map(
  galleryItems.filter((i) => i.kind === 'still').map((i) => [i.id, i]),
);
const allStills = scenes
  .flatMap((s) => s.stills)
  .map((id) => stillById.get(id)!)
  .filter(Boolean);

export function Scenes({ en = false }: { en?: boolean }) {
  const lang = en ? 'en' : 'zh-CN';
  const [open, setOpen] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (open !== null && d && !d.open) d.showModal();
  }, [open]);
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const onClick = (e: MouseEvent) => e.target === d && d.close();
    d.addEventListener('click', onClick);
    return () => d.removeEventListener('click', onClick);
  }, []);
  const step = useCallback(
    (dir: number) =>
      setOpen((o) =>
        o === null ? o : (o + dir + allStills.length) % allStills.length,
      ),
    [],
  );
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, step]);
  const shown = open === null ? undefined : allStills[open];

  return (
    <div className="scenes" id="gallery">
      {scenes.map((scene) => (
        <section
          key={scene.id}
          className="scene wrap"
          id={scene.id}
          aria-labelledby={`${scene.id}-title`}
        >
          <div className="scene-words">
            <h2 id={`${scene.id}-title`}>
              {en ? scene.title.en : scene.title.zh}
            </h2>
            <Exchange lines={scene.lines} en={en} />
            <p className="scene-note">{en ? scene.note.en : scene.note.zh}</p>
          </div>
          <div className={`scene-media count-${scene.clips.length}`}>
            {scene.clips.map((clip) => (
              <ClipPlayer key={clip.name} clip={clip} en={en} />
            ))}
          </div>
          {scene.stills.length > 0 && (
            <ul className="thumbs" aria-label={en ? 'Screenshots' : '截图'}>
              {scene.stills.map((id) => {
                const item = stillById.get(id);
                if (!item) return null;
                return (
                  <li key={id}>
                    <button
                      onClick={(e) => {
                        returnFocus.current = e.currentTarget;
                        setOpen(allStills.indexOf(item));
                      }}
                      aria-label={`${item.title[lang]}${en ? ', enlarge' : '，放大'}`}
                    >
                      <Image
                        src={sitePath(mediaUrl(item))}
                        alt=""
                        width={item.width}
                        height={item.height}
                        loading="lazy"
                        unoptimized
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
      <p className="scenes-source wrap">
        {en
          ? 'All conversations above come from real screen recordings on test accounts. They were recorded in Chinese and are translated here.'
          : '以上对话都来自真实录屏，用的是测试账号。'}
      </p>

      <dialog
        ref={dialogRef}
        className="lightbox"
        aria-label={shown?.title[lang] ?? (en ? 'Screenshot' : '截图')}
        onClose={() => {
          setOpen(null);
          returnFocus.current?.focus();
        }}
      >
        {shown && (
          <>
            <Image
              src={sitePath(mediaUrl(shown))}
              alt={shown.caption[lang]}
              width={shown.width}
              height={shown.height}
              unoptimized
            />
            <p>{shown.caption[lang]}</p>
            <div className="lightbox-controls">
              <button onClick={() => step(-1)}>
                {en ? 'Previous' : '上一张'}
              </button>
              <button onClick={() => step(1)}>{en ? 'Next' : '下一张'}</button>
              <button onClick={() => dialogRef.current?.close()}>
                {en ? 'Close' : '关闭'}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
