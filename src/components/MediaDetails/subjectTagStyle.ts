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

export const subjectTagClassName = (index: number): string =>
  `compact-control subject-tag subject-tag-${subjectTagTones[index % subjectTagTones.length]}`;
