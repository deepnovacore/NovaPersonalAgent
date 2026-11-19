# Public Feeds source register

The only editable catalog is [`runtime/src/news/sources.json`](../runtime/src/news/sources.json).
Flutter ships constants generated with `node clients/flutter/tool/generate_news_sources.mjs`;
`--check` and `clients/flutter/test/news_sources_test.dart` detect drift. No custom RSS or category picker.

## Availability observations (2026-11-04)

All 19 catalog URLs returned HTTP 200 without following redirects using exactly
`FEED_HEADERS` (`Accept: application/rss+xml, application/atom+xml, application/xml, text/xml`,
`User-Agent: NovaPersonalAgent-News/0.3`). Every response parsed with runtime `parseFeed`;
all had articles dated November 2–4. These are point-in-time observations, not uptime guarantees.
NPR's general feed initially had a TLS transport failure, then returned 200 on retry.
BBC Chinese was removed: its simplified feed redirects to a traditional-Chinese endpoint, which does not match the zh-CN source language.
No automatic redirects, arbitrary feed URLs or article-link safety rules were relaxed.
DW's RDF uses `dc:date`, now recognized alongside RSS/Atom dates.
Large real samples remain in ignored local scratch space; repository tests contain synthetic excerpts only.

## Publisher/terms review required

**RSS availability is not a copyright or redistribution license. Terms, attribution requirements,
excerpt caching, third-party/model processing and commercial use remain unverified for every row below.**
Before publication, the owner must review each publisher's current terms and remove any feed that is not permitted.
Feed URLs are in the linked catalog; the links below identify the source parties for that review.

| Source id / name | Source party | Parsed items in observation |
| --- | --- | ---: |
| `bbc` / BBC News | [BBC](https://www.bbc.com/) | 34 |
| `bbc-health` / BBC Health | BBC | 55 |
| `bbc-world` / BBC World | BBC | 32 |
| `bbc-entertainment` / BBC Entertainment | BBC | 35 |
| `bbc-sport` / BBC Sport | BBC | 67 |
| `bbc-science` / BBC Science | BBC | 32 |
| `npr` / NPR | [NPR](https://www.npr.org/) | 9 |
| `npr-health` / NPR Health | NPR | 10 |
| `chinanews-scroll-news` / 中国新闻网 · 滚动 | [中国新闻社 / 中国新闻网](https://www.chinanews.com.cn/) | 30 |
| `chinanews-society` / 中国新闻网 · 社会 | 中国新闻社 / 中国新闻网 | 30 |
| `chinanews-life` / 中国新闻网 · 生活 | 中国新闻社 / 中国新闻网 | 18 |
| `chinanews-sports` / 中国新闻网 · 体育 | 中国新闻社 / 中国新闻网 | 30 |
| `chinanews-culture` / 中国新闻网 · 文化 | 中国新闻社 / 中国新闻网 | 30 |
| `chinanews-finance` / 中国新闻网 · 财经 | 中国新闻社 / 中国新闻网 | 30 |
| `dw-zh` / DW 中文 | [Deutsche Welle](https://www.dw.com/) | 58 |
| `ft-zh` / FT中文 | [Financial Times / FT中文网](https://www.ftchinese.com/) | 20 |
| `rfi-zh` / RFI 中文 | [RFI / France Médias Monde](https://www.rfi.fr/cn/) | 30 |
| `ithome` / IT之家 | [软媒 / IT之家](https://www.ithome.com/) | 60 |
| `sspai` / 少数派 | [少数派](https://sspai.com/) | 10 |

Solidot, 36氪 and Guardian Technology were removed to keep technology a minority.
No unavailable/expired candidates from the implementation request were added.
The per-source cap is by feed id, not a claim of independent publisher ownership;
BBC and China News each supply several feeds.
