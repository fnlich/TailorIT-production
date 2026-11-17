// @jsxRuntime automatic
// @jsxImportSource react
import { Fragment } from 'react';
import type { SectionView, SkillGroupView, TextView } from '../../model/view';
import { useSlots } from '../../slots';
import { blockOptions, cx, type BlockLook, type BlockOptions } from './options';

// Skills and the other lists of words. A skill group prints its name (when the section shows group names), then its
// skills as tags, as one comma-separated line, or as bullets; soft skills and interests print the same way, as tags
// until the person picks another layout. The commas (and the colon after a group name that starts its line) are the
// template's, between the fields, so each skill stays one field to edit.

export function Tags({ items, border }: { items: readonly TextView[]; border: BlockOptions['tagBorder'] }) {
  const { Text } = useSlots();
  return (
    <ul className={cx('rt-tags', border === 'box' && 'rt-tags-box')}>
      {items.map((item) => (
        <li key={item.path} className="rt-tag">
          <Text field={item} />
        </li>
      ))}
    </ul>
  );
}

/** One line of words with commas between them, after the group's name when it starts the line. */
function CommaList({ items, name }: { items: readonly TextView[]; name?: TextView | null }) {
  const { Text } = useSlots();
  return (
    <p className="rt-skill-list">
      {name ? <Text field={name} className="rt-group-name" /> : null}
      {name ? <span className="rt-group-sep">: </span> : null}
      {items.map((item, index) => (
        <Fragment key={item.path}>
          {index > 0 ? ', ' : null}
          <Text field={item} />
        </Fragment>
      ))}
    </p>
  );
}

function SkillList({ skills, options }: { skills: readonly TextView[]; options: BlockOptions }) {
  const { Text } = useSlots();
  if (options.skillsLayout === 'list') return <CommaList items={skills} />;
  if (options.skillsLayout === 'bullets') {
    return (
      <ul className={cx('rt-bullets', !options.showBulletMarker && 'rt-bullets-plain')}>
        {skills.map((skill) => (
          <li key={skill.path} className="rt-bullet">
            <Text field={skill} />
          </li>
        ))}
      </ul>
    );
  }
  return <Tags items={skills} border={options.tagBorder} />;
}

export function SkillGroup({ section, group, look }: { section: SectionView; group: SkillGroupView; look: BlockLook }) {
  const { Text } = useSlots();
  const options = blockOptions(section, look);
  if (look.inlineGroupNames && options.skillsLayout === 'list') {
    return (
      <div className="rt-skills">
        <CommaList items={group.skills} name={group.name} />
      </div>
    );
  }
  return (
    <div className="rt-skills">
      {group.name ? <Text field={group.name} as="h3" className="rt-group-name" /> : null}
      {group.skills.length > 0 ? <SkillList skills={group.skills} options={options} /> : null}
    </div>
  );
}

/** Soft skills and interests. */
export function Chips({ section, look }: { section: SectionView; look: BlockLook }) {
  if (section.body.type !== 'chips') return null;
  return (
    <div className="rt-chips">
      <SkillList skills={section.body.chips} options={blockOptions(section, look)} />
    </div>
  );
}
