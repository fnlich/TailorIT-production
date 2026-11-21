// v33 LEGACY: the skill library as the API's resume code reads it (the part of the retired packages/render and of the
// resume render engine that outlived the 26 Handlebars templates): the pure index and its headings (library.ts), a
// resume's own skills block (groups.ts), each user's library (service.ts), and the one way an older or AI-made
// document becomes an editor document (editor-document.ts). The vocabulary itself is ../skills-vocabulary.ts.

export {
  createSkillIndex,
  fieldSkillCategory,
  inferSkillCategory,
  libraryCategory,
  renderSkillCategory,
  skillIndexKey,
  withExtraSkills,
  type SkillIndex,
  type SkillRecord,
} from './library';
export { dedupeSkills, skillGroupsFor, type SkillGroup } from './groups';
export { skillLibraryIndex, skillsFor, skillsStamp, userSkillRows, type UserSkillRow } from './service';
export { editorDocumentOf } from './editor-document';
