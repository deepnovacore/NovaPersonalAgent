# Nova website

The product homepage and documentation site are built with React and Next.js, exported as static files for GitHub Pages. The original product design comes from the sibling `nova-personal-agent-website` prototype; that directory is preserved.

The site root serves English by default. The Chinese homepage is at `/zh/`; `/en/` remains an English homepage alias. Existing English (`/en/docs/`) and Chinese (`/docs/`) documentation URLs stay available. Language switches preserve the current page or homepage section.

## One documentation source

Edit `../docs/en/**/*.md` or `../docs/zh-CN/**/*.md`. `scripts/docs.mjs` generates page content, heading IDs, navigation and links at build time. Only these two documentation directories and their referenced images are included. Demo state and other development documents are excluded. Generated content and copied images are ignored by Git.

Markdown keeps its repository-relative links. Website links point to the corresponding page; links to source code point to the public `main` branch on GitHub. Every document has an English and Simplified Chinese counterpart. Users and Developers have separate top-level navigation and sidebars. Language switching is available only in the shared header. Language switching preserves the selected article.

## Local development

From this directory:

```sh
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3108
```

Open `http://127.0.0.1:3108/` or `/en/docs/`. Changes to Markdown regenerate the content while the development server is running.

## Preview the exact GitHub Pages output

```sh
NEXT_PUBLIC_BASE_PATH=/nova-personal-agent npm run build
NEXT_PUBLIC_BASE_PATH=/nova-personal-agent npm run check:links
NEXT_PUBLIC_BASE_PATH=/nova-personal-agent npm start
# verify byte ranges used by video players
node --test scripts/serve.test.mjs
```

Open `http://127.0.0.1:3108/nova-personal-agent/`. The server binds only to loopback. Set `PORT` to choose another port. Rebuild after editing source when using this static preview.

## GitHub Pages

The root `.github/workflows/website.yml` builds relevant pull requests and deploys changes from the public `main` branch only. It never publishes from `internal` or the internal repository. Enable **Settings → Pages → Build and deployment → Source: GitHub Actions** before the first deployment.

The workflow derives its base path from the GitHub repository name (`/nova-personal-agent` after renaming). For a custom domain hosted at its root, change `NEXT_PUBLIC_BASE_PATH` in the workflow to an empty string and configure the domain in GitHub Pages. The generated `out/` directory is the deployment artifact; no generated-content Git branch is needed.

The website build is independent of the application's npm workspaces and does not build or modify the application runtime.

The support matrix lives in `docs/{en,zh-CN}/support-matrix.md`; executor guides live in `docs/{en,zh-CN}/executors/`. Update both language versions when capability support changes. The homepage includes a bilingual product film at `#film` and uses the bilingual architecture illustration from `assets/architecture/`.

Search uses a local, build-generated title and full-text index. It loads only when search opens, filters to the current page language, supports Chinese substrings and multi-term queries, and opens with Command/Ctrl+K. No external search account or backend is needed.

Homepage feature copy is maintained independently in `lib/home-features.ts`; images reuse `assets/features/` from the repository. The homepage does not parse README content.

## Product film

`public/media/film/` contains the English and Chinese H.264/AAC MP4s and their supplied PNG covers. The homepage selects the page language, uses native video controls with `playsInline` and `preload="none"`, and links to the other language at `#film`. The film has music and on-screen text, with no spoken dialogue. Keep the short scenario-film caption beside it.

Both READMEs embed the corresponding uploaded GitHub video attachment as a bare URL, outside HTML blocks, immediately before News. GitHub hosts the README players; the website serves its own copies from `public/media/film/`. When replacing a film, upload a new attachment and update only the corresponding README URL. The official GitHub CLI supports `--attach` for issue/PR commands; its upload API accepts the same existing CLI authentication without requiring a placeholder issue. Do not publish an issue merely to obtain an attachment URL.

The prepared MP4s are below 10,000,000 bytes, suitable for GitHub's free-plan video attachment limit. GitHub's paid-plan limit is 100 MB; website delivery is independent of attachment limits. Reference: <https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files>.

The README visitors badges share the Hits key `github.com/deepnovacore/NovaPersonalAgent`. This is a badge-request counter, affected by caching, not a count of unique people or historical GitHub traffic. No historical offset is added.
