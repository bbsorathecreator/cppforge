/**
 * Точка входа расширения CppForge для VS Code.
 *
 * Здесь только «клей» между API редактора и чистой логикой из `parser/` и
 * `generators/`: получение текста документа, диалоги выбора, вставка результата.
 *
 * @module
 */
import * as vscode from 'vscode';
import { findEnums, indexEnums, EnumInfo } from './parser/enumParser';
import { findClassAt } from './parser/classParser';
import {
  generateSwitch, generateToString, findSwitchAt, matchEnumForSwitch, generateMissingCases,
} from './generators/switchGenerator';
import { generateClassMembers, MemberKind } from './generators/classGenerator';

/** Перечисление вместе с файлом, где оно найдено. */
interface LocatedEnum {
  info: EnumInfo;
  uri: vscode.Uri;
}

/** Максимальное число заголовочных файлов, просматриваемых в рабочей области. */
const MAX_HEADER_FILES = 300;

/**
 * Вызывается VS Code при первом использовании команды расширения.
 * Регистрирует все команды.
 *
 * @param context контекст расширения
 */
export function activate(context: vscode.ExtensionContext): void {
  const register = (id: string, fn: (editor: vscode.TextEditor) => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(id, editor => {
      fn(editor).catch(err => vscode.window.showErrorMessage(`CppForge: ${err.message ?? err}`));
    }));
  };
  register('cppforge.generateSwitch', cmdGenerateSwitch);
  register('cppforge.completeSwitch', cmdCompleteSwitch);
  register('cppforge.generateToString', cmdGenerateToString);
  register('cppforge.generateClassMembers', cmdGenerateClassMembers);
}

/** Вызывается при выгрузке расширения. Ресурсы освобождаются через `context.subscriptions`. */
export function deactivate(): void { /* ничего */ }

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Строка одного уровня отступа согласно настройкам редактора. */
function indentUnit(editor: vscode.TextEditor): string {
  const { insertSpaces, tabSize } = editor.options;
  return insertSpaces === false ? '\t' : ' '.repeat(typeof tabSize === 'number' ? tabSize : 4);
}

/** Ведущие пробелы строки. */
function leadingWhitespace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

/**
 * Отступ для вставки на пустую строку: берётся отступ ближайшей непустой строки
 * выше; если она заканчивается на `{`, добавляется ещё один уровень.
 */
function indentForEmptyLine(editor: vscode.TextEditor, lineNo: number): string {
  for (let i = lineNo - 1; i >= 0; i--) {
    const text = editor.document.lineAt(i).text;
    if (text.trim() === '') continue;
    const ws = leadingWhitespace(text);
    return text.trimEnd().endsWith('{') ? ws + indentUnit(editor) : ws;
  }
  return '';
}

/** Настройки расширения. */
function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('cppforge');
}

/**
 * Собирает перечисления из текущего документа и (если включено в настройках)
 * из заголовочных файлов рабочей области. Перечисления текущего файла идут первыми.
 */
async function collectEnums(doc: vscode.TextDocument): Promise<LocatedEnum[]> {
  const result: LocatedEnum[] = findEnums(doc.getText()).map(info => ({ info, uri: doc.uri }));
  if (!config().get<boolean>('searchWorkspaceHeaders', true)) return result;

  const files = await vscode.workspace.findFiles(
    '**/*.{h,hh,hpp,hxx}', '**/{node_modules,build,cmake-build-*,.git}/**', MAX_HEADER_FILES);
  const seen = new Set<string>([doc.uri.toString()]);
  for (const uri of files) {
    if (seen.has(uri.toString())) continue;
    seen.add(uri.toString());
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    if (!text.includes('enum')) continue; // быстрый отсев
    for (const info of findEnums(text)) result.push({ info, uri });
  }
  return result;
}

/**
 * Выбирает перечисление: если слово под курсором совпадает с именем enum — берёт его,
 * иначе показывает список для выбора.
 */
