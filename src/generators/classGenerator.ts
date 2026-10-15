/**
 * Генерация членов класса по его полям: конструктор, геттеры, сеттеры,
 * операторы `==`/`!=` и `operator<<` для вывода в поток.
 *
 * @module
 */
import { ClassInfo, Field } from '../parser/classParser';

/** Что именно генерировать. */
export type MemberKind = 'constructor' | 'getters' | 'setters' | 'equality' | 'ostream';

/** Настройки генерации. */
export interface ClassGenOptions {
  /** Набор генерируемых членов. */
  kinds: Set<MemberKind>;
  /** Стиль имён геттеров: `getName()` или `name()`. */
  getterStyle: 'get' | 'plain';
  /** Один уровень отступа. */
  indentUnit: string;
}

/**
 * Типы, которые выгоднее передавать по значению, а не по `const&`.
 * Используется множество для поиска за O(1).
 */
const CHEAP_TYPES = new Set([
  'bool', 'char', 'signed char', 'unsigned char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t',
  'short', 'unsigned short', 'int', 'unsigned', 'unsigned int', 'long', 'unsigned long',
  'long long', 'unsigned long long', 'float', 'double', 'long double',
  'size_t', 'std::size_t', 'ptrdiff_t', 'std::ptrdiff_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'std::int8_t', 'std::int16_t', 'std::int32_t', 'std::int64_t',
  'std::uint8_t', 'std::uint16_t', 'std::uint32_t', 'std::uint64_t',
]);

/** Как выводить поле в поток в `operator<<`. */
export type StreamStrategy = 'direct' | 'size' | 'skip';

/**
 * Стратегия вывода для шаблонов стандартной библиотеки, у которых нет `operator<<`:
 * контейнеры выводятся количеством элементов, остальные — пропускаются.
 */
const STREAM_STRATEGY_BY_TEMPLATE = new Map<string, StreamStrategy>([
  ...['vector', 'list', 'deque', 'set', 'multiset', 'map', 'multimap', 'unordered_set',
    'unordered_map', 'unordered_multiset', 'unordered_multimap', 'array', 'forward_list']
    .map(n => [`std::${n}`, 'size'] as [string, StreamStrategy]),
  ...['function', 'unique_ptr', 'optional', 'variant', 'pair', 'tuple', 'queue', 'stack',
    'priority_queue', 'atomic', 'mutex']
    .map(n => [`std::${n}`, 'skip'] as [string, StreamStrategy]),
]);

/**
 * Определяет, как вывести поле в поток.
 *
 * @param type тип поля
 */
export function streamStrategy(type: string): StreamStrategy {
  const t = type.replace(/^const\s+/, '');
  const lt = t.indexOf('<');
  const templ = lt === -1 ? t : t.slice(0, lt);
  return STREAM_STRATEGY_BY_TEMPLATE.get(templ) ?? 'direct';
}

/** Префиксы и суффиксы, которыми обычно помечают поля класса. */
const MEMBER_PREFIXES = ['m_', '_'];

/**
 * Убирает «служебные» префиксы/суффиксы из имени поля:
 * `m_name` → `name`, `_size` → `size`, `count_` → `count`.
 *
 * @param fieldName имя поля
 */
export function baseName(fieldName: string): string {
  let n = fieldName;
  for (const p of MEMBER_PREFIXES) {
    if (n.startsWith(p) && n.length > p.length) { n = n.slice(p.length); break; }
  }
  if (n.endsWith('_') && n.length > 1) n = n.slice(0, -1);
  return n;
}

/** Делает первую букву заглавной. */
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Определяет, передавать ли тип по значению: встроенные числовые типы,
 * указатели и ссылки — по значению, остальное — по константной ссылке.
 *
 * @param type тип без `const`
 */
export function isCheapType(type: string): boolean {
  return CHEAP_TYPES.has(type) || type.endsWith('*') || type.endsWith('&');
}

/** Тип без ведущего `const` (для параметров и возвращаемых значений). */
const stripConst = (type: string): string => type.replace(/^const\s+/, '');

/**
 * Тип параметра для передачи значения поля: `int` или `const std::string&`.
 *
 * @param f поле
 */
export function paramType(f: Field): string {
  const t = stripConst(f.type);
  return isCheapType(t) ? t : `const ${t}&`;
}

/**
 * Имя геттера для поля в выбранном стиле.
 * Для логических полей в стиле `get` используется `isXxx()`.
 */
export function getterName(f: Field, style: ClassGenOptions['getterStyle']): string {
  const b = baseName(f.name);
  if (style === 'plain') return b === f.name ? `get${capitalize(b)}` : b;
  return (stripConst(f.type) === 'bool' ? 'is' : 'get') + capitalize(b);
}

/** Имя сеттера для поля. */
export function setterName(f: Field): string {
  return 'set' + capitalize(baseName(f.name));
}

