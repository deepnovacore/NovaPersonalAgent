import manifest from '../../assets/gallery/manifest.json';

export type Lang = 'en' | 'zh-CN';
type Text = { 'zh-CN': string; en: string };
export type GalleryItem = {
  id: string;
  kind: 'still' | 'clip' | 'film';
  feature?: string;
  device?: string;
  src: string;
  poster?: string;
  width: number;
  height: number;
  title: Text;
  caption: Text;
  externalUrl?: string | null;
};
export type Feature = { id: string; title: Text };

export const galleryFeatures = manifest.features as Feature[];
export const galleryItems = manifest.items as GalleryItem[];

// Stills are mirrored from assets/gallery/stills; clips and films only live
// under public/media to keep the repository lean.
export function mediaUrl(item: GalleryItem, file: 'src' | 'poster' = 'src') {
  const value = file === 'poster' ? item.poster : item.src;
  if (!value) return '';
  if (value.startsWith('stills/'))
    return `/media/gallery/${value.slice('stills/'.length)}`;
  return `/media/${value}`;
}
