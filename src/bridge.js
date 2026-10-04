import { loadState, saveState } from './db.js';
import {
  addDays, averageMinutes, beginStopwatch, beginTimer, createSession, finishTimer,
  isoNow, localDate, pauseTimer, periodBounds, recommendationsForDate, resumeTimer,
  scheduleForDate, sessionDurationsByDate, streakThrough, subjectDurations, subjectName, uidFor,
} from './model.js';

const BRIDGE_URL = localStorage.getItem('studyBridgeUrl') || 'http://127.0.0.1:43110';
const CLIENT_KEY = 'studyBridgeClientId';
const clientId = localStorage.getItem(CLIENT_KEY) || `pwa_${crypto.randomUUID().replaceAll('-', '')}`;
localStorage.setItem(CLIENT_KEY, clientId);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const assignmentStatuses = new Set(['未着手', '作業中', '完成未提出', '提出済み']);
const sessionTypes = new Set(['review', 'exam', 'qualification', 'assignment', 'stopwatch']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonFetch = async (path, options = {}) => {
  const response = await fetch(`${BRIDGE_URL}${path}`, { cache: 'no-store', ...options });
  if (!response.ok) throw new Error(`bridge HTTP ${response.status}`);
  return response.json();
};
const post = (path, body) => jsonFetch(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const assertDate = (value, label = 'date') => {
  if (!DATE_RE.test(value || '')) throw new Error(`${label} は YYYY-MM-DD で指定してください`);
  return value;
};
const assertTime = (value, label) => {
  if (!TIME_RE.test(value || '')) throw new Error(`${label} は HH:MM で指定してください`);
  return value;
};

function resolveSubject(state, value, required = true) {
  if (!value) {
    if (required) throw new Error('教科を指定してください');
    return null;
  }
  const key = String(value).trim();
  const matches = state.subjects.filter((s) =>
    s.id === key || s.name.trim().toLocaleLowerCase('ja') === key.toLocaleLowerCase('ja')
  );
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`教科が見つかりません: ${key}`);
  throw new Error(`教科名が重複しています。IDで指定してください: ${key}`);
}

function resolveAssignment(state, value) {
  const key = String(value || '').trim();
  const matches = state.assignments.filter((a) =>
    a.id === key || a.title.trim().toLocaleLowerCase('ja') === key.toLocaleLowerCase('ja')
  );
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`提出物が見つかりません: ${key}`);
  throw new Error(`同名の提出物があります。IDで指定してください: ${key}`);
}

const decorateSlot = (state, slot) => ({
  ...slot,
  subjectName: slot.subjectId ? subjectName(state, slot.subjectId) : null,
});

const saveAndNotify = async (state) => {
  const saved = await saveState(state);
  window.dispatchEvent(new CustomEvent('study-bridge-state-changed'));
  return saved;
};

