import { cloneState, defaultState, normalizeState, isoNow } from './model.js';

const DB_NAME = 'study-routine-pwa';
const STORE = 'app';
const KEY = 'current';
const UNDERSTANDING_LEVELS = new Set(['unknown', 'unsure', 'understood']);
let memoryState = null;

const openDb = () => new Promise((resolve, reject) => {
  if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB unavailable'));
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
});
const tx = (db, mode, operation) => new Promise((resolve, reject) => {
  const transaction = db.transaction(STORE, mode); const store = transaction.objectStore(STORE); let result;
  try { result = operation(store); } catch (err) { transaction.abort(); reject(err); return; }
  transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed')); transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
});
const requestValue = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

export async function loadState() {
  const db = await openDb();
  try {
    const value = await tx(db, 'readonly', (store) => requestValue(store.get(KEY)));
    const state = normalizeState(value || defaultState());
    // Keep the information only for the first UI boot. It is deliberately
    // non-enumerable so exports and deep comparisons keep the persisted shape.
    Object.defineProperty(state, '__fresh', { value: !value, enumerable: false, configurable: true });
    memoryState = state;
    return state;
  }
  finally { db.close(); }
}
export async function saveState(state) {
  const next = normalizeState(cloneState(state)); next.meta.updatedAt = isoNow(); memoryState = next;
  const db = await openDb();
  try { await tx(db, 'readwrite', (store) => store.put(next, KEY)); }
  finally { db.close(); }
  return next;
}
export async function replaceStateWithBackup(incoming) {
  const next = normalizeState(cloneState(incoming));
  const db = await openDb();
  try {
    // Both the snapshot and replacement are written in one transaction. A failed put aborts both.
    const transaction = db.transaction(STORE, 'readwrite'); const store = transaction.objectStore(STORE);
    const current = await requestValue(store.get(KEY));
    const strip = (value) => { const copy = cloneState(value); copy.backups = []; return copy; };
    const backup = current ? { id: `backup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: isoNow(), state: strip(current) } : null;
    // Imported backup metadata is intentionally discarded. Only snapshots made on this device are restore points.
    next.backups = [...(current?.backups || []), ...(backup ? [backup] : [])].slice(-3);
    next.meta.updatedAt = isoNow();
    store.put(next, KEY);
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error || new Error('バックアップ作成に失敗しました')); transaction.onabort = () => reject(transaction.error || new Error('バックアップ作成に失敗しました')); });
    memoryState = next; return next;
  } finally { db.close(); }
}
export async function clearAll() { memoryState = null; try { const db = await openDb(); await tx(db, 'readwrite', (store) => store.delete(KEY)); db.close(); } catch (_) { localStorage.removeItem(`${DB_NAME}:state`); } }
// Active timers keep their timestamps in exports, so moving a file to another device can resume the same session.
export const serializeState = (state) => JSON.stringify({ ...cloneState(state), exportedAt: isoNow() }, null, 2);
export const parseImport = (text) => {
  let parsed; try { parsed = JSON.parse(text); } catch (_) { throw new Error('JSONとして読み込めませんでした'); }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) throw new Error('このアプリのデータ形式ではありません');
  if (!Array.isArray(parsed.subjects) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.assignments)) throw new Error('必要なデータが不足しています');
  const ids = new Set(); for (const subject of parsed.subjects) {
    if (!subject || typeof subject.id !== 'string' || !subject.id || typeof subject.name !== 'string' || !subject.name.trim() || ids.has(subject.id)) throw new Error('教科データが不正です');
    ids.add(subject.id);
  }
  const validDate = (value) => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const [y, m, d] = value.split('-').map(Number); const date = new Date(Date.UTC(y, m - 1, d)); return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d; };
  const validTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const validTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const validSlots = (slots) => Array.isArray(slots) && slots.every((slot) => slot && validTime(slot.start) && validTime(slot.end) && slot.start < slot.end && (!slot.cycles || (Number.isInteger(slot.cycles) && slot.cycles > 0 && Number.isFinite(slot.study) && slot.study > 0 && Number.isFinite(slot.break) && slot.break >= 0)));
  if (!parsed.timetable || typeof parsed.timetable !== 'object' || !Object.values(parsed.timetable).every(validSlots) || Object.keys(parsed.timetable).some((key) => !/^[0-6]$/.test(key))) throw new Error('時間割の形式が不正です');
  if (parsed.classTimetable && (typeof parsed.classTimetable !== 'object' || Object.values(parsed.classTimetable).some((rows) => !Array.isArray(rows) || rows.some((id) => !ids.has(id))))) throw new Error('授業の時間割が不正です');
  if (parsed.dateOverrides && (typeof parsed.dateOverrides !== 'object' || Object.entries(parsed.dateOverrides).some(([date, value]) => !validDate(date) || !value || typeof value !== 'object' || typeof value.holiday !== 'boolean' || (value.subjects && (!Array.isArray(value.subjects) || value.subjects.some((id) => !ids.has(id)))) || (value.slots && !validSlots(value.slots))))) throw new Error('日付ごとの変更が不正です');
  for (const session of parsed.sessions) {
    if (!session || !Array.isArray(session.segments) || (session.startedAt && !validTimestamp(session.startedAt)) || (session.finishedAt && !validTimestamp(session.finishedAt))) throw new Error('勉強記録の形式が不正です');
    for (const segment of session.segments) {
      if (!segment || !ids.has(segment.subjectId) || !validTimestamp(segment.startedAt) || !validTimestamp(segment.endedAt) || new Date(segment.endedAt) <= new Date(segment.startedAt)) throw new Error('勉強記録の日時または教科が不正です');
    }
  }
  if (!parsed.settings || !validDate(parsed.settings.firstUseDate) || (parsed.settings.lastExportAt !== null && parsed.settings.lastExportAt !== undefined && !validTimestamp(parsed.settings.lastExportAt))) throw new Error('設定の日付が不正です');
  if (parsed.understanding && (typeof parsed.understanding !== 'object' || Object.values(parsed.understanding).some((row) => !row || typeof row !== 'object' || !ids.has(row.subjectId) || !validDate(row.date) || !UNDERSTANDING_LEVELS.has(row.level) || typeof row.after !== 'boolean' || !validTimestamp(row.at)))) throw new Error('理解度データが不正です');
  const statuses = new Set(['未着手', '作業中', '完成未提出', '提出済み']); const assignmentIds = new Set();
  for (const assignment of parsed.assignments) {
    if (!assignment || typeof assignment.id !== 'string' || assignmentIds.has(assignment.id) || typeof assignment.title !== 'string' || !assignment.title.trim() || (assignment.subjectId && !ids.has(assignment.subjectId)) || (assignment.dueDate && !validDate(assignment.dueDate)) || !statuses.has(assignment.status)) throw new Error('提出物データが不正です'); assignmentIds.add(assignment.id);
  }
  const examIds = new Set(); for (const exam of parsed.exams || []) { if (!exam || typeof exam.id !== 'string' || examIds.has(exam.id) || typeof exam.name !== 'string' || !exam.name.trim() || !validDate(exam.prepStart) || !Array.isArray(exam.subjects) || !exam.subjects.length || exam.subjects.some((row) => !row || !ids.has(row.subjectId) || !validDate(row.examDate) || row.examDate < exam.prepStart)) throw new Error('テストデータが不正です'); examIds.add(exam.id); }
  if (parsed.timer && (!Array.isArray(parsed.timer.segments) || !['running', 'paused', 'finished'].includes(parsed.timer.status) || !validTimestamp(parsed.timer.startedAt) || parsed.timer.segments.some((segment) => !segment || !ids.has(segment.subjectId) || !validTimestamp(segment.startedAt) || (segment.endedAt && !validTimestamp(segment.endedAt)) || (segment.endedAt && new Date(segment.endedAt) <= new Date(segment.startedAt))))) throw new Error('タイマーの形式が不正です');
  if (parsed.timer) { const open = parsed.timer.segments.filter((segment) => !segment.endedAt); if (parsed.timer.status === 'running' && (open.length !== 1 || parsed.timer.currentSubjectId !== open[0].subjectId)) throw new Error('実行中タイマーの区間が不正です'); if (parsed.timer.status === 'paused' && open.length) throw new Error('一時停止タイマーの区間が不正です'); }
  const state = normalizeState(parsed); return state;
};
