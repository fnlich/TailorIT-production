import type { Feature } from '../../core/feature';
import { SKILLS_ACTING } from './acting'; // v33 SHARE-6
import { createSkillsRouter } from './router';

// Skill library (skills.json) + per-user skills. Owned by work package R1.
export const skillsFeature: Feature = {
  name: 'skills',
  routes: [
    { path: '/api/skills', router: createSkillsRouter, acting: SKILLS_ACTING /* v33 SHARE-6 */ },
  ],
};
