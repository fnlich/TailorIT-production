'use client';

import { createContext } from 'react';

/**
 * How an "Answer these once" link reaches its card (v1.4 E): in the profile wizard, the card's step opens and the card
 * takes focus. Null: the link is a plain #anchor on the page.
 */
export const SectionLinkContext = createContext<((section: string) => void) | null>(null);
