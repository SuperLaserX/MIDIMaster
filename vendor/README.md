# Bundled libraries

Copied into the repository so the app works offline and in the desktop app (no CDN). Nothing here is
built; the files are used as they are.

| Folder | What | Version | License |
|---|---|---|---|
| `webawesome/` | [Web Awesome](https://webawesome.com) (free edition): web components and styles | 3.15.0 (npm `@awesome.me/webawesome`) | MIT, `webawesome/LICENSE.md` |
| `icons/` | [Font Awesome Free](https://fontawesome.com) icons, the ones the app uses (`solid/`, `regular/`) | 7.3.1 (npm `@fortawesome/fontawesome-free`) | Icons CC BY 4.0, `icons/LICENSE.txt` |
| `fonts/inter/` | [Inter](https://rsms.me/inter/) variable font, latin and latin-ext | 5.3.0 (npm `@fontsource-variable/inter`) | SIL OFL 1.1, `fonts/inter/LICENSE.txt` |

## Web Awesome

`webawesome/` is the package's browser build (`dist-cdn/`) without what a browser never loads: the
React wrappers, server-side rendering, TypeScript types and the metadata JSON. To update it:

```
npm pack @awesome.me/webawesome@<version>        # then unpack it somewhere outside the repo
# copy dist-cdn/{chunks,components,styles,translations,utilities,events,internal,assets}
# and dist-cdn/webawesome.js, webawesome.loader.js, plus LICENSE.md, into vendor/webawesome/;
# delete *.d.ts, *.ts and internal/test
```

How the app uses it:

- `index.html` loads `webawesome/styles/webawesome.css` (theme, native element styles, utilities),
  then `css/theme.css` (MIDIMaster's theme: neutrals, Inter, density, the accent colour as the brand
  colour) and `css/app.css`.
- `js/core/ui/wa.js` imports the components the app uses (dialog, toast, tab group, badge, switch,
  radio group, popup, icon...) and points Web Awesome at `vendor/` for its base path and icons. Add an
  import there to use another component.
- `js/core/theme.js` puts `wa-dark` or `wa-light` on `<html>` and sets the brand colour tones from the
  accent colour in Settings.

## Icons

`<wa-icon name="gear">` loads `icons/solid/gear.svg` (`variant="regular"`: `icons/regular/`). Only the
icons listed in `icons/sync-icons.mjs` are bundled; to use another one, add its name there and run

```
npm pack @fortawesome/fontawesome-free@7.3.1     # unpack it outside the repo
node vendor/icons/sync-icons.mjs <unpacked>/package
```

Page symbols in device definitions (`icon: '◆'`) become icons in one place, `js/core/ui/icons.js`.