async function execute(action, args = {}) {
  let state = await loadState();
  const today = localDate();

  if (action === 'list_subjects') {
    return state.subjects.map(({ id, name, kind, color }) => ({ id, name, kind, color }));
  }

  if (action === 'get_schedule') {
    const date = args.date || today;
    assertDate(date);
    const schedule = scheduleForDate(state, date);
    return {
      date,
      holiday: schedule.holiday,
      slots: schedule.slots.map((slot) => decorateSlot(state, slot)),
    };
  }

  if (action === 'get_today_plan') {
    const date = args.date || today;
    assertDate(date);
    const schedule = scheduleForDate(state, date);
    const assignments = state.assignments
      .filter((a) => a.status !== '提出済み')
      .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
    const exams = state.exams.filter((exam) =>
      exam.prepStart <= date && (exam.subjects || []).some((row) => row.examDate >= date)
    );
    return {
      date,
      schedule: {
        holiday: schedule.holiday,
        slots: schedule.slots.map((slot) => decorateSlot(state, slot)),
      },
      assignments: assignments.map((a) => ({
        ...a,
        subjectName: a.subjectId ? subjectName(state, a.subjectId) : null,
      })),
      exams: exams.map((exam) => ({
        ...exam,
        subjects: (exam.subjects || []).map((row) => ({
          ...row,
          subjectName: subjectName(state, row.subjectId),
        })),
      })),
      recommendations: recommendationsForDate(state, date).map((x) => ({
        ...x,
        subjectName: x.subjectId ? subjectName(state, x.subjectId) : null,
      })),
    };
  }

  if (action === 'list_assignments') {
    let rows = [...state.assignments];
    if (!args.include_completed) rows = rows.filter((a) => a.status !== '提出済み');
    if (args.status) rows = rows.filter((a) => a.status === args.status);
    rows.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
    return rows.map((a) => ({
      ...a,
      subjectName: a.subjectId ? subjectName(state, a.subjectId) : null,
    }));
  }

  if (action === 'add_assignment') {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('提出物名を指定してください');
    const dueDate = assertDate(args.due_date, 'due_date');
    const subject = args.subject ? resolveSubject(state, args.subject) : null;
    const row = {
      id: uidFor('assignment'),
      title,
      subjectId: subject?.id || null,
      dueDate,
      status: '未着手',
      memo: String(args.memo || '').trim(),
      createdAt: isoNow(),
    };
    state.assignments.push(row);
    await saveAndNotify(state);
    return { ...row, subjectName: subject?.name || null };
  }

  if (action === 'update_assignment') {
    const row = resolveAssignment(state, args.assignment);
    if (args.title !== undefined) {
      const title = String(args.title).trim();
      if (!title) throw new Error('title を空にはできません');
      row.title = title;
    }
    if (args.due_date !== undefined) row.dueDate = assertDate(args.due_date, 'due_date');
    if (args.status !== undefined) {
      if (!assignmentStatuses.has(args.status)) throw new Error('status が不正です');
      row.status = args.status;
    }
    if (args.memo !== undefined) row.memo = String(args.memo);
    if (args.subject !== undefined) row.subjectId = resolveSubject(state, args.subject).id;
    await saveAndNotify(state);
    return {
      ...row,
      subjectName: row.subjectId ? subjectName(state, row.subjectId) : null,
    };
  }

  if (action === 'list_exams') {
    return state.exams.map((exam) => ({
      ...exam,
      subjects: (exam.subjects || []).map((row) => ({
        ...row,
        subjectName: subjectName(state, row.subjectId),
      })),
    }));
  }

  if (action === 'add_exam') {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('テスト名を指定してください');
    const prepStart = assertDate(args.prep_start, 'prep_start');
    if (!Array.isArray(args.subjects) || !args.subjects.length) {
      throw new Error('subjects を1件以上指定してください');
    }
    const rows = args.subjects.map((item) => {
      const subject = resolveSubject(state, item.subject);
      const examDate = assertDate(item.exam_date, 'exam_date');
      if (examDate < prepStart) {
        throw new Error(`${subject.name} の試験日が対策開始日より前です`);
      }
      return {
        subjectId: subject.id,
        examDate,
        range: String(item.range || '').trim(),
      };
    });
    const exam = {
      id: uidFor('exam'),
      name,
      prepStart,
      finalDate: rows.map((x) => x.examDate).sort().at(-1),
      subjects: rows,
      createdAt: isoNow(),
    };
    state.exams.push(exam);
    await saveAndNotify(state);
    return {
      ...exam,
      subjects: rows.map((row) => ({
        ...row,
        subjectName: subjectName(state, row.subjectId),
      })),
    };
  }

  if (action === 'get_recommendations') {
    const date = args.date || today;
    assertDate(date);
    return recommendationsForDate(state, date).map((x) => ({
      ...x,
      subjectName: x.subjectId ? subjectName(state, x.subjectId) : null,
    }));
  }

  if (action === 'add_study_record') {
    const subject = resolveSubject(state, args.subject);
    const date = args.date || today;
    assertDate(date);
    const minutes = Number(args.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('minutes は1以上で指定してください');
    }
    const type = args.type || 'review';
    if (!sessionTypes.has(type)) throw new Error('type が不正です');
    const start = new Date(`${date}T12:00:00+09:00`);
    const end = new Date(start.getTime() + minutes * 60000);
    const session = {
      id: uidFor('session'),
      startedAt: start.toISOString(),
      finishedAt: end.toISOString(),
      type,
      segments: [{
        subjectId: subject.id,
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        type,
      }],
      memo: String(args.memo || '').trim(),
      manual: true,
    };
    state.sessions.push(session);
    await saveAndNotify(state);
    return {
      id: session.id,
      date,
      minutes,
      type,
      subjectId: subject.id,
      subjectName: subject.name,
      memo: session.memo,
    };
  }

  if (action === 'get_statistics') {
    const date = args.date || today;
    assertDate(date);
    const period = args.period || 'day';
    const daily = sessionDurationsByDate(state);
    let start = date;
    if (period === 'week' || period === 'month') start = periodBounds(date, period).start;
    else if (period === 'lifetime') start = state.settings?.firstUseDate || date;
    let totalMs = 0;
    const bySubject = {};
    for (let d = start; d <= date; d = addDays(d, 1)) {
      totalMs += daily[d] || 0;
      for (const [id, ms] of Object.entries(subjectDurations(state, d))) {
        bySubject[id] = (bySubject[id] || 0) + ms;
      }
    }
    return {
      date,
      period,
      start,
      totalMinutes: Math.round(totalMs / 60000),
      streakDays: streakThrough(state, date),
      averageMinutesPerDay: period === 'day'
        ? Math.round((daily[date] || 0) / 60000)
        : Math.round(averageMinutes(state, period === 'lifetime' ? 'lifetime' : period, date)),
      bySubject: Object.entries(bySubject)
        .map(([id, ms]) => ({
          subjectId: id,
          subjectName: subjectName(state, id),
          minutes: Math.round(ms / 60000),
        }))
        .sort((a, b) => b.minutes - a.minutes),
    };
  }

  if (action === 'set_date_override') {
    const date = assertDate(args.date);
    const holiday = Boolean(args.holiday);
    const subjects = args.subjects === undefined
      ? (state.dateOverrides?.[date]?.subjects || [])
      : args.subjects.map((value) => resolveSubject(state, value).id);
    let slots;
    if (Array.isArray(args.slots)) {
      slots = args.slots.map((item, index) => {
        const start = assertTime(item.start, 'start');
        const end = assertTime(item.end, 'end');
        if (start >= end) throw new Error('各時間枠は start < end にしてください');
        const subject = item.subject ? resolveSubject(state, item.subject) : null;
        return {
          start,
          end,
          subjectId: subject?.id || null,
          label: holiday
            ? '休日：復習・資格（50分×3）'
            : index ? '夜の勉強枠' : '日付ごとの勉強枠',
          ...(holiday ? { cycles: 3, study: 50, break: 10 } : {}),
        };
      });
    } else if (holiday) {
      slots = [{
        start: '08:00',
        end: '11:00',
        subjectId: null,
        label: '休日：復習・資格（50分×3）',
        cycles: 3,
        study: 50,
        break: 10,
      }];
    } else {
      slots = scheduleForDate(state, date).slots.map((x) => ({ ...x }));
    }
    state.dateOverrides[date] = { holiday, subjects, slots };
    await saveAndNotify(state);
    return {
      date,
      holiday,
      subjects: subjects.map((id) => ({ id, name: subjectName(state, id) })),
      slots: slots.map((slot) => decorateSlot(state, slot)),
    };
  }

  if (action === 'start_timer') {
    if (state.timer && ['running', 'paused'].includes(state.timer.status)) {
      throw new Error('すでにタイマーが動いています');
    }
    const subject = resolveSubject(state, args.subject);
    const mode = args.mode || 'countdown';
    state.timer = mode === 'stopwatch'
      ? beginStopwatch(subject.id)
      : beginTimer(subject.id);
    state.timer.type = args.type || (mode === 'stopwatch' ? 'stopwatch' : 'review');
    await saveAndNotify(state);
    return {
      status: state.timer.status,
      mode,
      subjectId: subject.id,
      subjectName: subject.name,
      startedAt: state.timer.startedAt,
    };
  }

  if (action === 'pause_timer') {
    if (!state.timer || state.timer.status !== 'running') {
      throw new Error('実行中のタイマーがありません');
    }
    state.timer = pauseTimer(state.timer);
    await saveAndNotify(state);
    return { status: state.timer.status, pausedAt: state.timer.pausedAt };
  }

  if (action === 'resume_timer') {
    if (!state.timer || state.timer.status !== 'paused') {
      throw new Error('一時停止中のタイマーがありません');
    }
    state.timer = resumeTimer(state.timer);
    await saveAndNotify(state);
    return {
      status: state.timer.status,
      subjectName: subjectName(state, state.timer.currentSubjectId),
    };
  }

  if (action === 'finish_timer') {
    if (!state.timer || !['running', 'paused'].includes(state.timer.status)) {
      throw new Error('終了できるタイマーがありません');
    }
    const now = Date.now();
    const elapsedMs = (state.timer.segments || []).reduce((sum, seg) =>
      sum + Math.max(
        0,
        new Date(seg.endedAt || now).getTime() - new Date(seg.startedAt).getTime(),
      ), 0);
    const stopwatch = state.timer.mode === 'stopwatch';
    const minimum = stopwatch ? 60000 : 1800000;
    if (elapsedMs < minimum) {
      throw new Error(stopwatch
        ? 'ストップウォッチは1分以上で記録できます'
        : '30分タイマーは合計30分になるまで終了できません');
    }
    const finished = finishTimer(state.timer);
    const session = createSession(
      { ...finished, type: state.timer.type || (stopwatch ? 'stopwatch' : 'review') },
      String(args.memo || '').trim(),
    );
    state.sessions.push(session);
    state.timer = null;
    await saveAndNotify(state);
    return {
      sessionId: session.id,
      minutes: Math.round(elapsedMs / 60000),
      type: session.type,
      memo: session.memo,
    };
  }

  throw new Error(`未対応のアクションです: ${action}`);
}

async function handleRequest(request) {
  try {
    const result = await execute(request.action, request.args || {});
    await post('/bridge/result', { clientId, requestId: request.id, result });
  } catch (error) {
    await post('/bridge/result', {
      clientId,
      requestId: request.id,
      error: error.message || String(error),
    });
  }
}

async function runBridge() {
  while (true) {
    try {
      await post('/bridge/register', { clientId, href: location.href });
      document.documentElement.dataset.studyBridge = 'connected';
      const { request } = await jsonFetch(
        `/bridge/poll?clientId=${encodeURIComponent(clientId)}`,
      );
      if (request) await handleRequest(request);
      else await sleep(650);
    } catch (_) {
      document.documentElement.dataset.studyBridge = 'disconnected';
      await sleep(2000);
    }
  }
}

runBridge();
