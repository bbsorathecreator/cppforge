/**
 * Генерация `switch` по перечислению и дополнение существующего `switch`
 * недостающими ветками `case`.
 *
 * @module
 */
import { EnumInfo, Enumerator } from '../parser/enumParser';
import { Token, TokenKind, tokenize, findMatching, renderTokens } from '../parser/tokenizer';

/** Настройки генерации `switch`. */
export interface SwitchOptions {
  /** Добавлять ли ветку `default`. */
  addDefault: boolean;
  /** Строка одного уровня отступа (например, 4 пробела или `\t`). */
  indentUnit: string;
  /** Как оформлять тело ветки: `break` или `return` (для функций-конвертеров). */
  bodyStyle: 'break' | 'todo-break' | 'return-name';
}

/** Настройки по умолчанию. */
export const DEFAULT_SWITCH_OPTIONS: SwitchOptions = {
  addDefault: true,
  indentUnit: '    ',
  bodyStyle: 'todo-break',
};

/**
 * Формирует метку `case` для элемента с учётом вида перечисления.
 * Для `enum class` нужна полная квалификация (`Color::Red`), для обычного
 * enum внутри класса — квалификация классом (`Unit::Idle`).
 *
 * @param info перечисление
 * @param e элемент
 * @param useQualified использовать полное имя (иначе — только имя enum)
 */
export function caseLabel(info: EnumInfo, e: Enumerator, useQualified = true): string {
  if (info.scoped) {
    return `${useQualified ? info.qualifiedName : info.name}::${e.name}`;
  }
  return useQualified && info.scopePrefix ? `${info.scopePrefix}::${e.name}` : e.name;
}

/**
 * Возвращает элементы, для которых нужно сгенерировать `case`: синонимы
 * (элементы с уже встречавшимся значением) исключаются, иначе код не скомпилируется
 * из-за повторяющихся меток.
 *
 * @param info перечисление
 */
export function uniqueEnumerators(info: EnumInfo): Enumerator[] {
  return info.enumerators.filter(e => e.aliasOf === undefined);
}

/** Тело одной ветки в зависимости от стиля. */
function caseBody(info: EnumInfo, e: Enumerator, opts: SwitchOptions): string[] {
  switch (opts.bodyStyle) {
    case 'break': return ['break;'];
    case 'return-name': return [`return "${e.name}";`];
    default: return [`// TODO: обработать ${caseLabel(info, e, false)}`, 'break;'];
  }
}

/**
 * Генерирует полный оператор `switch` по всем элементам перечисления.
 *
 * @param info перечисление
 * @param expression выражение в скобках `switch (...)`
 * @param baseIndent отступ строки, в которую вставляется код
 * @param opts настройки генерации
 * @returns текст оператора без начального отступа первой строки
 */
export function generateSwitch(
  info: EnumInfo, expression: string, baseIndent: string, opts: SwitchOptions = DEFAULT_SWITCH_OPTIONS,
): string {
  const ind1 = baseIndent + opts.indentUnit;
  const ind2 = ind1 + opts.indentUnit;
  const lines: string[] = [`switch (${expression}) {`];

  for (const e of uniqueEnumerators(info)) {
    const synonyms = info.enumerators.filter(x => x.aliasOf === e.name).map(x => x.name);
    const note = synonyms.length ? ` // синонимы: ${synonyms.join(', ')}` : '';
    lines.push(`${ind1}case ${caseLabel(info, e)}:${note}`);
    for (const b of caseBody(info, e, opts)) lines.push(ind2 + b);
  }

  if (opts.addDefault) {
    lines.push(`${ind1}default:`);
    lines.push(ind2 + (opts.bodyStyle === 'return-name' ? 'return "Unknown";' : 'break;'));
  }
  lines.push(`${baseIndent}}`);
  return lines.join('\n');
}

/**
 * Генерирует функцию преобразования значения перечисления в строку.
 *
 * @param info перечисление
 * @param baseIndent отступ для вставки
 * @param indentUnit один уровень отступа
 */
export function generateToString(info: EnumInfo, baseIndent: string, indentUnit = '    '): string {
  const body = generateSwitch(info, 'value', baseIndent + indentUnit, {
    addDefault: true, indentUnit, bodyStyle: 'return-name',
  });
  return [
    `inline const char* toString(${info.qualifiedName} value) {`,
    `${baseIndent}${indentUnit}${body}`,
    `${baseIndent}}`,
  ].join('\n');
}

/** Найденный в документе оператор `switch`. */
export interface SwitchBlock {
  /** Выражение в скобках. */
  expression: string;
  /** Имена (последний компонент) всех меток `case`. */
  labels: Set<string>;
  /** Смещение, куда вставлять новые ветки (перед `default:` или перед `}`). */
  insertOffset: number;
  /** Отступ меток `case` в этом switch. */
  caseIndent: string;
  /** Отступ тела ветки. */
  bodyIndent: string;
  /** Смещение `{` тела switch. */
  bodyOpenOffset: number;
  /** Тело switch пустое и записано в одну строку — перед вставкой нужен перевод строки. */
  leadingNewline: boolean;
  /** Отступ строки с ключевым словом `switch`. */
  switchIndent: string;
}

