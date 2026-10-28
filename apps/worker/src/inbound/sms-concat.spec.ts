import { describe, expect, it } from 'vitest';
import { assembleParts, looksLikeIncompletePart, repairGluedParts } from './sms-concat';

// Real Vodafone UA messages as a GoIP delivered them.
const GLUED =
  'На вашому рахунку не вистачило коштів для підключення пакета на 1 м//go.vodafone.ua/Home' +
  'ісяць. Щоб підключити пакет на 1 місяць, поповніть рахунок, щоб було 330 грн. Або ' +
  'користуйтесь пакетами на день: дзвінки - 15 грн за безліміт у мережі Vodafone по Україні ' +
  '(в разі користування). Використати залишки ГБ та хвилин в межах послуги "Доступний роумінг" ' +
  'можна після підключення пакета на 1 місяць. Деталі у My Vodafone: https:';

const P1 = "Заберете ваші 300 грн на зв'язок? Вони нам не заважають, але місце ";
const P2 = 'займають :) Просто відправте безкоштовне SMS на номер 3133 - і ви о';
const P3 = 'дразу отримаєте свій подарунок.';

describe('repairGluedParts', () => {
  it('moves a final part glued into the middle back to the end', () => {
    const fixed = repairGluedParts(GLUED);
    expect(fixed.startsWith('На вашому рахунку не вистачило коштів для підключення пакета на 1 місяць.')).toBe(true);
    expect(fixed.endsWith('Деталі у My Vodafone: https://go.vodafone.ua/Home')).toBe(true);
    expect(fixed.length).toBe(GLUED.length);
  });

  it('leaves correctly ordered text alone', () => {
    const correct = repairGluedParts(GLUED);
    expect(repairGluedParts(correct)).toBe(correct);
    expect(repairGluedParts(P1 + P2 + P3)).toBe(P1 + P2 + P3);
    expect(repairGluedParts('Короткий текст')).toBe('Короткий текст');
  });
});

describe('looksLikeIncompletePart', () => {
  it('flags full UCS-2 and GSM-7 segments only', () => {
    expect(looksLikeIncompletePart(P1)).toBe(true);
    expect(looksLikeIncompletePart(P2)).toBe(true);
    expect(looksLikeIncompletePart(P3)).toBe(false);
    expect(looksLikeIncompletePart('a'.repeat(153))).toBe(true);
    expect(looksLikeIncompletePart('a'.repeat(152) + '€')).toBe(false); // 154 septets
    expect(looksLikeIncompletePart('a'.repeat(67))).toBe(false);
  });
});

describe('assembleParts', () => {
  it('puts the short final part last whatever order the parts came in', () => {
    const arrived = [P1, P3, P2].map((text) => ({ text }));
    const { combined, leftovers } = assembleParts(arrived);
    expect(combined.map((p) => p.text).join('')).toBe(P1 + P2 + P3);
    expect(leftovers).toEqual([]);
  });
});
