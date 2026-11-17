'use client';
import Image from 'next/image';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { galleryFeatures, galleryItems, mediaUrl, type GalleryItem } from '../lib/gallery';
import { sitePath } from '../lib/site-path';
import { DeviceFrame } from './device-frame';

const stills = galleryItems.filter((i) => i.kind === 'still');
const macStills = stills.filter((i) => i.device === 'mac');
const phoneStills = stills.filter((i) => i.device !== 'mac');
// The lightbox walks the wall in on-screen order.
const wall = [...macStills, ...phoneStills];

function itemsFor(feature: string) {
  const own = galleryItems.filter((i) => i.feature === feature && i.kind !== 'film');
  return [...own.filter((i) => i.kind === 'clip'), ...own.filter((i) => i.kind === 'still')];
}

function Stage({ item, lang }: { item: GalleryItem; lang: 'en' | 'zh-CN' }) {
  const ref = useRef<HTMLVideoElement>(null);
  const reduce = useRef(false);
  useEffect(() => {
    reduce.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (item.kind === 'clip' && !reduce.current) ref.current?.play().catch(() => {});
  }, [item]);
  if (item.kind === 'still') {
    return (
      <Image
        className={`stage-still stage-still-${item.device === 'mac' ? 'mac' : 'phone'}`}
        src={sitePath(mediaUrl(item))}
        alt={item.caption[lang]}
        width={item.width}
        height={item.height}
        unoptimized
      />
    );
  }
  const kind = item.device === 'mac' ? 'mac' : 'phone';
  return (
    <DeviceFrame kind={kind} width={item.width} height={item.height}>
      <video
        key={item.id}
        ref={ref}
        muted
        loop
        playsInline
        controls
        preload="metadata"
        poster={sitePath(mediaUrl(item, 'poster'))}
        aria-label={item.title[lang]}
      >
        <source src={sitePath(mediaUrl(item))} type="video/mp4" />
      </video>
    </DeviceFrame>
  );
}

export function Gallery({ en = false }: { en?: boolean }) {
  const lang = en ? 'en' : 'zh-CN';
  const uid = useId();
  const [feature, setFeature] = useState(galleryFeatures[0].id);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const list = itemsFor(feature);
  const current = list[index] ?? list[0];
  const featureTitle = galleryFeatures.find((f) => f.id === feature)?.title[lang];

  const pick = (id: string) => {
    setFeature(id);
    setIndex(0);
  };
  const onRailKey = (e: React.KeyboardEvent, i: number) => {
    const move = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!move) return;
    e.preventDefault();
    const next = galleryFeatures[(i + move + galleryFeatures.length) % galleryFeatures.length];
    pick(next.id);
    document.getElementById(`${uid}-rail-${next.id}`)?.focus();
  };

  const show = (i: number, el: HTMLElement) => {
    returnFocus.current = el;
    setOpen(i);
  };
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
  const step = useCallback((dir: number) => setOpen((o) => (o === null ? o : (o + dir + wall.length) % wall.length)), []);
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, step]);
  const shown = open === null ? undefined : wall[open];

  const wallButton = (item: GalleryItem) => (
    <button
      key={item.id}
      className={`wall-item wall-${item.device === 'mac' ? 'mac' : 'phone'}`}
      onClick={(e) => show(wall.indexOf(item), e.currentTarget)}
      aria-label={`${item.title[lang]}, ${en ? 'enlarge' : '放大'}`}
    >
      <Image src={sitePath(mediaUrl(item))} alt={item.caption[lang]} width={item.width} height={item.height} loading="lazy" unoptimized />
      <span>{item.title[lang]}</span>
    </button>
  );

  return (
    <section className="gallery theme-dark" id="gallery" aria-labelledby={`${uid}-title`}>
      <div className="wrap">
        <header className="gallery-head">
          <h2 id={`${uid}-title`}>{en ? 'See it work' : '看它干活'}</h2>
          <p>{en ? 'Real recordings on test accounts. Nothing is edited into a success.' : '都是真实录屏，用的是测试账号，没有剪出来的“成功”。'}</p>
        </header>

        <div className="stage">
          <div className="stage-side">
            <div className="rail" role="tablist" aria-orientation="vertical" aria-label={en ? 'What Nova can do' : 'Nova 能做什么'}>
              {galleryFeatures.map((f, i) => (
                <button
                  key={f.id}
                  role="tab"
                  id={`${uid}-rail-${f.id}`}
                  aria-selected={feature === f.id}
                  aria-controls={`${uid}-stage`}
                  tabIndex={feature === f.id ? 0 : -1}
                  onClick={() => pick(f.id)}
                  onKeyDown={(e) => onRailKey(e, i)}
                >
                  {f.title[lang]}
                </button>
              ))}
            </div>
            {current && (
              <div className="stage-caption" aria-live="polite">
                <strong>{current.title[lang]}</strong>
                <span>{current.caption[lang]}</span>
              </div>
            )}
          </div>

          <div className="stage-main" role="tabpanel" id={`${uid}-stage`} aria-label={featureTitle}>
            <div className="stage-view">{current && <Stage item={current} lang={lang} />}</div>
            {list.length > 1 && (
              <ul className="strip" aria-label={en ? 'More from this capability' : '同类内容'}>
                {list.map((item, i) => (
                  <li key={item.id}>
                    <button
                      aria-current={i === index}
                      aria-label={`${item.title[lang]}${item.kind === 'clip' ? (en ? ', clip' : '，短片') : ''}`}
                      onClick={() => setIndex(i)}
                    >
                      <Image
                        src={sitePath(mediaUrl(item, item.kind === 'clip' ? 'poster' : 'src'))}
                        alt=""
                        width={item.kind === 'clip' ? 320 : item.width}
                        height={item.kind === 'clip' ? Math.round((320 * item.height) / item.width) : item.height}
                                                unoptimized
                      />
                      {item.kind === 'clip' && <i aria-hidden="true">▶</i>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="wall">
          <h3>{en ? 'Screenshots' : '截图'}</h3>
          <div className="wall-mac">{macStills.map(wallButton)}</div>
          <div className="wall-phones">{phoneStills.map(wallButton)}</div>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className="lightbox"
        aria-label={shown?.title[lang] ?? (en ? 'Image viewer' : '图片查看')}
        onClose={() => {
          setOpen(null);
          returnFocus.current?.focus();
        }}
      >
        {shown && (
          <>
            <Image src={sitePath(mediaUrl(shown))} alt={shown.caption[lang]} width={shown.width} height={shown.height} unoptimized />
            <p>
              <strong>{shown.title[lang]}</strong> {shown.caption[lang]}
            </p>
            <div className="lightbox-controls">
              <button onClick={() => step(-1)} aria-label={en ? 'Previous' : '上一张'}><ArrowLeft size={18} /></button>
              <button onClick={() => step(1)} aria-label={en ? 'Next' : '下一张'}><ArrowRight size={18} /></button>
              <button onClick={() => dialogRef.current?.close()} aria-label={en ? 'Close' : '关闭'}><X size={18} /></button>
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