async function pickEnum(editor: vscode.TextEditor, enums: LocatedEnum[]): Promise<LocatedEnum | undefined> {
  if (enums.length === 0) {
    vscode.window.showWarningMessage('CppForge: перечисления не найдены.');
    return undefined;
  }
  const doc = editor.document;
  const wordRange = doc.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][\w:]*/);
  if (wordRange) {
    const word = doc.getText(wordRange);
    const byName = indexEnums(enums.map(e => e.info)).get(word);
    if (byName && byName.length === 1) return enums.find(e => e.info === byName[0]);
  }
  const items = enums.map(e => ({
    label: e.info.qualifiedName,
    description: `${e.info.scoped ? 'enum class' : 'enum'} · ${e.info.enumerators.length} элементов`,
    detail: vscode.workspace.asRelativePath(e.uri),
    located: e,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Выберите перечисление' });
  return picked?.located;
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

/** Команда «Сгенерировать switch по enum». */
async function cmdGenerateSwitch(editor: vscode.TextEditor): Promise<void> {
  const located = await pickEnum(editor, await collectEnums(editor.document));
  if (!located) return;
  const { info } = located;

  const defaultVar = info.name.charAt(0).toLowerCase() + info.name.slice(1);
  const expression = await vscode.window.showInputBox({
    prompt: `Выражение типа ${info.qualifiedName} для switch`,
    value: defaultVar,
  });
  if (!expression) return;

  const pos = editor.selection.active;
  const line = editor.document.lineAt(pos.line);
  const baseIndent = line.isEmptyOrWhitespace
    ? indentForEmptyLine(editor, pos.line)
    : leadingWhitespace(line.text);
  const code = generateSwitch(info, expression, baseIndent, {
    addDefault: config().get<boolean>('switch.addDefault', true),
    indentUnit: indentUnit(editor),
    bodyStyle: 'todo-break',
  });

  await editor.edit(b => {
    if (line.isEmptyOrWhitespace) b.replace(line.range, baseIndent + code);
    else b.insert(line.range.end, '\n' + baseIndent + code);
  });
}

/** Команда «Дополнить switch недостающими case». */
async function cmdCompleteSwitch(editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document;
  const src = doc.getText();
  const block = findSwitchAt(src, doc.offsetAt(editor.selection.active));
  if (!block) {
    vscode.window.showWarningMessage('CppForge: поставьте курсор внутрь оператора switch.');
    return;
  }
  const enums = await collectEnums(doc);
  let info = matchEnumForSwitch(block, enums.map(e => e.info));
  if (!info) info = (await pickEnum(editor, enums))?.info; // switch пока пустой
  if (!info) return;

  const { text, added } = generateMissingCases(block, info);
  if (added.length === 0) {
    vscode.window.showInformationMessage(`CppForge: все элементы ${info.name} уже обработаны.`);
    return;
  }
  await editor.edit(b => b.insert(doc.positionAt(block.insertOffset), text));
  vscode.window.showInformationMessage(`CppForge: добавлено case: ${added.join(', ')}`);
}

/** Команда «Сгенерировать toString для enum». */
async function cmdGenerateToString(editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document;
  const local = findEnums(doc.getText()).map(info => ({ info, uri: doc.uri }));
  const located = await pickEnum(editor, local);
  if (!located) return;

  // Вставляем после `;`, завершающей объявление перечисления.
  const text = doc.getText();
  const semicolon = text.indexOf(';', located.info.endOffset);
  const afterEnum = doc.positionAt(semicolon === -1 ? located.info.endOffset : semicolon + 1);
  const baseIndent = leadingWhitespace(doc.lineAt(doc.positionAt(located.info.startOffset).line).text);

  if (located.info.insideClass) {
    // enum внутри класса: свободная функция внутри класса невозможна — делаем friend.
    const code = generateToString(located.info, baseIndent, indentUnit(editor))
      .replace('inline const char*', 'friend const char*');
    await editor.edit(b => b.insert(afterEnum, '\n' + baseIndent + code));
  } else {
    const code = generateToString(located.info, baseIndent, indentUnit(editor));
    await editor.edit(b => b.insert(afterEnum, '\n\n' + baseIndent + code));
  }
}

/** Команда «Сгенерировать члены класса». */
async function cmdGenerateClassMembers(editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document;
  const cls = findClassAt(doc.getText(), doc.offsetAt(editor.selection.active));
  if (!cls) {
    vscode.window.showWarningMessage('CppForge: поставьте курсор внутрь класса или структуры.');
    return;
  }

  const options: { label: string; member: MemberKind; picked: boolean }[] = [
    { label: 'Конструктор со всеми полями', member: 'constructor', picked: true },
    { label: 'Геттеры', member: 'getters', picked: true },
    { label: 'Сеттеры', member: 'setters', picked: true },
    { label: 'operator== и operator!=', member: 'equality', picked: false },
    { label: 'operator<< для std::ostream', member: 'ostream', picked: false },
  ];
  const picked = await vscode.window.showQuickPick(options, {
    canPickMany: true,
    placeHolder: `${cls.name}: найдено полей — ${cls.fields.length}. Что сгенерировать?`,
  });
  if (!picked || picked.length === 0) return;

  const { text, skipped } = generateClassMembers(cls, {
    kinds: new Set(picked.map(p => p.member)),
    getterStyle: config().get<'get' | 'plain'>('getterStyle', 'get'),
    indentUnit: indentUnit(editor),
  });
  if (text) await editor.edit(b => b.insert(doc.positionAt(cls.insertOffset), text));
  if (skipped.length) vscode.window.showInformationMessage(`CppForge: пропущено — ${skipped.join('; ')}`);
}
