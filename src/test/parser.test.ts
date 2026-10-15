/**
 * Модульные тесты парсеров и генераторов (запуск: `npm test`).
 * Не зависят от VS Code и запускаются обычным Node.js.
 *
 * @module
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEnums } from '../parser/enumParser';
import { findClassAt } from '../parser/classParser';
import { generateSwitch, findSwitchAt, matchEnumForSwitch, generateMissingCases } from '../generators/switchGenerator';
import { generateClassMembers, baseName, paramType } from '../generators/classGenerator';

const ENUM_SRC = `
#include <cstdint>
namespace game {
// комментарий с enum Fake { X };
struct Unit {
    enum State { Idle, Walk = 5, Run, Default = Idle };
};
enum class Color : std::uint8_t { Red = 1 << 0, Green = 1 << 1, Blue = 0x4, Primary = Red };
}
`;

test('находит перечисления с учётом namespace и класса', () => {
  const enums = findEnums(ENUM_SRC);
  assert.equal(enums.length, 2);
  assert.equal(enums[0].qualifiedName, 'game::Unit::State');
  assert.equal(enums[0].scoped, false);
  assert.equal(enums[1].qualifiedName, 'game::Color');
  assert.equal(enums[1].underlyingType, 'std::uint8_t');
});

test('вычисляет значения и находит синонимы', () => {
  const [state, color] = findEnums(ENUM_SRC);
  assert.deepEqual(state.enumerators.map(e => e.value), [0, 5, 6, 0]);
  assert.equal(state.enumerators[3].aliasOf, 'Idle');
  assert.deepEqual(color.enumerators.map(e => e.value), [1, 2, 4, 1]);
  assert.equal(color.enumerators[3].aliasOf, 'Red');
});

test('switch не содержит повторяющихся меток', () => {
  const [, color] = findEnums(ENUM_SRC);
  const code = generateSwitch(color, 'c', '');
  assert.match(code, /case game::Color::Red: \/\/ синонимы: Primary/);
  assert.doesNotMatch(code, /case game::Color::Primary/);
  assert.match(code, /default:/);
});

test('дополняет существующий switch недостающими ветками', () => {
  const src = ENUM_SRC + `
void f(game::Color c) {
    switch (c) {
        case game::Color::Primary:
            break;
        default:
            break;
    }
}`;
  const offset = src.indexOf('case game::Color::Primary');
  const block = findSwitchAt(src, offset)!;
  assert.ok(block);
  assert.equal(block.expression, 'c');
  const info = matchEnumForSwitch(block, findEnums(src))!;
  assert.equal(info.name, 'Color');
  const { added } = generateMissingCases(block, info);
  // Red обработан через синоним Primary
  assert.deepEqual(added, ['Green', 'Blue']);
  assert.ok(src.slice(block.insertOffset).trimStart().startsWith('default:'));
});

const CLASS_SRC = `
class Student {
public:
    int getAge() const { return m_age; }
private:
    std::string m_name;
    int m_age = 18, *m_ptr;
    const double m_gpa{4.0};
    std::map<std::string, std::vector<int>> grades_;
    static int s_count;
    int marks[5];
    void helper(int x);
    std::function<void(int)> callback;
};
`;

test('разбирает поля класса и пропускает методы/static', () => {
  const cls = findClassAt(CLASS_SRC, CLASS_SRC.indexOf('m_name'))!;
  assert.equal(cls.name, 'Student');
  assert.deepEqual(cls.fields.map(f => f.name), ['m_name', 'm_age', 'm_ptr', 'm_gpa', 'grades_', 'marks', 'callback']);
  assert.equal(cls.fields.find(f => f.name === 'm_ptr')!.type, 'int*');
  assert.equal(cls.fields.find(f => f.name === 'grades_')!.type, 'std::map<std::string, std::vector<int>>');
  assert.equal(cls.fields.find(f => f.name === 'callback')!.type, 'std::function<void(int)>');
  assert.ok(cls.fields.find(f => f.name === 'm_gpa')!.isConst);
  assert.ok(cls.existingMethods.has('getAge'));
});

test('генерирует члены класса без дубликатов', () => {
  const cls = findClassAt(CLASS_SRC, CLASS_SRC.indexOf('m_name'))!;
  const { text, skipped } = generateClassMembers(cls, {
    kinds: new Set(['constructor', 'getters', 'setters', 'equality', 'ostream']),
    getterStyle: 'get', indentUnit: '    ',
  });
  assert.match(text, /const std::string& getName\(\) const/);
  assert.doesNotMatch(text, /int getAge\(\)/); // уже есть
  assert.doesNotMatch(text, /setGpa/);          // const-поле
  assert.match(text, /void setGrades\(const std::map<std::string, std::vector<int>>& value\)/);
  assert.match(text, /friend std::ostream& operator<</);
  assert.ok(skipped.some(s => s.includes('getAge')));
});

test('вспомогательные функции', () => {
  assert.equal(baseName('m_name'), 'name');
  assert.equal(baseName('count_'), 'count');
  assert.equal(paramType({ name: 'x', type: 'std::string', isConst: false, isReference: false, isArray: false, access: 'private' }), 'const std::string&');
});
