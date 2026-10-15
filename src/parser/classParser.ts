/**
 * Разбор классов и структур C++: извлечение нестатических полей данных
 * (тип, имя, модификаторы), пропуская методы, вложенные типы и т.п.
 *
 * @module
 */
import { Token, TokenKind, tokenize, findMatching, renderTokens } from './tokenizer';
import { buildScopes, innermostScopeAt, Scope } from './scopes';

/** Поле класса. */
export interface Field {
  /** Имя поля как в исходнике (`m_name`). */
  name: string;
  /** Тип поля без `static`/`mutable` (`std::vector<int>`). */
  type: string;
  /** Поле объявлено как `const T`. */
  isConst: boolean;
  /** Поле — ссылка (`T&`). */
  isReference: boolean;
  /** Поле — встроенный массив (`int a[10]`). */
  isArray: boolean;
  /** Модификатор доступа, под которым объявлено поле. */
  access: 'public' | 'private' | 'protected';
}

/** Описание класса или структуры. */
export interface ClassInfo {
  kind: 'class' | 'struct';
  name: string;
  fields: Field[];
  /** Имена методов, уже объявленных в классе (чтобы не генерировать дубликаты). */
  existingMethods: Set<string>;
  /** Смещение, куда вставлять сгенерированный код (начало строки с закрывающей `}`). */
  insertOffset: number;
  /** Отступ, которым отформатированы члены класса. */
  memberIndent: string;
}

/** Ключевые слова, после которых объявление не является полем данных. */
const NON_FIELD_STARTERS = new Set([
  'using', 'typedef', 'friend', 'static_assert', 'template', 'enum',
  'class', 'struct', 'union', 'public', 'private', 'protected', 'operator',
]);

/** Спецификаторы, которые не входят в тип поля. */
const DROPPED_SPECIFIERS = new Set(['mutable', 'inline', 'constexpr', 'volatile']);

/**
 * Делит одно объявление `int a = 1, *b, c[3];` на тип-основу и деклараторы.
 * Возвращает поля либо пустой массив, если это не объявление поля.
 */
function parseDeclaration(decl: Token[], access: Field['access']): Field[] {
  if (decl.length < 2) return [];
  if (NON_FIELD_STARTERS.has(decl[0].value)) return [];
  if (decl.some(t => t.value === 'static')) return [];

  // Если на верхнем уровне (вне <>) есть `(` — это метод или указатель на функцию.
  let angle = 0;
  for (const t of decl) {
    if (t.value === '<') angle++;
    else if (t.value === '>') angle--;
    else if (t.value === '(' && angle === 0) return [];
    else if (t.value === '=' && angle === 0) break;
  }

  // Разрезаем по запятым верхнего уровня.
  const parts: Token[][] = [[]];
  angle = 0;
  let depth = 0;
  for (const t of decl) {
    if (t.value === '<') angle++;
    if (t.value === '>') angle--;
    if (t.value === '{' || t.value === '(' || t.value === '[') depth++;
    if (t.value === '}' || t.value === ')' || t.value === ']') depth--;
    if (t.value === ',' && angle === 0 && depth === 0) { parts.push([]); continue; }
    parts[parts.length - 1].push(t);
  }

  const fields: Field[] = [];
  let baseType: Token[] | null = null;

  for (const part of parts) {
    // Отрезаем инициализатор: `= ...` или `{...}`.
    let cut = part.findIndex((t, idx) => t.value === '=' || (t.value === '{' && idx > 0));
    if (cut === -1) cut = part.length;
    let declarator = part.slice(0, cut);

    // Массив: имя стоит перед `[`.
    const bracket = declarator.findIndex(t => t.value === '[');
    const isArray = bracket !== -1;
    if (isArray) declarator = declarator.slice(0, bracket);

    // Битовое поле `unsigned x : 3`.
    const colon = declarator.findIndex(t => t.value === ':');
    if (colon !== -1) declarator = declarator.slice(0, colon);

    const nameTok = declarator[declarator.length - 1];
    if (!nameTok || nameTok.kind !== TokenKind.Identifier) return [];

    let typeTokens: Token[];
    if (baseType === null) {
      // Первый декларатор задаёт тип-основу (без * и & — они относятся к имени).
      const before = declarator.slice(0, -1);
      let end = before.length;
      while (end > 0 && (before[end - 1].value === '*' || before[end - 1].value === '&')) end--;
      baseType = before.slice(0, end).filter(t => !DROPPED_SPECIFIERS.has(t.value));
      if (baseType.length === 0) return [];
      typeTokens = [...baseType, ...before.slice(end)];
    } else {
      typeTokens = [...baseType, ...declarator.slice(0, -1)];
    }

    const isConstPointerOnly = typeTokens.some(t => t.value === '*')
      && typeTokens[typeTokens.length - 1]?.value !== 'const';
    fields.push({
      name: nameTok.value,
      type: renderTokens(typeTokens),
      isConst: typeTokens.some(t => t.value === 'const') && !isConstPointerOnly,
      isReference: typeTokens.some(t => t.value === '&'),
      isArray,
      access,
    });
  }
  return fields;
}

