'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useEditorField } from '../../roles/EditorField';
import { addSkill, fetchSkills, resumeKeys, type SkillLibraryList } from '../api';
import { CHIP_REFUSALS } from './parts';
import { cleanChip, librarySpelling } from './spelling';

// The hard-skill library the toolbars' skill boxes suggest from (Technical skills' "+ Skill", a role's "Skills used"):
// the main skills as a <datalist>, each one's other spellings as its label, which the browser searches too, so typing
// "ASP.NET Core" offers ".NET" rather than a second skill that means the same. A skill the library lacks is kept for
// the person (POST /api/skills), which also answers the library's spelling of one it knows by another name.
// v33 SKILLS: the open resume's field's skills come first (a datalist offers its options in their order), and a skill
// the person adds is filed under the field's heading.

export interface SkillLibrary {
  /** The id to give the input's `list`. */
  listId: string;
  /** The <datalist>, to render beside the input. */
  suggestions: ReactNode;
  /** The library's spelling of `value`; the value as typed when the library cannot be asked. */
  spell(value: string): Promise<string>;
}

const Suggestions = memo(function Suggestions({ id, library }: { id: string; library: SkillLibraryList | undefined }) {
  if (!library) return null;
  return (
    <datalist id={id}>
      {library.skills.map((skill) => (
        <option key={skill} value={skill} label={library.aliases[skill]?.join(', ')} />
      ))}
    </datalist>
  );
});

/** The library, loaded once `enabled` (a box for interests or soft skills never asks for it), the field's skills first. */
export function useSkillLibrary(enabled = true): SkillLibrary {
  const listId = useId();
  const queryClient = useQueryClient();
  const family = useEditorField().familyId;
  const { data } = useQuery({
    queryKey: resumeKeys.skills('hard', family),
    queryFn: ({ signal }) => fetchSkills('hard', signal, family),
    staleTime: 30 * 60_000,
    enabled,
  });

  const spell = useCallback(
    async (value: string) => {
      const typed = cleanChip(value);
      const known = librarySpelling(data?.skills ?? [], typed);
      if (known || !typed) return known ?? typed;
      try {
        const stored = await addSkill('hard', typed, family);
        queryClient.setQueryData<SkillLibraryList>(resumeKeys.skills('hard', family), (current) =>
          current && !librarySpelling(current.skills, stored) ? { ...current, skills: [...current.skills, stored] } : current,
        );
        return stored;
      } catch {
        // Kept as typed: the skill is the resume's either way, and the next add asks the library again.
        return typed;
      }
    },
    [data, queryClient, family],
  );

  return { listId, suggestions: <Suggestions id={listId} library={data} />, spell };
}

/**
 * A box to type a chip into, with Add: it stays for the next one, and says why one was not added. With `suggest`, a
 * technical skill: the library's skills are offered, and the skill goes in under the library's spelling.
 */
export function ChipAddForm({
  label,
  placeholder,
  suggest,
  onAdd,
}: {
  /** The box's name ("Skill", "Add a skill used in this role"). */
  label: string;
  placeholder: string;
  suggest: boolean;
  onAdd(text: string): keyof typeof CHIP_REFUSALS | null;
}) {
  const library = useSkillLibrary(suggest);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (busy) return;
    setBusy(true);
    const name = suggest ? await library.spell(text) : text;
    setBusy(false);
    const refusal = onAdd(name);
    setProblem(refusal ? CHIP_REFUSALS[refusal] : null);
    if (!refusal) setText('');
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            aria-label={label}
            placeholder={placeholder}
            list={suggest ? library.listId : undefined}
            value={text}
            maxLength={100}
            onChange={(event) => {
              setText(event.target.value);
              setProblem(null);
            }}
          />
          {suggest ? library.suggestions : null}
        </div>
        <Button type="submit" size="sm" disabled={!text.trim() || busy}>
          Add
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-[13px] text-danger">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
