/**
 * Упрощённый лексер C++. Превращает исходный текст в массив токенов,
 * пропуская пробелы, комментарии и директивы препроцессора.
 * Этого достаточно, чтобы надёжно находить перечисления, классы и switch-блоки.
 *
 * @module
 */

/** Вид токена. */
export enum TokenKind {
  Identifier = 'identifier',
  Number = 'number',
  String = 'string',
  Char = 'char',
  Punct = 'punct',
}

/** Один токен исходного текста. */
export interface Token {
  /** Вид токена. */
  kind: TokenKind;
  /** Текст токена ровно так, как он записан в исходнике. */
  value: string;
  /** Смещение первого символа токена от начала документа. */
  offset: number;
  /** Смещение символа, следующего за токеном. */
  end: number;
}

/** Многосимвольные операторы, важные для разбора (остальные режутся по одному символу). */
const MULTI_CHAR_PUNCT = ['::', '->'];

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => /[0-9]/.test(c);

/**
 * Разбивает исходный код C++ на токены.
 *
 * Пропускает однострочные и многострочные комментарии, строки препроцессора
 * (`#include`, `#define` с переносами через `\`) и пробельные символы.
 *
 * @param src исходный текст документа
 * @returns массив токенов в порядке следования
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let lineStart = true; // в начале ли строки (нужно для директив препроцессора)

  while (i < src.length) {
    const c = src[i];

    if (c === '\n') { lineStart = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    // Директива препроцессора — пропускаем до конца логической строки.
    if (c === '#' && lineStart) {
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\' && src[i + 1] === '\n') i++;
        i++;
      }
      continue;
    }
    lineStart = false;

    // Комментарии.
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }

    const start = i;

    if (isIdentStart(c)) {
      while (i < src.length && isIdentPart(src[i])) i++;
      tokens.push({ kind: TokenKind.Identifier, value: src.slice(start, i), offset: start, end: i });
      continue;
    }

    if (isDigit(c)) {
      // Числа: десятичные, шестнадцатеричные, с суффиксами и разделителем '.
      while (i < src.length && /[0-9A-Za-z_.']/.test(src[i])) i++;
      tokens.push({ kind: TokenKind.Number, value: src.slice(start, i), offset: start, end: i });
      continue;
    }

    if (c === '"' || c === '\'') {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      tokens.push({
        kind: c === '"' ? TokenKind.String : TokenKind.Char,
        value: src.slice(start, i), offset: start, end: i,
      });
      continue;
    }

    const multi = MULTI_CHAR_PUNCT.find(p => src.startsWith(p, i));
    const value = multi ?? c;
    i += value.length;
    tokens.push({ kind: TokenKind.Punct, value, offset: start, end: i });
  }
  return tokens;
}

/**
 * Находит индекс парной закрывающей скобки, учитывая вложенность.
 *
 * @param tokens массив токенов
 * @param openIndex индекс открывающей скобки (`{`, `(` или `[`)
 * @returns индекс парной закрывающей скобки или -1, если её нет
 */
export function findMatching(tokens: Token[], openIndex: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const open = tokens[openIndex].value;
  const close = pairs[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i].value === open) depth++;
    else if (tokens[i].value === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Склеивает токены типа или выражения в читаемую строку:
 * `std :: map < int , std :: string >` → `std::map<int, std::string>`.
 *
 * @param tokens токены, составляющие тип или выражение
 * @returns отформатированная строка
 */
export function renderTokens(tokens: Token[]): string {
  let out = '';
  for (let k = 0; k < tokens.length; k++) {
    const v = tokens[k].value;
    const prev = k > 0 ? tokens[k - 1].value : '';
    const glueLeft = k === 0
      || ['::', '<', '>', ',', '*', '&', ')', ']', '[', '('].includes(v)
      || ['::', '<', '(', '[', '-', '~', '!'].includes(prev);
    out += (glueLeft ? '' : ' ') + v;
    if (v === ',') out += ' ';
  }
  return out.replace(/ {2,}/g, ' ').trim();
}
