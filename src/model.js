/* Pure application rules. This file intentionally has no DOM or browser storage dependencies. */
export const VERSION = 1;
export const UNDERSTANDING = [
  { value: 'unknown', label: '分からなかった', score: 0 },
  { value: 'unsure', label: '少し不安', score: 1 },
  { value: 'understood', label: '分かった', score: 2 },
];
export const SUBJECT_PRESETS = [
  { id: 'math', name: '数学', kind: 'school', color: '#ef8354' },
  { id: 'english', name: '英語', kind: 'school', color: '#4f86c6' },
  { id: 'japanese', name: '国語', kind: 'school', color: '#a569bd' },
  { id: 'science', name: '理科', kind: 'school', color: '#2a9d8f' },
  { id: 'social', name: '社会', kind: 'school', color: '#e9c46a' },
  { id: 'it-passport', name: 'ITパスポート', kind: 'qualification', color: '#457b9d' },
  { id: 'surveying', name: '測量士補', kind: 'qualification', color: '#7b8f5f' },
];
export const JST = 'Asia/Tokyo';

const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const localDate = (value = new Date()) => {
  const d = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};
export const parseDate = (date, hour = 0, minute = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  // A date-only value represents midnight in Japan, independent of the host timezone.
  return new Date(Date.UTC(y, m - 1, d, hour - 9, minute, 0, 0));
};
export const addDays = (date, amount) => {
  const d = parseDate(localDate(date instanceof Date ? date : new Date(`${date}T00:00:00`)));
  d.setDate(d.getDate() + amount);
  return localDate(d);
};
export const diffDays = (a, b) => Math.round((parseDate(a) - parseDate(b)) / 86400000);
export const formatMinutes = (minutes) => {
  const n = Math.max(0, Math.round(minutes));
  const h = Math.floor(n / 60);
  return h ? `${h}時間${n % 60 ? ` ${n % 60}分` : ''}` : `${n}分`;
};
export const formatClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const defaultTimetable = () => ({
  0: [{ start: '08:00', end: '11:00', label: '休日：復習・資格（50分×3）', cycles: 3, study: 50, break: 10 }],
  1: [{ start: '16:00', end: '18:00', label: '帰宅後の復習' }],
  2: [{ start: '17:00', end: '18:00', label: '帰宅後の復習' }],
  3: [{ start: '17:00', end: '18:00', label: '帰宅後の復習' }, { start: '19:30', end: '20:30', label: '夜の勉強枠' }],
  4: [{ start: '17:00', end: '18:00', label: '帰宅後の復習' }, { start: '19:30', end: '20:30', label: '夜の勉強枠' }],
  5: [{ start: '17:00', end: '18:00', label: '帰宅後の復習' }],
  6: [{ start: '08:00', end: '11:00', label: '休日：復習・資格（50分×3）', cycles: 3, study: 50, break: 10 }],
});
export const defaultState = (now = new Date()) => ({
  schemaVersion: VERSION,
  settings: { theme: 'auto', reminderEnabled: true, firstUseDate: localDate(now), lastExportAt: null },
  subjects: SUBJECT_PRESETS.map((x) => ({ ...x })),
  timetable: defaultTimetable(),
  classTimetable: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
  dateOverrides: {},
  exams: [],
  assignments: [],
  understanding: {},
  sessions: [],
  timer: null,
  backups: [],
  meta: { updatedAt: now.toISOString() },
});
export const normalizeState = (input, now = new Date()) => {
  const base = defaultState(now);
  if (!input || typeof input !== 'object') return base;
  const out = { ...base, ...input, schemaVersion: VERSION };
  for (const key of ['settings', 'timetable', 'classTimetable', 'dateOverrides', 'understanding', 'meta']) out[key] = { ...base[key], ...(input[key] || {}) };
  for (const key of ['subjects', 'exams', 'assignments', 'sessions', 'backups']) out[key] = Array.isArray(input[key]) ? input[key] : base[key];
  out.timer = input.timer && typeof input.timer === 'object' ? input.timer : null;
  out.settings = { ...base.settings, ...(input.settings || {}) };
  return out;
};
export const cloneState = (state) => JSON.parse(JSON.stringify(state));
export const dayIndex = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const scheduleForDate = (state, date) => {
  const override = state.dateOverrides?.[date];
  // A holiday still accepts a date-specific slot.  This lets a moved holiday
  // keep the 50+10 cycle metadata while changing its morning start time.
  if (override?.holiday) return { holiday: true, slots: override.slots || defaultTimetable()[0] };
  if (override?.slots) return { holiday: false, slots: override.slots };
  return { holiday: false, slots: state.timetable?.[dayIndex(date)] || [] };
};
export const activeExamForDate = (state, date) => state.exams
  .map((exam) => ({ ...exam, subjects: exam.subjects || (exam.subjectIds || []).map((subjectId) => ({ subjectId, examDate: exam.finalDate })) }))
  .filter((exam) => exam.prepStart && exam.subjects.some((row) => row.examDate && exam.prepStart <= date && date <= row.examDate))
  .sort((a, b) => (a.finalDate || a.subjects.map((x) => x.examDate).sort().at(-1) || '').localeCompare(b.finalDate || b.subjects.map((x) => x.examDate).sort().at(-1) || ''));
