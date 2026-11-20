'use client';
import Image from 'next/image';
import { useState } from 'react';
import { galleryItems, mediaUrl } from '../lib/gallery';
import { sitePath } from '../lib/site-path';
import { Lightbox, type Shot } from './lightbox';

// Laid out like the README's gallery: three to a row, computer screenshots
// first, then phone screenshots at one height, each with a title and a line.
const PC = [
  'pc-proactive-invite',
  'pc-draft-unsent',
  'pc-computer-use',
  'pc-timeline-cited',
  'pc-build-receipt',
  'pc-morning-brief',
];
const PHONE = [
  'phone-voice-site',
  'phone-site-result',
  'phone-mobile-result',
  'phone-docx',
  'iphone-feed',
  'iphone-morning',
];
const byId = new Map(galleryItems.map((i) => [i.id, i]));

export function GalleryGrid({ en = false }: { en?: boolean }) {
  const lang = en ? 'en' : 'zh-CN';
  const [open, setOpen] = useState<number | null>(null);
  const items = [...PC, ...PHONE].map((id) => byId.get(id)!);
  const shots: Shot[] = items.map((i) => ({
    src: sitePath(mediaUrl(i)),
    width: i.width,
    height: i.height,
    title: i.title[lang],
    caption: i.caption[lang],
  }));

  const tile = (i: number) => (
    <li key={items[i].id}>
      <button
        type="button"
        onClick={() => setOpen(() => i)}
        aria-label={`${shots[i].title}${en ? ', enlarge' : '，放大'}`}
      >
        <Image
          src={shots[i].src}
          alt=""
          width={shots[i].width}
          height={shots[i].height}
          loading="lazy"
          unoptimized
        />
      </button>
      <p>
        <b>{shots[i].title}</b>
        {shots[i].caption}
      </p>
    </li>
  );

  return (
    <section
      className="gallery wrap"
      id="gallery"
      aria-labelledby="gallery-title"
    >
      <h2 id="gallery-title">SHOW CASE</h2>
      <ul className="gallery-pc">{PC.map((_, i) => tile(i))}</ul>
      <ul className="gallery-phone">
        {PHONE.map((_, i) => tile(PC.length + i))}
      </ul>
      <p className="gallery-note">
        {en
          ? 'Real screenshots on a persona test account.'
          : '均为真实截图，使用人设测试账号。'}
      </p>
      <Lightbox shots={shots} open={open} setOpen={setOpen} en={en} />
    </section>
  );
}
