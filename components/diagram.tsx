import Image from 'next/image';
import { sitePath } from '../lib/site-path';

// An architecture diagram from assets/architecture, in the page's theme.
export function Diagram({
  name,
  en,
  alt,
  width,
  height,
  className = '',
}: {
  name: string;
  en: boolean;
  alt: string;
  width: number;
  height: number;
  className?: string;
}) {
  const src = (theme: string) =>
    sitePath(
      `/doc-assets/assets/architecture/${name}.${en ? 'en' : 'zh-CN'}.${theme}.svg`,
    );
  return (
    <figure className={`diagram ${className}`}>
      <Image
        unoptimized
        className="only-light"
        src={src('light')}
        alt={alt}
        width={width}
        height={height}
      />
      <Image
        unoptimized
        className="only-dark"
        src={src('dark')}
        alt=""
        aria-hidden="true"
        width={width}
        height={height}
      />
    </figure>
  );
}
