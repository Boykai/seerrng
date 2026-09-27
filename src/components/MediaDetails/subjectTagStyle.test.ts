import { describe, expect, it } from 'vitest';
import { subjectTagClassName } from './subjectTagStyle';

describe('subject tag rainbow', () => {
  const rainbow = [
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
  ];

  it('follows the same rainbow order for three complete cycles', () => {
    for (let index = 0; index < rainbow.length * 3; index++) {
      expect(subjectTagClassName(index)).toBe(
        `compact-control subject-tag subject-tag-${rainbow[index % rainbow.length]}`
      );
    }
  });

  it('assigns the same colors on repeated renders', () => {
    const render = () =>
      Array.from({ length: 23 }, (_, index) => subjectTagClassName(index));
    expect(render()).toEqual(render());
  });
});