export const subjectName = (state, id) => state.subjects.find((s) => s.id === id)?.name || '科目未設定';
export const latestUnderstanding = (state, subjectId) => {
  const rows = Object.values(state.understanding || {}).filter((x) => x.subjectId === subjectId && x.after);
  return rows.sort((a, b) => (b.at || '').localeCompare(a.at || ''))[0] || null;
};
export const todaySubjects = (state, date) => {
  const override = state.dateOverrides?.[date];
  const hasDayOverride = override && Array.isArray(override.subjects);
  const ids = hasDayOverride ? override.subjects : state.classTimetable?.[dayIndex(date)] || [];
  const fromUnderstanding = Object.values(state.understanding || {}).filter((x) => x.date === date).map((x) => x.subjectId);
  const selected = new Set(hasDayOverride ? ids : [...ids, ...fromUnderstanding]);
  return state.subjects.filter((s) => s.kind === 'school' && selected.has(s.id));
};
const candidate = (type, subjectId, title, reason, dueDate = null, extra = {}) => {
  // One exam series can contain several subjects. Include the subject in the
  // identity so a selection can never resolve to another row in that series.
  const owner = extra.assignmentId || extra.examId || subjectId;
  const subjectKey = extra.examId && subjectId ? `_${subjectId}` : '';
  return { id: `candidate_${type}_${owner}${subjectKey}`, type, subjectId, title, reason, dueDate, ...extra };
};
export const recommendationsForDate = (state, date) => {
  const assignments = state.assignments.filter((a) => a.status !== '提出済み' && a.status !== '完成未提出' && a.dueDate && diffDays(a.dueDate, date) <= 3);
  const examRows = activeExamForDate(state, date);
  const examCandidates = examRows.flatMap((exam) => exam.subjects.filter((x) => x.examDate && exam.prepStart <= date && date <= x.examDate).map((row) => candidate('exam', row.subjectId, `${subjectName(state, row.subjectId)}：${exam.name}`, `テスト対策（${row.examDate}まで）`, row.examDate, { examId: exam.id })));
  const assignmentCandidates = assignments.map((a, order) => candidate('assignment', a.subjectId, a.title, a.dueDate < date ? '期限超過' : `提出期限まで${Math.max(0, diffDays(a.dueDate, date))}日`, a.dueDate, { assignmentId: a.id, order }));
  let reviewSubjects = todaySubjects(state, date);
  const beforeRows = reviewSubjects.map((s) => Object.values(state.understanding).filter((x) => x.date === date && x.subjectId === s.id && !x.after).sort((a, b) => (b.at || '').localeCompare(a.at || ''))[0]).filter(Boolean);
  const anxiousIds = new Set(beforeRows.filter((x) => x.level === 'unknown' || x.level === 'unsure').map((x) => x.subjectId));
  if (anxiousIds.size) reviewSubjects = reviewSubjects.filter((s) => anxiousIds.has(s.id));
  const isWeekendSlot = scheduleForDate(state, date).slots.some((s) => s.cycles);
  if (isWeekendSlot) {
    // A holiday morning is a planned school-review block even when no class
    // subjects are configured for that date. Unresolved subjects remain first
    // in the list, while the normal review choices stay available.
    if (!reviewSubjects.length) reviewSubjects = state.subjects.filter((s) => s.kind === 'school');
    const unresolved = state.subjects.filter((s) => s.kind === 'school' && ['unknown', 'unsure'].includes(latestUnderstanding(state, s.id)?.level));
    const known = new Set(reviewSubjects.map((s) => s.id)); reviewSubjects = [...reviewSubjects, ...unresolved.filter((s) => !known.has(s.id))];
  }
  const reviewCandidates = reviewSubjects.map((s) => {
    const before = Object.values(state.understanding).filter((x) => x.date === date && x.subjectId === s.id && !x.after).sort((a, b) => (b.at || '').localeCompare(a.at || ''))[0];
    const latest = before || latestUnderstanding(state, s.id); const label = UNDERSTANDING.find((u) => u.value === latest?.level)?.label || '理解度未入力';
    return candidate('review', s.id, `${s.name}の復習`, `${before ? '授業後' : '前回の復習後'}の理解度：${label}`, null, { anxiety: latest?.level === 'unknown' ? 2 : latest?.level === 'unsure' ? 1 : 0 });
  });
  const qualification = scheduleForDate(state, date).slots.some((s) => s.cycles) && !examRows.length
    ? state.subjects.filter((s) => s.kind === 'qualification').map((s) => candidate('qualification', s.id, `${s.name}を進める`, '休日の資格枠', null)) : [];
  const all = [...assignmentCandidates, ...examCandidates, ...reviewCandidates, ...qualification];
  all.sort((a, b) => {
    const ad = a.dueDate || '9999-99-99'; const bd = b.dueDate || '9999-99-99';
    if (a.type === 'assignment' && b.type === 'assignment' && ad === bd) return (a.order || 0) - (b.order || 0);
    if (a.type === 'assignment' && b.type !== 'assignment' && ad === bd) return -1;
    if (a.type !== 'assignment' && b.type === 'assignment' && ad === bd) return 1;
    if (ad !== bd && (a.dueDate || b.dueDate)) return ad.localeCompare(bd);
    if ((b.anxiety || 0) !== (a.anxiety || 0)) return (b.anxiety || 0) - (a.anxiety || 0);
    return a.title.localeCompare(b.title, 'ja');
  });
  return all;
};
export const completedUnsubmitted = (state) => state.assignments.filter((a) => a.status === '完成未提出');

