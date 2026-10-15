/**
 * Анализ областей видимости: определяет, какие фигурные скобки открывают
 * пространство имён или класс, чтобы строить полные имена (`ns::Outer::Color`).
 *
 * @module
 */
import { Token, TokenKind } from './tokenizer';

/** Вид блока, открытого фигурной скобкой. */
export type ScopeKind = 'namespace' | 'class' | 'struct' | 'union' | 'enum' | 'block';

/** Блок `{ ... }` с информацией о том, что он открывает. */
export interface Scope {
  kind: ScopeKind;
  /** Имя пространства имён/класса; `null` для безымянных и обычных блоков. */
  name: string | null;
  /** Индекс токена `{`. */
  open: number;
  /** Индекс парного токена `}` (или последний токен, если скобка не закрыта). */
  close: number;
}

const NAMED_KEYWORDS = new Set(['namespace', 'class', 'struct', 'union', 'enum']);

/**
 * Определяет, что открывает фигурная скобка с индексом `braceIndex`:
 * просматривает токены назад до ближайшего `;`, `{` или `}`.
 */
function classifyBrace(tokens: Token[], braceIndex: number): { kind: ScopeKind; name: string | null } {
  let j = braceIndex - 1;
  let angle = 0;
  const head: Token[] = [];
  while (j >= 0) {
    const v = tokens[j].value;
    if (v === '>') angle++;
    else if (v === '<') angle--;
    if (angle === 0 && (v === ';' || v === '{' || v === '}' || v === ')')) break;
    head.unshift(tokens[j]);
    j--;
  }
  // Если перед `{` стоит `)`, это тело функции/цикла/условия — обычный блок.
  if (j >= 0 && tokens[j].value === ')') return { kind: 'block', name: null };

  const kwIndex = head.findIndex(t => NAMED_KEYWORDS.has(t.value));
  if (kwIndex === -1) return { kind: 'block', name: null };
  let kind = head[kwIndex].value as ScopeKind;
  let k = kwIndex + 1;
  if (kind === 'enum' && head[k] && (head[k].value === 'class' || head[k].value === 'struct')) k++;
  // Пропускаем атрибуты вида [[nodiscard]] и alignas(...)
  while (head[k] && (head[k].value === '[' || head[k].value === ']')) k++;
  let name: string | null = null;
  if (head[k] && head[k].kind === TokenKind.Identifier && head[k].value !== 'final') {
    name = head[k].value;
    // Вложенное определение `namespace a::b {`
    while (head[k + 1]?.value === '::' && head[k + 2]?.kind === TokenKind.Identifier) {
      name += '::' + head[k + 2].value;
      k += 2;
    }
  }
  return { kind, name };
}

/**
 * Строит список всех блоков `{...}` документа с помощью стека открытых скобок.
 *
 * @param tokens токены документа
 * @returns блоки в порядке появления открывающей скобки
 */
export function buildScopes(tokens: Token[]): Scope[] {
  const result: Scope[] = [];
  const stack: Scope[] = [];
  tokens.forEach((t, i) => {
    if (t.value === '{') {
      const { kind, name } = classifyBrace(tokens, i);
      const scope: Scope = { kind, name, open: i, close: tokens.length - 1 };
      stack.push(scope);
      result.push(scope);
    } else if (t.value === '}') {
      const scope = stack.pop();
      if (scope) scope.close = i;
    }
  });
  return result;
}

/**
 * Возвращает цепочку именованных областей (namespace/class/struct), внутри
 * которых находится токен, — от внешней к внутренней.
 *
 * @param scopes результат {@link buildScopes}
 * @param tokenIndex индекс интересующего токена
 */
export function enclosingNames(scopes: Scope[], tokenIndex: number): string[] {
  return scopes
    .filter(s => s.open < tokenIndex && tokenIndex < s.close && s.name !== null && s.kind !== 'enum')
    .map(s => s.name as string);
}

/**
 * Находит самый внутренний блок заданных видов, содержащий смещение `offset`.
 *
 * @param scopes все блоки документа
 * @param tokens токены документа
 * @param offset смещение (например, позиция курсора)
 * @param kinds допустимые виды блоков
 */
export function innermostScopeAt(
  scopes: Scope[], tokens: Token[], offset: number, kinds: ScopeKind[],
): Scope | undefined {
  let best: Scope | undefined;
  for (const s of scopes) {
    if (!kinds.includes(s.kind)) continue;
    if (tokens[s.open].offset < offset && offset <= tokens[s.close].end) {
      if (!best || s.open > best.open) best = s;
    }
  }
  return best;
}
