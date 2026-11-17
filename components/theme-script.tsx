// Applies the stored theme before first paint. The site is a static export, so
// there is no server to resolve this and no way to avoid a flash except a
// blocking script ahead of any renderable markup.
//
// Light is the launch default: a first visit is light whatever the OS prefers,
// and only an explicit toggle switches to dark.
const THEME_SCRIPT =
  "(function(){try{var s=localStorage.getItem('theme');" +
  "document.documentElement.setAttribute('data-theme',s==='dark'?'dark':'light');" +
  '}catch(e){}})();';
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
