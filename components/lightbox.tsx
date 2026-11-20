'use client';
import Image from 'next/image';
import { useCallback, useEffect, useRef } from 'react';

export type Shot = {
  src: string;
  width: number;
  height: number;
  title: string;
  caption: string;
};

// A modal viewer for a list of screenshots. `open` is the index on show, or null.
export function Lightbox({
  shots,
  open,
  setOpen,
  en,
}: {
  shots: Shot[];
  open: number | null;
  setOpen: (fn: (o: number | null) => number | null) => void;
  en: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (open !== null && d && !d.open) {
      returnFocus.current = document.activeElement;
      d.showModal();
    }
  }, [open]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const onClick = (e: MouseEvent) => e.target === d && d.close();
    d.addEventListener('click', onClick);
    return () => d.removeEventListener('click', onClick);
  }, []);
  const step = useCallback(
    (dir: number) =>
      setOpen((o) =>
        o === null ? o : (o + dir + shots.length) % shots.length,
      ),
    [setOpen, shots.length],
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

  const shot = open === null ? undefined : shots[open];
  return (
    <dialog
      ref={dialog}
      className="lightbox"
      aria-label={shot?.title ?? (en ? 'Screenshot' : '截图')}
      onClose={() => {
        setOpen(() => null);
        (returnFocus.current as HTMLElement | null)?.focus();
      }}
    >
      {shot && (
        <>
          <Image
            src={shot.src}
            alt={shot.caption}
            width={shot.width}
            height={shot.height}
            unoptimized
          />
          <p>
            <b>{shot.title}</b>
            {shot.caption}
          </p>
          <div className="lightbox-controls">
            {shots.length > 1 && (
              <>
                <button type="button" onClick={() => step(-1)}>
                  {en ? 'Previous' : '上一张'}
                </button>
                <button type="button" onClick={() => step(1)}>
                  {en ? 'Next' : '下一张'}
                </button>
              </>
            )}
            <button type="button" onClick={() => dialog.current?.close()}>
              {en ? 'Close' : '关闭'}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
