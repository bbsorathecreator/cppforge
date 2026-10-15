/**
 * Поиск и разбор перечислений (`enum`, `enum class`) в исходном коде C++.
 * Помимо имён элементов вычисляет их числовые значения — это нужно, чтобы
 * не генерировать повторяющиеся `case` для элементов-синонимов.
 *
 * @module
 */
import { Token, TokenKind, tokenize, findMatching, renderTokens } from './tokenizer';
import { buildScopes, enclosingNames } from './scopes';

/** Элемент перечисления. */
export interface Enumerator {
  /** Имя элемента. */
  name: string;
  /** Текст инициализатора (`= ...`), если он есть. */
  initializer?: string;
  /** Вычисленное значение или `undefined`, если вычислить не удалось. */
  value?: number;
  /** Имя более раннего элемента с тем же значением (элемент — синоним). */
  aliasOf?: string;
}

/** Описание найденного перечисления. */
export interface EnumInfo {
  /** Собственное имя перечисления. */
  name: string;
  /** Полное имя с учётом namespace/класса, например `game::Unit::State`. */
  qualifiedName: string;
  /** Префикс области видимости без имени самого enum (`game::Unit`), может быть пустым. */
  scopePrefix: string;
  /** Перечисление объявлено внутри класса или структуры. */
  insideClass: boolean;
  /** `true` для `enum class` / `enum struct`. */
  scoped: boolean;
  /** Базовый тип (`std::uint8_t`), если указан. */
  underlyingType?: string;
  /** Элементы в порядке объявления. */
  enumerators: Enumerator[];
  /** Смещение ключевого слова `enum` в документе. */
  startOffset: number;
  /** Смещение после закрывающей `}`. */
  endOffset: number;
}

/**
 * Пытается вычислить значение инициализатора элемента перечисления.
 * Поддерживаются целые литералы (десятичные, `0x`, `0b`, восьмеричные),
 * ссылки на ранее объявленные элементы, унарный минус, `+ - * << | &` и скобки.
 *
 * @param tokens токены инициализатора
 * @param known уже вычисленные значения элементов
 * @returns значение или `undefined`, если выражение не поддерживается
 */
