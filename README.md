# WebArchive / MHTML Browser Converter

Browser-side JavaScript implementation equivalent to the attached Python converter.

## Files

- `webarchive-mhtml-browser.js` - ES module library.
- `index.html` - small browser UI.

## Run locally

Because the demo uses ES modules, serve it over HTTP instead of opening it with `file://`:

```sh
python3 -m http.server 8000 --directory public
```

Then open:

```text
http://localhost:8000/index.html
```

## Dependency

The module imports plist support from a CDN:

```js
import {
  parse as parsePlist,
  build as buildXmlPlist,
  buildBinary as buildBinaryPlist,
} from 'https://esm.sh/plist@5.0.0';
```

For production, install and bundle instead:

```sh
npm install plist
```

Then replace the CDN import with a package import.

## API

```js
import {
  convertFile,
  mhtmlFileToWebArchiveBlob,
  webArchiveFileToMhtmlBlob,
  downloadBlob,
} from './webarchive-mhtml-browser.js';

const { blob, filename } = await convertFile(file, {
  target: 'auto',              // 'auto' | 'webarchive' | 'mhtml'
  inlineCidCss: true,          // MHTML -> WebArchive
  plistFormat: 'binary',       // 'binary' | 'xml'
  includeSubframes: true,      // WebArchive -> MHTML
});

downloadBlob(blob, filename);
```
