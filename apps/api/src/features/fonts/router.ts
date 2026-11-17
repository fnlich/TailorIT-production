import { Router } from 'express';
import { readFontFile, resumeFontFaceCss } from '../../core/fonts';
import { notFound } from '../../core/http/errors';

// /api/fonts: the bundled OFL font files and the resume editor's @font-face rules. Public: nothing here is per account.

const FONT_CACHE = 'public, max-age=31536000, immutable';

/** Mounted at /api/fonts. */
export function createFontsRouter(): Router {
  const router = Router();

  // Every face of every resume font pair, so the editor can switch pairs without loading another stylesheet.
  router.get('/resume.css', (_req, res) => {
    const css = resumeFontFaceCss('all', (file) => `/api/fonts/${file}`);
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(css);
  });

  router.get('/:file', (req, res, next) => {
    const font = readFontFile(String(req.params.file));
    if (!font) return next(notFound('That font'));
    res.setHeader('Content-Type', 'font/woff2');
    res.setHeader('Cache-Control', FONT_CACHE);
    res.end(font);
  });

  return router;
}
