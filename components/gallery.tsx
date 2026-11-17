'use client';
/* oxlint-disable jsx-a11y/media-has-caption -- Silent product recordings; each carries a visible caption. */
import Image from 'next/image';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, X } from 'lucide-react';
import {
  galleryFeatures,
  galleryItems,
  mediaUrl,
  type GalleryItem,
} from '../lib/gallery';
import { sitePath } from '../lib/site-path';

type Tab = 'still' | 'clip' | 'film';

export function Gallery({ en = false }: { en?: boolean }) {
  const lang = en ? 'en' : 'zh-CN';
  const uid = useId();
  const [tab, setTab] = useState<Tab>('still');
  const [feature, setFeature] = useState('all');
  const [open, setOpen] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const tabs: [Tab, string][] = [
    ['still', en ? 'Stills' : '静帧'],
    ['clip', en ? 'Clips' : '短片'],
    ['film', en ? 'Film' : '完整片'],
  ];
  const features = galleryFeatures.filter((f) =>
    galleryItems.some((i) => i.kind === tab && i.feature === f.id),
  );
  const items = galleryItems.filter(
    (i) =>
      i.kind === tab &&
      (tab === 'film' || feature === 'all' || i.feature === feature),
  );

  const close = useCallback(() => dialogRef.current?.close(), []);
  const show = (index: number, el: HTMLElement) => {
    returnFocus.current = el;
    setOpen(index);
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
  const step = useCallback(
    (dir: number) =>
      setOpen((o) =>
        o === null ? o : (o + dir + items.length) % items.length,
      ),
    [items.length],
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
  const current: GalleryItem | undefined =
    open === null ? undefined : items[open];

  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    const next =
      e.key === 'ArrowRight'
        ? index + 1
        : e.key === 'ArrowLeft'
          ? index - 1
          : null;
    if (next === null) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length][0];
    setTab(target);
    setFeature('all');
    document.getElementById(`${uid}-tab-${target}`)?.focus();
  };

  return (
    <section
      className="gallery wrap"
      id="gallery"
      aria-labelledby={`${uid}-title`}
    >
      <div className="main-features-heading">
        <p className="section-label">{en ? 'Gallery' : '画廊'}</p>
        <h2 id={`${uid}-title`}>
          {en ? 'See it work, on real devices.' : '在真实设备上，看它做事。'}
        </h2>
        <p className="lead">
          {en
            ? 'Every still and clip is a real recording of persona accounts. Nothing is spliced into a fake success.'
            : '所有静帧与短片均为真实录屏，使用虚构人设账号，不拼接假成功。'}
        </p>
      </div>

      <div
        className="gallery-tabs"
        role="tablist"
        aria-label={en ? 'Media type' : '媒体类型'}
      >
        {tabs.map(([id, label], i) => (
          <button
            key={id}
            role="tab"
            id={`${uid}-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`${uid}-panel`}
            tabIndex={tab === id ? 0 : -1}
            onKeyDown={(e) => onTabKey(e, i)}
            onClick={() => {
              setTab(id);
              setFeature('all');
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== 'film' && (
        <fieldset className="gallery-filters">
          <legend className="sr-only">
            {en ? 'Filter by capability' : '按能力筛选'}
          </legend>
          {[
            { id: 'all', title: { en: 'All', 'zh-CN': '全部' } },
            ...features,
          ].map((f) => (
            <button
              key={f.id}
              aria-pressed={feature === f.id}
              onClick={() => setFeature(f.id)}
            >
              {f.title[lang]}
            </button>
          ))}
        </fieldset>
      )}

      <div
        className={`gallery-grid gallery-${tab}`}
        role="tabpanel"
        id={`${uid}-panel`}
        aria-labelledby={`${uid}-tab-${tab}`}
      >
        {items.map((item, index) => (
          <figure className="gallery-card" key={item.id}>
            {item.kind === 'still' ? (
              <button
                className="gallery-media"
                onClick={(e) => show(index, e.currentTarget)}
                aria-label={`${item.title[lang]} — ${en ? 'enlarge' : '放大'}`}
              >
                <Image
                  src={sitePath(mediaUrl(item))}
                  alt={item.caption[lang]}
                  loading="lazy"
                  width={item.width}
                  height={item.height}
                />
              </button>
            ) : (
              <div className={`gallery-media gallery-video-${item.kind}`}>
                <video
                  controls
                  playsInline
                  loop={item.kind === 'clip'}
                  preload="none"
                  poster={sitePath(mediaUrl(item, 'poster'))}
                  aria-label={item.title[lang]}
                >
                  <source src={sitePath(mediaUrl(item))} type="video/mp4" />
                </video>
              </div>
            )}
            <figcaption>
              <strong>{item.title[lang]}</strong>
              <span>{item.caption[lang]}</span>
              {item.kind === 'film' && (
                <em>
                  {item.externalUrl ? (
                    <a href={item.externalUrl} target="_blank" rel="noreferrer">
                      {en ? 'Watch the full film' : '观看完整片'}{' '}
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </a>
                  ) : en ? (
                    '720p preview. Full-length link coming soon.'
                  ) : (
                    '720p 预览版，完整版链接即将补充。'
                  )}
                </em>
              )}
            </figcaption>
          </figure>
        ))}
      </div>

      <dialog
        ref={dialogRef}
        className="lightbox"
        aria-label={current?.title[lang] ?? (en ? 'Image viewer' : '图片查看')}
        onClose={() => {
          setOpen(null);
          returnFocus.current?.focus();
        }}
      >
        {current && (
          <>
            <Image
              src={sitePath(mediaUrl(current))}
              alt={current.caption[lang]}
              width={current.width}
              height={current.height}
            />
            <p>
              <strong>{current.title[lang]}</strong> {current.caption[lang]}
            </p>
            <div className="lightbox-controls">
              <button
                onClick={() => step(-1)}
                aria-label={en ? 'Previous' : '上一张'}
              >
                <ArrowLeft size={18} />
              </button>
              <button
                onClick={() => step(1)}
                aria-label={en ? 'Next' : '下一张'}
              >
                <ArrowRight size={18} />
              </button>
              <button onClick={close} aria-label={en ? 'Close' : '关闭'}>
                <X size={18} />
              </button>
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