const durationForSegment = (segment, now) => {
  if (!segment.startedAt) return 0;
  const end = segment.endedAt ? new Date(segment.endedAt).getTime() : now;
  return Math.max(0, end - new Date(segment.startedAt).getTime());
};
export const timerElapsed = (timer, now = Date.now()) => timer?.segments?.reduce((sum, s) => sum + durationForSegment(s, now), 0) || 0;
export const timerRemaining = (timer, now = Date.now()) => Math.max(0, 1800000 - timerElapsed(timer, now));
export const timerBySubject = (timer, now = Date.now()) => (timer?.segments || []).reduce((map, seg) => {
  map[seg.subjectId] = (map[seg.subjectId] || 0) + durationForSegment(seg, now); return map;
}, {});
export const beginTimer = (subjectId, now = new Date()) => ({ id: uid('timer'), status: 'running', currentSubjectId: subjectId, startedAt: now.toISOString(), pausedAt: null, segments: [{ subjectId, startedAt: now.toISOString(), endedAt: null }] });
export const pauseTimer = (timer, now = new Date()) => {
  if (!timer || timer.status !== 'running') return timer;
  const copy = cloneState(timer); copy.status = 'paused'; copy.pausedAt = now.toISOString();
  const seg = copy.segments[copy.segments.length - 1]; if (seg && !seg.endedAt) seg.endedAt = now.toISOString();
  return copy;
};
export const resumeTimer = (timer, now = new Date()) => {
  if (!timer || timer.status !== 'paused') return timer;
  const copy = cloneState(timer); copy.status = 'running'; copy.pausedAt = null;
  copy.currentSubjectId = timer.currentSubjectId || timer.segments.at(-1)?.subjectId;
  copy.segments.push({ subjectId: copy.currentSubjectId, startedAt: now.toISOString(), endedAt: null });
  return copy;
};
export const switchTimerSubject = (timer, subjectId, now = new Date()) => {
  if (!timer || timer.status !== 'running' || !subjectId || timer.segments.at(-1)?.subjectId === subjectId) return timer;
  const copy = cloneState(timer); const previous = copy.segments.at(-1); if (previous && !previous.endedAt) previous.endedAt = now.toISOString();
  copy.segments.push({ subjectId, startedAt: now.toISOString(), endedAt: null }); copy.currentSubjectId = subjectId; return copy;
};
export const finishTimer = (timer, now = new Date()) => {
  if (!timer) return null;
  const copy = cloneState(timer); const previous = copy.segments.at(-1); if (copy.status === 'running' && previous && !previous.endedAt) previous.endedAt = now.toISOString();
  copy.status = 'finished'; copy.finishedAt = now.toISOString(); copy.pausedAt = copy.status === 'paused' ? copy.pausedAt : null; return copy;
};
export const splitIntervalByDate = (start, end) => {
  const a = new Date(start).getTime(); const b = new Date(end).getTime(); if (!(b > a)) return [];
  const out = []; let cursor = a;
  while (cursor < b) {
    const d = new Date(cursor); const next = parseDate(addDays(localDate(d), 1)).getTime();
    const stop = Math.min(next, b); out.push({ date: localDate(d), ms: stop - cursor }); cursor = stop;
  }
  return out;
};
export const sessionDurationsByDate = (state, now = Date.now()) => {
  const out = {};
  for (const session of state.sessions || []) for (const seg of session.segments || []) {
    const pieces = splitIntervalByDate(seg.startedAt, seg.endedAt || new Date(now).toISOString());
    for (const p of pieces) { out[p.date] = (out[p.date] || 0) + p.ms; }
  }
  return out;
};
export const subjectDurations = (state, date = null, now = Date.now()) => {
  const out = {};
  for (const session of state.sessions || []) for (const seg of session.segments || []) for (const p of splitIntervalByDate(seg.startedAt, seg.endedAt || new Date(now).toISOString())) {
    if (!date || p.date === date) out[seg.subjectId] = (out[seg.subjectId] || 0) + p.ms;
  }
  return out;
};
export const dayHasMinimum = (state, date, now = Date.now()) => (sessionDurationsByDate(state, now)[date] || 0) >= 1800000;
export const streakThrough = (state, date = localDate(), now = Date.now()) => {
  const days = sessionDurationsByDate(state, now); let n = 0; let cursor = date;
  // Before today's 30-minute mark, show the uninterrupted streak ending
  // yesterday. This keeps the useful count visible while today's work is in
  // progress.
  if (!dayHasMinimum(state, cursor, now)) cursor = addDays(cursor, -1);
  while (dayHasMinimum(state, cursor, now)) { n += 1; cursor = addDays(cursor, -1); }
  return n;
};
export const periodBounds = (date, period) => {
  const [y, m, day] = date.split('-').map(Number); if (period === 'month') return { start: `${y}-${String(m).padStart(2, '0')}-01`, end: date };
  const d = new Date(Date.UTC(y, m - 1, day)); const mondayOffset = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - mondayOffset);
  return { start: d.toISOString().slice(0, 10), end: date };
};
export const averageMinutes = (state, period = 'lifetime', today = localDate(), now = Date.now()) => {
  const days = sessionDurationsByDate(state, now); let start; let end = today;
  if (period === 'week' || period === 'month') ({ start } = periodBounds(today, period));
  else start = state.settings?.firstUseDate || today;
  const totalDays = Math.max(1, diffDays(end, start) + 1); let total = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) total += days[d] || 0;
  return total / totalDays / 60000;
};
export const calendarDays = (state, year, month, now = Date.now()) => {
  const first = new Date(year, month, 1); const last = new Date(year, month + 1, 0); const days = sessionDurationsByDate(state, now); const rows = [];
  for (let i = 1; i <= last.getDate(); i++) { const date = localDate(new Date(year, month, i)); rows.push({ date, day: i, minutes: Math.round((days[date] || 0) / 60000), completed: (days[date] || 0) >= 1800000 }); }
  return rows;
};
export const createSession = (timer, memo = '', now = new Date()) => ({
  id: uid('session'),
  startedAt: timer.startedAt,
  finishedAt: now.toISOString(),
  type: timer.type || 'review',
  segments: timer.segments.map((s) => ({ ...s, type: s.type || timer.type || 'review' })),
  memo,
});
export const isoNow = () => new Date().toISOString();
export const uidFor = uid;

if (typeof globalThis !== 'undefined') globalThis.StudyModel = { VERSION, UNDERSTANDING, SUBJECT_PRESETS, defaultState, normalizeState, scheduleForDate, recommendationsForDate, timerElapsed, timerRemaining, timerBySubject, sessionDurationsByDate, averageMinutes, streakThrough, splitIntervalByDate, beginTimer, pauseTimer, resumeTimer, switchTimerSubject, finishTimer };
