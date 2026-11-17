import type { Feature } from '../../core/feature';
import { createFontsRouter } from './router';

// The bundled web fonts, for the resume editor (cover letters keep their own alias under /api/cover-letters/fonts).
export const fontsFeature: Feature = {
  name: 'fonts',
  routes: [{ path: '/api/fonts', router: createFontsRouter }],
};
