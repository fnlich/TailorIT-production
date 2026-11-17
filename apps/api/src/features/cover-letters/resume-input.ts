import { documentPlainText, printedDocument, type ResumeDocument } from '@tailorit/shared';
import type { ResumeEvidence } from '../resumes/evidence';

// The resume as the letter prompts quote it (ai/prompts/cover-letters: their RESUME block), and as the MCP server's
// letter step hands it to the person's AI. v30 ST1: moved unchanged from ./prompts.ts when the prompts moved to the
// prompt catalogue.

const RESUME_TEXT_LIMIT = 20_000;

/**
 * The resume as the prompt shows it: the document's facts as JSON (no contact details), or an upload's text. v1.3 C
 * (decision 12): compact JSON, with no indentation or line breaks, which the model reads as well and which leaves more
 * of a long resume under the cap.
 */
export function resumeForPrompt(evidence: ResumeEvidence): string {
  const document = evidence.document;
  if (!document) return evidence.text.slice(0, RESUME_TEXT_LIMIT);
  return JSON.stringify(compactResume(document)).slice(0, RESUME_TEXT_LIMIT);
}

function present<T>(value: T): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** Drops empty strings, lists and objects, so the prompt carries only what the person wrote. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune).filter(present);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => [key, prune(inner)] as const)
      .filter(([, inner]) => present(inner));
    return Object.fromEntries(entries);
  }
  return typeof value === 'string' ? value.trim() : value;
}

/** The resume as the model reads it: the printed words of marked-up text, and no editor bookkeeping (ids, toggles). */
function compactResume(stored: ResumeDocument): unknown {
  const document = documentPlainText(printedDocument(stored));
  return prune({
    name: document.name,
    title: document.title,
    totalYearsExperience: document.totalYearsExperience,
    summary: document.summary,
    experience: document.experience.map((entry) => ({
      title: entry.title,
      company: entry.company,
      startDate: entry.startDate,
      endDate: entry.endDate,
      location: entry.location,
      description: entry.description,
      achievements: entry.achievements,
      skills: entry.skills,
    })),
    strengths: document.strengths.map((entry) => ({ title: entry.title, description: entry.description })),
    skills: document.skills,
    skillCategories: document.skillCategories,
    softSkills: document.softSkills,
    education: document.education.map((entry) => ({
      degree: entry.degree,
      institution: entry.institution,
      startDate: entry.startDate,
      endDate: entry.endDate,
      achievements: entry.achievements,
    })),
    certifications: document.certifications?.map((entry) => ({ name: entry.name, issuer: entry.issuer, date: entry.date })),
    projects: document.projects?.map((entry) => ({
      name: entry.name,
      role: entry.role,
      description: entry.description,
      achievements: entry.achievements,
    })),
    volunteering: document.volunteering?.map((entry) => ({
      role: entry.role,
      organization: entry.organization,
      description: entry.description,
      achievements: entry.achievements,
    })),
    awards: document.awards?.map((entry) => ({ title: entry.title, issuer: entry.issuer, description: entry.description })),
    publications: document.publications?.map((entry) => ({ title: entry.title, description: entry.description })),
    languages: document.languages?.map((entry) => ({ language: entry.language, proficiency: entry.proficiency })),
    courses: document.courses?.map((entry) => ({ name: entry.name, institution: entry.institution })),
  });
}