/**
 * Находит самый внутренний `switch`, тело которого содержит смещение `offset`,
 * и собирает множество уже обработанных меток.
 *
 * @param src исходный код
 * @param offset позиция курсора
 */
export function findSwitchAt(src: string, offset: number): SwitchBlock | undefined {
  const tokens = tokenize(src);
  let best: { open: number; close: number; sw: number } | undefined;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'switch' || tokens[i + 1]?.value !== '(') continue;
    const closeParen = findMatching(tokens, i + 1);
    if (closeParen === -1 || tokens[closeParen + 1]?.value !== '{') continue;
    const open = closeParen + 1;
    const close = findMatching(tokens, open);
    if (close === -1) continue;
    if (tokens[i].offset <= offset && offset <= tokens[close].end) {
      if (!best || i > best.sw) best = { open, close, sw: i };
    }
  }
  if (!best) return undefined;

  const labels = new Set<string>();
  let defaultTok: Token | undefined;
  let firstCase: Token | undefined;
  let depth = 0;
  for (let i = best.open + 1; i < best.close; i++) {
    const v = tokens[i].value;
    if (v === '{') depth++;
    if (v === '}') depth--;
    if (depth !== 0) continue; // метки вложенных switch не считаем
    if (v === 'switch') {
      // Пропускаем вложенный switch целиком.
      const p = findMatching(tokens, i + 1);
      if (p !== -1 && tokens[p + 1]?.value === '{') i = findMatching(tokens, p + 1);
      continue;
    }
    if (v === 'case') {
      firstCase ??= tokens[i];
      let j = i + 1;
      let last: Token | undefined;
      while (j < best.close && tokens[j].value !== ':') {
        if (tokens[j].kind === TokenKind.Identifier) last = tokens[j];
        j++;
      }
      if (last) labels.add(last.value);
      i = j;
    }
    if (v === 'default' && tokens[i + 1]?.value === ':') defaultTok = tokens[i];
  }

  const indentOf = (off: number): string => {
    const ls = src.lastIndexOf('\n', off - 1) + 1;
    return src.slice(ls, off).match(/^[ \t]*/)?.[0] ?? '';
  };
  const switchIndent = indentOf(tokens[best.sw].offset);
  const caseIndent = firstCase ? indentOf(firstCase.offset) : switchIndent + '    ';
  const unit = caseIndent.length > switchIndent.length ? caseIndent.slice(switchIndent.length) : '    ';

  // Вставляем перед `default:` (в начало его строки), иначе — перед закрывающей `}`.
  const anchor = defaultTok ?? tokens[best.close];
  let insertOffset = src.lastIndexOf('\n', anchor.offset - 1) + 1;
  const leadingNewline = insertOffset <= tokens[best.open].offset;
  if (leadingNewline) insertOffset = tokens[best.open].end;

  return {
    expression: renderTokens(tokens.slice(best.sw + 2, best.open - 1)),
    labels,
    insertOffset,
    caseIndent,
    bodyIndent: caseIndent + unit,
    bodyOpenOffset: tokens[best.open].offset,
    leadingNewline,
    switchIndent,
  };
}

/**
 * Выбирает перечисление, к которому относится switch: то, чьи элементы
 * покрывают наибольшее число существующих меток.
 *
 * @param block найденный switch
 * @param enums все перечисления документа
 * @returns лучшее совпадение или `undefined`, если ни одна метка не совпала
 */
export function matchEnumForSwitch(block: SwitchBlock, enums: EnumInfo[]): EnumInfo | undefined {
  let best: EnumInfo | undefined;
  let bestScore = 0;
  for (const e of enums) {
    const names = new Set(e.enumerators.map(x => x.name));
    let score = 0;
    block.labels.forEach(l => { if (names.has(l)) score++; });
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best;
}

/**
 * Генерирует текст недостающих веток `case` для существующего switch.
 * Элемент считается обработанным, если обработан он сам или любой его синоним.
 *
 * @param block найденный switch
 * @param info перечисление
 * @returns текст для вставки и список добавленных элементов
 */
export function generateMissingCases(block: SwitchBlock, info: EnumInfo): { text: string; added: string[] } {
  // Множество значений, уже покрытых метками (учитывает синонимы).
  const handledValues = new Set<number>();
  const handledNames = new Set<string>();
  for (const e of info.enumerators) {
    if (block.labels.has(e.name)) {
      handledNames.add(e.aliasOf ?? e.name);
      if (e.value !== undefined) handledValues.add(e.value);
    }
  }

  const missing = uniqueEnumerators(info).filter(e =>
    !handledNames.has(e.name) && (e.value === undefined || !handledValues.has(e.value)));

  const lines: string[] = [];
  for (const e of missing) {
    lines.push(`${block.caseIndent}case ${caseLabel(info, e)}:`);
    lines.push(`${block.bodyIndent}// TODO: обработать ${caseLabel(info, e, false)}`);
    lines.push(`${block.bodyIndent}break;`);
  }
  let text = lines.length ? lines.join('\n') + '\n' : '';
  if (text && block.leadingNewline) text = '\n' + text + block.switchIndent;
  return { text, added: missing.map(e => e.name) };
}
