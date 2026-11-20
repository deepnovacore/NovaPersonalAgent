// The launch film on YouTube, one cut per language.
const FILM = { zh: 'YHziCK_cKbQ', en: '3qyZupBgOEs' };

export function FilmEmbed({ en = false }: { en?: boolean }) {
  return (
    <figure className="film-embed">
      <div className="film-frame">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${en ? FILM.en : FILM.zh}?rel=0`}
          title={en ? 'Nova launch film' : 'Nova 宣传片'}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
      <figcaption>
        {en ? 'A day with Nova, in two minutes.' : '和 Nova 的一天，两分钟。'}
      </figcaption>
    </figure>
  );
}
