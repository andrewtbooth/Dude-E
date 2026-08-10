# Vendored typefaces

Three families, checked in rather than fetched at build time.

| File | Family | Weights | Subset |
|---|---|---|---|
| `archivo-latin-var.woff2` | Archivo | 400–700 variable | latin |
| `archivo-narrow-latin-var.woff2` | Archivo Narrow | 500–700 variable | latin |
| `ibm-plex-mono-400-latin.woff2` | IBM Plex Mono | 400 | latin |
| `ibm-plex-mono-600-latin.woff2` | IBM Plex Mono | 600 | latin |

84 KB in total, loaded through `next/font/local` in `src/app/fonts.ts`.

## Why vendored and not `next/font/google`

`next/font/google` downloads at build time and fails the build when it cannot,
which turns every build machine into a host that must reach `fonts.gstatic.com`.
This project's deploy path has already been broken three separate times by
something that worked locally and not in CI, and a font download is exactly that
class of problem. Checked-in files make the build hermetic: no network, same
bytes every time, and one less thing that can be different on Fly than it is
here.

## Why the latin subset only

Google serves these per unicode-range, and `next/font/local` has no way to
express a range, so each family would otherwise need a separate declaration per
subset. The interface is English and the HTSUS is published in English, so the
latin subset (`U+0000-00FF` plus common punctuation) covers it. Anything outside
that range falls through to the stack's system fonts rather than failing to
render — worth knowing if this is ever localised.

## Licensing

Both families are under the SIL Open Font License 1.1, which permits
redistribution with the license included; `OFL-Archivo.txt` and
`OFL-IBMPlexMono.txt` are those licenses, copied verbatim. Neither font is
sold, and neither is distributed under a reserved font name.

Sources: Archivo by Omnibus-Type, IBM Plex Mono by IBM. Both retrieved from
Google Fonts (`fonts.gstatic.com`), Archivo v25 and IBM Plex Mono v20.

## Replacing or adding a weight

Fetch the CSS with a modern browser user-agent — Google serves `.ttf` to
unknown agents and `.woff2` to ones it recognises — then take the `src` URL
belonging to the `U+0000-00FF` unicode-range block:

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
curl -A "$UA" "https://fonts.googleapis.com/css2?family=Archivo:wght@400..700&display=swap"
```