/** Результат генерации. */
export interface ClassGenResult {
  /** Текст для вставки перед закрывающей скобкой класса. */
  text: string;
  /** Пропущенные элементы с причиной (для показа пользователю). */
  skipped: string[];
}

/**
 * Генерирует выбранные члены класса.
 *
 * Правила:
 * - массивы пропускаются для геттеров/сеттеров (их нельзя вернуть по значению);
 * - константные поля и ссылки не получают сеттеров;
 * - уже существующие методы не дублируются;
 * - для `class` перед блоком добавляется `public:`.
 *
 * @param cls разобранный класс
 * @param opts настройки
 */
export function generateClassMembers(cls: ClassInfo, opts: ClassGenOptions): ClassGenResult {
  const ind = cls.memberIndent;
  const ind2 = ind + opts.indentUnit;
  const out: string[] = [];
  const skipped: string[] = [];
  const fields = cls.fields;
  const has = (name: string): boolean => cls.existingMethods.has(name);

  if (fields.length === 0) {
    return { text: '', skipped: ['в классе нет нестатических полей'] };
  }

  // Конструктор со списком инициализации.
  if (opts.kinds.has('constructor')) {
    const params = fields.filter(f => !f.isArray);
    if (params.length) {
      const sig = params.map(f => `${paramType(f)} ${baseName(f.name)}`).join(', ');
      const explicit = params.length === 1 ? 'explicit ' : '';
      out.push(`${ind}${explicit}${cls.name}(${sig})`);
      params.forEach((f, idx) => {
        const lead = idx === 0 ? ': ' : ', ';
        out.push(`${ind2}${lead}${f.name}(${baseName(f.name)})`);
      });
      out.push(`${ind}{}`, '');
    }
  }

  // Геттеры.
  if (opts.kinds.has('getters')) {
    for (const f of fields) {
      const name = getterName(f, opts.getterStyle);
      if (f.isArray) { skipped.push(`геттер для массива ${f.name}`); continue; }
      if (has(name)) { skipped.push(`${name}() уже существует`); continue; }
      out.push(`${ind}${paramType(f)} ${name}() const { return ${f.name}; }`);
    }
    out.push('');
  }

  // Сеттеры.
  if (opts.kinds.has('setters')) {
    for (const f of fields) {
      const name = setterName(f);
      if (f.isArray || f.isConst || f.isReference) {
        skipped.push(`сеттер для ${f.name} (${f.isArray ? 'массив' : f.isConst ? 'const' : 'ссылка'})`);
        continue;
      }
      if (has(name)) { skipped.push(`${name}() уже существует`); continue; }
      out.push(`${ind}void ${name}(${paramType(f)} value) { ${f.name} = value; }`);
    }
    out.push('');
  }

  // Операторы сравнения.
  if (opts.kinds.has('equality')) {
    if (has('operator==')) {
      skipped.push('operator== уже существует');
    } else {
      const comparable = fields.filter(f => !f.isArray);
      const cond = comparable.length
        ? comparable.map(f => `${f.name} == other.${f.name}`).join(`\n${ind2}    && `)
        : 'true';
      out.push(`${ind}bool operator==(const ${cls.name}& other) const {`);
      out.push(`${ind2}return ${cond};`);
      out.push(`${ind}}`);
      out.push(`${ind}bool operator!=(const ${cls.name}& other) const { return !(*this == other); }`, '');
    }
  }

  // Вывод в поток.
  if (opts.kinds.has('ostream')) {
    if (has('operator<<')) {
      skipped.push('operator<< уже существует');
    } else {
      const printable = fields.filter(f => {
        if (f.isArray || streamStrategy(f.type) === 'skip') {
          skipped.push(`вывод в поток поля ${f.name} (тип не поддерживает <<)`);
          return false;
        }
        return true;
      });
      out.push(`${ind}friend std::ostream& operator<<(std::ostream& os, const ${cls.name}& obj) {`);
      const parts = printable.map((f, idx) => {
        const label = `"${idx === 0 ? '' : ', '}${baseName(f.name)}="`;
        return streamStrategy(f.type) === 'size'
          ? `${label} << "[" << obj.${f.name}.size() << " items]"`
          : `${label} << obj.${f.name}`;
      });
      out.push(`${ind2}os << "${cls.name}{"${parts.length ? ' << ' + parts.join(' << ') : ''} << "}";`);
      out.push(`${ind2}return os;`);
      out.push(`${ind}}`, '');
    }
  }

  // Убираем лишние пустые строки в конце.
  while (out.length && out[out.length - 1] === '') out.pop();
  if (out.length === 0) return { text: '', skipped };

  const header = cls.kind === 'class' ? [`${ind.slice(opts.indentUnit.length)}public:`] : [];
  const marker = `${ind}// ---- сгенерировано CppForge ----`;
  return { text: ['', ...header, marker, ...out, ''].join('\n'), skipped };
}
