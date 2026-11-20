'use client';
import { useEffect, useState } from 'react';
import { sitePath } from '../lib/site-path';

// The beaver mascot as a back-to-top button. It appears once the hero has
// scrolled away and takes you back to the top.
export function BackToTop({ en = false }: { en?: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const hero = document.querySelector('#overview');
    if (!hero) return;
    const observer = new IntersectionObserver(([entry]) =>
      setShown(!entry.isIntersecting),
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);
  const toTop = () => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
  };
  return (
    <button
      type="button"
      className="back-to-top"
      data-shown={shown || undefined}
      onClick={toTop}
      aria-label={en ? 'Back to top' : '回到顶部'}
      tabIndex={shown ? 0 : -1}
    >
      {/* oxlint-disable-next-line next/no-img-element -- a small fixed mascot on a static export */}
      <img
        src={sitePath('/brand/beaver-cut.png')}
        alt=""
        width={192}
        height={192}
      />
    </button>
  );
}
