'use client';
import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { galleryItems, mediaUrl } from '../lib/gallery';
import { groups } from '../lib/scenes';
import { sitePath } from '../lib/site-path';
import { ClipPlayer, Exchange } from './exchange';

const stillById = new Map(
  galleryItems.filter((i) => i.kind === 'still').map((i) => [i.id, i]),
);
const allStills = groups
  .flatMap((g) => g.stills)
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
      {groups.map((group) => (
        <section
          key={group.id}
          className="group wrap"
          id={group.id}
          aria-labelledby={`${group.id}-title`}
        >
          <h2 id={`${group.id}-title`}>
            {en ? group.title.en : group.title.zh}
          </h2>
          <div className="demos">
            {group.demos.map((demo) => {
              const label = en ? demo.label.en : demo.label.zh;
              const kind = demo.clips.some((c) => c.device === 'mac')
                ? 'wide'
                : 'narrow';
              return (
                <figure
                  key={demo.id}
                  className={`demo demo-${kind}`}
                  id={demo.id}
                >
                  <div className="demo-media">
                    {demo.clips.map((clip) => (
                      <ClipPlayer key={clip.name} clip={clip} label={label} />
                    ))}
                  </div>
                  <figcaption>
                    <span className="demo-label">{label}</span>
                    {demo.lines.length > 0 && (
                      <details>
                        <summary>
                          {en ? 'Read the conversation' : '看完整对话'}
                        </summary>
                        <Exchange lines={demo.lines} en={en} />
                      </details>
                    )}
                  </figcaption>
                </figure>
              );
            })}
          </div>
          {group.stills.length > 0 && (
            <ul className="thumbs" aria-label={en ? 'Screenshots' : '截图'}>
              {group.stills.map((id) => {
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
          ? 'Every clip above is a real screen recording on a test account. Conversations were recorded in Chinese and are translated here.'
          : '以上都是真实录屏，用的是测试账号。'}
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