export function evaluateInitializer(tokens: Token[], known: Map<string, number>): number | undefined {
  let pos = 0;
  const peek = (): string | undefined => tokens[pos]?.value;

  // Рекурсивный спуск по приоритетам: | → & → << >> → + - → * → унарные → первичные.
  const levels: string[][] = [['|'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

  const readOp = (ops: string[]): string | undefined => {
    const a = peek();
    const b = tokens[pos + 1]?.value;
    if ((a === '<' && b === '<') || (a === '>' && b === '>')) {
      const op = a + b;
      if (ops.includes(op)) { pos += 2; return op; }
      return undefined;
    }
    if (a !== undefined && ops.includes(a)) { pos++; return a; }
    return undefined;
  };

  const apply = (op: string, x: number, y: number): number => {
    switch (op) {
      case '|': return x | y;
      case '&': return x & y;
      case '<<': return x << y;
      case '>>': return x >> y;
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': return Math.trunc(x / y);
      default: return x % y;
    }
  };

  const parseLevel = (level: number): number | undefined => {
    if (level === levels.length) return parseUnary();
    let left = parseLevel(level + 1);
    if (left === undefined) return undefined;
    for (let op = readOp(levels[level]); op; op = readOp(levels[level])) {
      const right = parseLevel(level + 1);
      if (right === undefined) return undefined;
      left = apply(op, left, right);
    }
    return left;
  };

  const parseUnary = (): number | undefined => {
    if (peek() === '-') { pos++; const v = parseUnary(); return v === undefined ? undefined : -v; }
    if (peek() === '+') { pos++; return parseUnary(); }
    if (peek() === '~') { pos++; const v = parseUnary(); return v === undefined ? undefined : ~v; }
    return parsePrimary();
  };

  const parsePrimary = (): number | undefined => {
    const t = tokens[pos];
    if (!t) return undefined;
    if (t.value === '(') {
      pos++;
      const v = parseLevel(0);
      if (peek() !== ')') return undefined;
      pos++;
      return v;
    }
    if (t.kind === TokenKind.Number) { pos++; return parseIntLiteral(t.value); }
    if (t.kind === TokenKind.Char) { pos++; return t.value.length === 3 ? t.value.charCodeAt(1) : undefined; }
    if (t.kind === TokenKind.Identifier) {
      // Допускаем квалификацию `Color::Red` — берём последнее имя.
      let name = t.value;
      pos++;
      while (peek() === '::' && tokens[pos + 1]?.kind === TokenKind.Identifier) {
        name = tokens[pos + 1].value;
        pos += 2;
      }
      return known.get(name);
    }
    return undefined;
  };

  const result = parseLevel(0);
  return pos === tokens.length ? result : undefined;
}

/**
 * Разбирает целочисленный литерал C++ (с разделителями `'` и суффиксами `u`, `l`).
 *
 * @param literal текст литерала
 */
export function parseIntLiteral(literal: string): number | undefined {
  const s = literal.replace(/'/g, '').replace(/[uUlL]+$/, '');
  let v: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) v = parseInt(s.slice(2), 16);
  else if (/^0[bB][01]+$/.test(s)) v = parseInt(s.slice(2), 2);
  else if (/^0[0-7]+$/.test(s)) v = parseInt(s.slice(1), 8);
  else if (/^[0-9]+$/.test(s)) v = parseInt(s, 10);
  else return undefined;
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Разбирает тело перечисления между `{` и `}`: делит его на элементы по
 * запятым верхнего уровня, вычисляет значения и отмечает синонимы.
 */
function parseEnumBody(tokens: Token[], open: number, close: number): Enumerator[] {
  const result: Enumerator[] = [];
  const values = new Map<string, number>();     // имя → значение
  const firstByValue = new Map<number, string>(); // значение → первый элемент с ним
  let next: number | undefined = 0;              // значение «по умолчанию» для следующего элемента

  let i = open + 1;
  while (i < close) {
    // Собираем токены одного элемента до запятой верхнего уровня.
    const part: Token[] = [];
    let depth = 0;
    while (i < close) {
      const v = tokens[i].value;
      if (v === '(' || v === '[' || v === '{') depth++;
      if (v === ')' || v === ']' || v === '}') depth--;
      if (v === ',' && depth === 0) break;
      part.push(tokens[i]);
      i++;
    }
    i++; // пропускаем запятую
    if (part.length === 0 || part[0].kind !== TokenKind.Identifier) continue;

    const e: Enumerator = { name: part[0].value };
    const eq = part.findIndex(t => t.value === '=');
    if (eq !== -1) {
      const init = part.slice(eq + 1);
      e.initializer = renderTokens(init);
      e.value = evaluateInitializer(init, values);
    } else {
      e.value = next;
    }
    next = e.value === undefined ? undefined : e.value + 1;

    if (e.value !== undefined) {
      values.set(e.name, e.value);
      const first = firstByValue.get(e.value);
      if (first !== undefined) e.aliasOf = first;
      else firstByValue.set(e.value, e.name);
    }
    result.push(e);
  }
  return result;
}

/**
 * Находит все перечисления в исходном тексте.
 *
 * @param src исходный код C++
 * @returns список перечислений в порядке появления
 */
export function findEnums(src: string): EnumInfo[] {
  const tokens = tokenize(src);
  const scopes = buildScopes(tokens);
  const enums: EnumInfo[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'enum') continue;
    let k = i + 1;
    let scoped = false;
    if (tokens[k]?.value === 'class' || tokens[k]?.value === 'struct') { scoped = true; k++; }
    if (tokens[k]?.kind !== TokenKind.Identifier) continue; // безымянный enum — пропускаем
    const name = tokens[k].value;
    k++;

    let underlyingType: string | undefined;
    if (tokens[k]?.value === ':') {
      const start = ++k;
      while (k < tokens.length && tokens[k].value !== '{' && tokens[k].value !== ';') k++;
      underlyingType = renderTokens(tokens.slice(start, k));
    }
    if (tokens[k]?.value !== '{') continue; // предварительное объявление
    const close = findMatching(tokens, k);
    if (close === -1) continue;

    const scopePrefix = enclosingNames(scopes, i).join('::');
    const enclosing = scopes.filter(s => s.open < i && i < s.close && s.kind !== 'block');
    const inner = enclosing[enclosing.length - 1];
    const insideClass = !!inner && (inner.kind === 'class' || inner.kind === 'struct' || inner.kind === 'union');
    enums.push({
      name,
      qualifiedName: scopePrefix ? `${scopePrefix}::${name}` : name,
      scopePrefix,
      insideClass,
      scoped,
      underlyingType,
      enumerators: parseEnumBody(tokens, k, close),
      startOffset: tokens[i].offset,
      endOffset: tokens[close].end,
    });
    i = close;
  }
  return enums;
}

/**
 * Строит индекс перечислений по имени: и по короткому, и по полному.
 * Короткие имена, встречающиеся несколько раз, указывают на список вариантов.
 *
 * @param enums найденные перечисления
 */
export function indexEnums(enums: EnumInfo[]): Map<string, EnumInfo[]> {
  const index = new Map<string, EnumInfo[]>();
  const add = (key: string, e: EnumInfo): void => {
    const list = index.get(key) ?? [];
    if (!list.includes(e)) list.push(e);
    index.set(key, list);
  };
  for (const e of enums) {
    add(e.name, e);
    add(e.qualifiedName, e);
  }
  return index;
}
