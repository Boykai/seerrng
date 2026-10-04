const subjectTagTones = [
  'rose',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'cyan',
  'sky',
  'indigo',
  'violet',
  'purple',
] as const;

export const subjectTagTone = (index: number) =>
  subjectTagTones[index % subjectTagTones.length];

export const subjectTagClassName = (index: number): string =>
  `compact-control subject-tag subject-tag-${subjectTagTone(index)}`;