/**
 * Разбирает тело класса, начинающееся с токена `{` по индексу `open`.
 */
function parseClassBody(tokens: Token[], scope: Scope, src: string): ClassInfo {
  const kind = scope.kind === 'struct' ? 'struct' : 'class';
  let access: Field['access'] = kind === 'struct' ? 'public' : 'private';
  const fields: Field[] = [];
  const existingMethods = new Set<string>();

  let i = scope.open + 1;
  let current: Token[] = [];
  while (i < scope.close) {
    const t = tokens[i];

    // Модификатор доступа.
    if (['public', 'private', 'protected'].includes(t.value) && tokens[i + 1]?.value === ':') {
      access = t.value as Field['access'];
      current = [];
      i += 2;
      continue;
    }

    if (t.value === '{') {
      // Тело метода, вложенного типа или brace-инициализатор поля.
      const close = findMatching(tokens, i);
      const isInitializer = current.length > 0 && !current.some(x => x.value === '(')
        && !['class', 'struct', 'union', 'enum'].includes(current[0]?.value);
      if (isInitializer) {
        current.push(...tokens.slice(i, close + 1));
        i = close + 1;
        continue;
      }
      recordMethod(current, existingMethods);
      current = [];
      i = close + 1;
      // После тела вложенного типа может стоять `;`, после метода — нет.
      if (tokens[i]?.value === ';') i++;
      continue;
    }

    if (t.value === ';') {
      recordMethod(current, existingMethods);
      fields.push(...parseDeclaration(current, access));
      current = [];
      i++;
      continue;
    }

    current.push(t);
    i++;
  }

  // Отступ членов класса: берём отступ строки с закрывающей скобкой и добавляем 4 пробела.
  const closeOffset = tokens[scope.close].offset;
  const lineStart = src.lastIndexOf('\n', closeOffset - 1) + 1;
  const braceIndent = src.slice(lineStart, closeOffset).match(/^[ \t]*/)?.[0] ?? '';

  return {
    kind,
    name: scope.name ?? '',
    fields,
    existingMethods,
    insertOffset: src.slice(lineStart, closeOffset).trim() === '' ? lineStart : closeOffset,
    memberIndent: braceIndent + '    ',
  };
}

/** Если объявление похоже на метод — запоминает его имя. */
function recordMethod(decl: Token[], methods: Set<string>): void {
  const paren = decl.findIndex(t => t.value === '(');
  if (paren <= 0) return;
  const nameTok = decl[paren - 1];
  if (nameTok.kind === TokenKind.Identifier) {
    // Для операторов имя — `operator==`, `operator<<`.
    const opIdx = decl.findIndex(t => t.value === 'operator');
    if (opIdx !== -1) {
      methods.add('operator' + decl.slice(opIdx + 1, paren).map(t => t.value).join(''));
    } else {
      methods.add(nameTok.value);
    }
  } else {
    const opIdx = decl.findIndex(t => t.value === 'operator');
    if (opIdx !== -1) methods.add('operator' + decl.slice(opIdx + 1, paren).map(t => t.value).join(''));
  }
}

/**
 * Находит самый внутренний класс/структуру, внутри которого находится курсор,
 * и разбирает его.
 *
 * @param src исходный код
 * @param offset смещение курсора
 * @returns описание класса или `undefined`, если курсор не внутри класса
 */
export function findClassAt(src: string, offset: number): ClassInfo | undefined {
  const tokens = tokenize(src);
  const scopes = buildScopes(tokens);
  const scope = innermostScopeAt(scopes, tokens, offset, ['class', 'struct']);
  if (!scope || !scope.name) return undefined;
  return parseClassBody(tokens, scope, src);
}
