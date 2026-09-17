import {
  UNDERSTANDING, SUBJECT_PRESETS, addDays, averageMinutes, calendarDays, completedUnsubmitted,
  createSession, dayIndex, defaultState, diffDays, finishTimer, formatClock, formatMinutes,
  localDate, normalizeState, pauseTimer, recommendationsForDate, resumeTimer, scheduleForDate,
  sessionDurationsByDate, streakThrough, subjectDurations, subjectName, switchTimerSubject,
  timerBySubject, timerElapsed, timerRemaining, todaySubjects, beginTimer, uidFor, isoNow, periodBounds,
} from './model.js';
import { clearAll, loadState, parseImport, replaceStateWithBackup, saveState, serializeState } from './db.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const JST = 'Asia/Tokyo';
const jpDate = (date) => new Intl.DateTimeFormat('ja-JP', { timeZone: JST, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${date}T00:00:00+09:00`));
const jpTime = (date = new Date()) => new Intl.DateTimeFormat('ja-JP', { timeZone: JST, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
const currentJst = () => localDate(new Date());
const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
const typeLabel = { review: '復習', assignment: '提出物', exam: 'テスト', qualification: '資格' };
let state;
let currentDate = currentJst();
let chosenCandidate = null;
let calendarCursor = (() => { const d = new Date(); return { year: Number(new Intl.DateTimeFormat('en', { timeZone: JST, year: 'numeric' }).format(d)), month: Number(new Intl.DateTimeFormat('en', { timeZone: JST, month: 'numeric' }).format(d)) - 1 }; })();
let taskTab = 'assignments';
let timerInterval = null;
let pendingWorker = null;
let reminderKey = null;
let timerWasUnderMinimum = null;
let datePinned = false;
let chartPeriod = 'month';

function selectDate(date) {
  if (!date) return;
  currentDate = date;
  // Selecting today returns the view to the automatic JST-following mode;
  // selecting another date is an explicit historical view.
  datePinned = date !== currentJst();
}
function followJstDate() {
  if (datePinned) return false;
  const today = currentJst();
  if (currentDate === today) return false;
  currentDate = today;
  chosenCandidate = null;
  renderAll();
  return true;
}

function toast(message, kind = '') { const node = $('#toast'); node.textContent = message; node.className = `toast show ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.className = 'toast'; }, 2600); }
function setOfflineStatus(message, kind = '') { const node = $('#offline-status'); if (!node) return; node.textContent = message; node.className = `offline-status ${kind}`; }
async function persist(message = '保存しました') {
  const status = $('#save-status'); status.textContent = '保存中…';
  try { state = await saveState(state); status.textContent = '端末に保存'; if (message) toast(message); return true; }
  catch (error) { status.textContent = '保存できません'; toast(`保存に失敗しました：${error.message}`, 'error'); return false; }
}
function openModal(title, body, onSubmit = null) {
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = body; $('#modal').classList.remove('hidden');
  $('#modal').dataset.submit = onSubmit ? 'yes' : 'no'; $('#modal').onSubmit = onSubmit;
  const first = $('#modal-body input, #modal-body select, #modal-body textarea, #modal-body button'); first?.focus();
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal').onSubmit = null; }
function confirmModal(title, message, confirmText = '実行する', onConfirm = null) {
  openModal(title, `<p>${esc(message)}</p><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>戻る</button><button type="button" class="primary-button" data-modal-confirm>${esc(confirmText)}</button></div>`);
  $('#modal [data-modal-confirm]').onclick = () => { closeModal(); onConfirm?.(); };
  $('#modal [data-modal-cancel]').onclick = closeModal;
}
async function withFreshTimerSave(fn) { state = fn(state); return persist('保存しました'); }

function applyTheme() {
  const pref = state?.settings?.theme || 'auto'; const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-light', !dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const select = $('#theme-select'); if (select) select.value = pref;
}
function setView(view) {
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active-view', section.id === `view-${view}`));
  if (view === 'calendar') renderCalendar(); if (view === 'tasks') renderTasks(); if (view === 'settings') renderSettings();
  $('#app').focus({ preventScroll: true });
}
function effectiveState() {
  if (!state?.timer || !['running', 'paused'].includes(state.timer.status)) return state;
  const next = { ...state, sessions: [...state.sessions, { id: '__active__', segments: state.timer.segments }] };
  return next;
}
function dailyDurations() { return sessionDurationsByDate(effectiveState()); }
function subjectDurationForDate(date) { return subjectDurations(effectiveState(), date); }
function clockMinutes(value) { const [hour, minute] = String(value || '0:0').split(':').map(Number); return hour * 60 + minute; }
function clockValue(value) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function expandScheduleRows(slots) {
  const rows = [];
  (slots || []).forEach((slot) => {
    if (!slot.cycles) { rows.push({ ...slot, kind: 'study' }); return; }
    const slotEnd = clockMinutes(slot.end); let cursor = clockMinutes(slot.start);
    for (let i = 1; i <= Number(slot.cycles) && cursor < slotEnd; i += 1) {
      const studyEnd = Math.min(slotEnd, cursor + Number(slot.study || 50));
      if (studyEnd <= cursor) break;
      rows.push({ ...slot, start: clockValue(cursor), end: clockValue(studyEnd), label: `${i}回目の勉強`, kind: 'study' });
      cursor = studyEnd;
      if (cursor < slotEnd) {
        const breakEnd = Math.min(slotEnd, cursor + Number(slot.break || 10));
        if (breakEnd > cursor) rows.push({ start: clockValue(cursor), end: clockValue(breakEnd), label: `${slot.break || 10}分休憩`, kind: 'break' });
        cursor = breakEnd;
      }
    }
  });
  return rows;
}

function scheduleRowHtml(row) {
  if (row.kind === 'break') {
    return `<div class="schedule-item"><span class="schedule-time">${row.start}<br><small>${row.end}</small></span><span class="schedule-line"></span><div><strong>休憩の時間</strong><small>画面に休憩を表示しています。再開するときにタイマーを押してください。</small></div></div>`;
  }
  const fixedSubject = row.subjectId ? subjectName(state, row.subjectId) : '';
  const subjectNote = fixedSubject ? `${esc(fixedSubject)}をこの枠に固定しています。` : '教科は始めるときに選べます。';
  const subjectType = state.subjects.find((subject) => subject.id === row.subjectId)?.kind === 'qualification' ? 'qualification' : 'review';
  const startButton = row.subjectId ? `<button type="button" class="schedule-start" data-start-scheduled-subject="${esc(row.subjectId)}" data-start-scheduled-type="${subjectType}">この枠で始める</button>` : '';
  return `<div class="schedule-item"><span class="schedule-time">${row.start}<br><small>${row.end}</small></span><span class="schedule-line"></span><div><strong>${esc(row.label || '勉強枠')}${fixedSubject ? `　${esc(fixedSubject)}` : ''}</strong><small>${subjectNote}</small>${startButton}</div></div>`;
}

function startScheduledSlot(subjectId, type = 'review') {
  const subject = state.subjects.find((item) => item.id === subjectId);
  if (!subject) return toast('固定された教科を確認してください');
  return startCandidate({ id: `scheduled_${currentDate}_${subjectId}`, subjectId, type, title: `${subject.name}の勉強` });
}

function renderToday() {
  const date = currentDate; const dateObject = new Date(`${date}T00:00:00+09:00`); const schedule = scheduleForDate(state, date);
  $('#today-weekday').textContent = dayNames[dayIndex(date)].toUpperCase(); $('#today-date').textContent = jpDate(date); $('#selected-date-label').textContent = date;
  const holidayRows = expandScheduleRows(schedule.slots); const holidayActive = holidayRows.filter((row) => row.kind === 'study').reduce((sum, row) => sum + clockMinutes(row.end) - clockMinutes(row.start), 0); const holidayText = schedule.holiday ? `今日は手動で休日に設定されています。${schedule.slots.map((s) => `${s.start}–${s.end}`).join(' ／ ')}、50分勉強＋10分休憩（実勉強${holidayActive}分：学校の復習${Math.min(75, holidayActive)}分・ITパスポート${Math.max(0, holidayActive - Math.min(75, holidayActive))}分）` : `${schedule.slots.length ? schedule.slots.map((s) => `${s.start}–${s.end}`).join(' ／ ') : '予定枠なし'}${schedule.slots.some((s) => s.cycles) ? '　50分勉強＋10分休憩 × 3' : ''}`;
  $('#schedule-banner').innerHTML = `<span>今日の予定枠</span><span class="muted">${esc(holidayText)}</span>`;
  const recs = recommendationsForDate(state, date); if (!recs.some((x) => x.id === chosenCandidate?.id)) chosenCandidate = recs[0] || null;
  const main = $('#recommendation-content');
  if (chosenCandidate) main.innerHTML = `<div class="recommendation-main"><div class="recommendation-icon">${chosenCandidate.type === 'assignment' ? '✓' : chosenCandidate.type === 'exam' ? '□' : chosenCandidate.type === 'qualification' ? '＋' : '↺'}</div><div><h3>${esc(chosenCandidate.title)}</h3><p>${esc(chosenCandidate.reason)}${chosenCandidate.dueDate ? `　${esc(chosenCandidate.dueDate)}` : ''}</p></div><button class="primary-button" id="start-recommendation" type="button">始める</button></div>`;
  else main.innerHTML = `<div class="recommendation-main"><div class="recommendation-icon">○</div><div><h3>今日の候補を準備しましょう</h3><p>授業の理解度を入力すると、不安な教科から並びます。</p></div><button class="primary-button" id="start-manual" type="button">教科を選んで始める</button></div>`;
  $('#candidate-list').innerHTML = recs.length ? `${recs.slice(0, 8).map((c) => `<button type="button" class="candidate ${c.id === chosenCandidate?.id ? 'selected' : ''}" data-candidate="${esc(c.id)}"><span>${esc(c.title)}</span><span class="type">${typeLabel[c.type] || c.type}</span></button>`).join('')}<button class="text-button candidate-manual" id="start-manual" type="button">教科を選んで始める</button>` : '<p class="muted">時間割に授業の教科を登録すると、復習候補が表示されます。</p>';
  $('#start-recommendation')?.addEventListener('click', () => startCandidate(chosenCandidate));
  $('#start-manual')?.addEventListener('click', openStartSubjectModal);
  $$('#candidate-list [data-candidate]').forEach((button) => button.addEventListener('click', () => { chosenCandidate = recs.find((x) => x.id === button.dataset.candidate) || null; renderToday(); }));
  const durations = dailyDurations(); const rawMs = durations[date] || 0; const mins = Math.floor(rawMs / 60000); const pct = Math.min(100, Math.round(rawMs / 1800000 * 100));
  $('#progress-minutes').textContent = mins; $('#progress-meter').style.width = `${pct}%`; $('#progress-ring').style.setProperty('--progress', `${pct}%`); $('#progress-goal').textContent = mins >= 30 ? '今日の最低ライン達成' : `あと${Math.max(0, 30 - mins)}分で印がつきます`;
  const scheduleRows = expandScheduleRows(schedule.slots); const plannedMinutes = scheduleRows.filter((row) => row.kind === 'study').reduce((sum, row) => sum + clockMinutes(row.end) - clockMinutes(row.start), 0); $('#progress-note').textContent = mins >= 30 ? `よく進みました。予定${plannedMinutes ? ` ${plannedMinutes}分` : ''}の残りは、できる範囲で続けられます。` : `合計30分で今日の印がつきます。${plannedMinutes ? `今日の予定は${plannedMinutes}分です。` : '予定は目安として扱います。'}`;
  $('#week-average').textContent = `${Math.round(averageMinutes(effectiveState(), 'week', date))}分`; $('#month-average').textContent = `${Math.round(averageMinutes(effectiveState(), 'month', date))}分`; $('#streak-mini').textContent = `${streakThrough(effectiveState(), date)}日連続`;
  $('#today-schedule').innerHTML = scheduleRows.length ? scheduleRows.map(scheduleRowHtml).join('') : '<p class="muted">今日は登録された予定枠がありません。</p>';
  $$('[data-start-scheduled-subject]').forEach((button) => button.onclick = () => startScheduledSlot(button.dataset.startScheduledSubject, button.dataset.startScheduledType));
  const now = jpTime(); const breakRow = scheduleRows.find((r) => r.kind === 'break' && now >= r.start && now < r.end); if (breakRow) $('#schedule-banner').innerHTML += `<span class="break-prompt">☕ ${breakRow.start}–${breakRow.end} は休憩です</span>`;
  const attention = [];
  completedUnsubmitted(state).forEach((a) => attention.push(`<div class="attention-item warn"><span class="attention-icon">!</span><div><strong>${esc(a.title)}</strong><span>完成未提出です。提出したら状態を変更しましょう。</span></div></div>`));
  state.assignments.filter((a) => a.status !== '提出済み' && a.status !== '完成未提出' && a.dueDate < date).forEach((a) => attention.push(`<div class="attention-item warn"><span class="attention-icon">⌛</span><div><strong>${esc(a.title)}</strong><span>提出期限 ${esc(a.dueDate)} を過ぎています。</span></div></div>`));
  state.subjects.filter((s) => s.kind === 'school').forEach((s) => { const row = Object.values(state.understanding).filter((x) => x.subjectId === s.id && x.after).sort((a, b) => (b.at || '').localeCompare(a.at || ''))[0]; if (row && row.level !== 'understood') attention.push(`<div class="attention-item"><span class="attention-icon">↺</span><div><strong>${esc(s.name)}を週末に振り返る</strong><span>${esc(UNDERSTANDING.find((u) => u.value === row.level)?.label || '未入力')}が残っています。</span></div></div>`); });
  $('#attention-list').innerHTML = attention.length ? attention.slice(0, 5).join('') : '<p class="muted">今のところ、気にかけることはありません。</p>';
  renderTimerCard();
}
function renderTimerCard() {
  const node = $('#active-timer'); if (!state?.timer || !['running', 'paused'].includes(state.timer.status)) { node.classList.add('hidden'); timerWasUnderMinimum = null; return; }
  node.classList.remove('hidden'); const elapsed = timerElapsed(state.timer); const under = elapsed < 1800000; const current = state.timer.currentSubjectId || state.timer.segments.at(-1)?.subjectId; const options = state.subjects.map((s) => `<option value="${esc(s.id)}" ${s.id === current ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  timerWasUnderMinimum = under;
  node.innerHTML = `<div><p class="eyebrow">${state.timer.status === 'paused' ? 'PAUSED' : 'FOCUS NOW'}</p><h2>${esc(subjectName(state, current))}</h2><span class="timer-mode">${under ? '最低30分までの残り' : '30分を超えて計測中（音なし）'}</span></div><strong class="timer-number">${under ? formatClock(timerRemaining(state.timer)) : `＋${formatClock(Math.max(0, elapsed - 1800000))}`}</strong><div class="timer-buttons"><select id="timer-subject" aria-label="教科を切り替える">${options}</select>${state.timer.status === 'paused' ? '<button id="timer-resume" type="button">再開</button>' : '<button id="timer-pause" type="button">一時停止</button>'}<button id="timer-finish" class="finish" type="button">終了</button><button id="timer-cancel" type="button">中止</button></div>`;
  $('#timer-subject').onchange = () => switchSubject($('#timer-subject').value); $('#timer-pause')?.addEventListener('click', () => changeTimer(pauseTimer(state.timer), '一時停止しました')); $('#timer-resume')?.addEventListener('click', () => changeTimer(resumeTimer(state.timer), '再開しました')); $('#timer-finish').onclick = finishCurrentTimer; $('#timer-cancel').onclick = () => confirmModal('タイマーを中止しますか？', 'このタイマーの記録を破棄します。', '破棄する', async () => { state.timer = null; await persist('タイマーを破棄しました'); renderAll(); });
}
async function changeTimer(next, message) { state.timer = next; await persist(message); renderAll(); }
async function startCandidate(candidate) {
  if (!candidate?.subjectId) { toast('先に教科を選んでください'); return; }
  if (state.timer) { toast('すでにタイマーが動いています'); return; }
  state.timer = beginTimer(candidate.subjectId); state.timer.type = candidate.type; state.timer.segments[0].type = candidate.type; state.timer.candidateId = candidate.id; await persist('タイマーを始めました'); renderAll();
}
function openStartSubjectModal() {
  if (state.timer) return toast('すでにタイマーが動いています');
  openModal('教科を選んで始める', `<div class="form-grid"><div class="form-field"><label for="start-subject">教科・資格</label><select id="start-subject">${subjectOptions()}</select></div><div class="form-field"><label for="start-type">勉強の種類</label><select id="start-type"><option value="review">復習</option><option value="exam">テスト対策</option><option value="qualification">資格</option><option value="assignment">提出物</option></select></div></div><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>キャンセル</button><button type="button" class="primary-button" data-start-manual>始める</button></div>`);
  $('#modal [data-modal-cancel]').onclick = closeModal;
  $('#modal [data-start-manual]').onclick = async () => {
    const subjectId = $('#start-subject').value;
    state.timer = beginTimer(subjectId);
    state.timer.type = $('#start-type').value;
    state.timer.segments[0].type = state.timer.type;
    closeModal();
    await persist('タイマーを始めました');
    renderAll();
  };
}
function switchSubject(subjectId) {
  if (!state.timer || state.timer.status !== 'running') return;
  const old = state.timer.currentSubjectId || state.timer.segments.at(-1)?.subjectId;
  openAfterUnderstanding(old, () => { state.timer = switchTimerSubject(state.timer, subjectId); if (state.timer?.segments.at(-1)) state.timer.segments.at(-1).type = state.timer.type || 'review'; persist('教科を切り替えました').then(renderAll); });
}
async function finishCurrentTimer() {
  if (!state.timer) return; if (timerElapsed(state.timer) < 1800000) { toast('合計30分になるまで終了できません'); return; }
  const finished = finishTimer(state.timer); const memo = '';
  state.sessions.push(createSession({ ...finished, type: state.timer.type }, memo)); state.timer = null; const saved = await persist('勉強時間を記録しました'); if (saved) { renderAll(); openAfterUnderstanding(finished.currentSubjectId || finished.segments.at(-1)?.subjectId, null, localDate(finished.finishedAt)); }
}
function openAfterUnderstanding(subjectId, callback, date = localDate(new Date())) {
  if (!subjectId) { callback?.(); return; }
  const existing = Object.values(state.understanding).filter((x) => x.subjectId === subjectId && x.after).at(-1)?.level;
  openModal(`${subjectName(state, subjectId)}の復習後`, `<p class="muted">いまの理解度を残しておくと、週末のおすすめに活かせます。</p><div class="radio-grid">${UNDERSTANDING.map((u) => `<label><input type="radio" name="after-level" value="${u.value}" ${existing === u.value ? 'checked' : ''}>${u.label}</label>`).join('')}</div><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>あとで</button><button type="button" class="primary-button" data-save-after>保存</button></div>`);
  $('#modal [data-modal-cancel]').onclick = () => { closeModal(); callback?.(); }; $('#modal [data-save-after]').onclick = async () => { const level = $('#modal input[name="after-level"]:checked')?.value; if (!level) return toast('理解度を選んでください'); const id = uidFor('understanding'); state.understanding[id] = { id, date, subjectId, level, after: true, at: isoNow() }; closeModal(); await persist('理解度を記録しました'); callback?.(); renderAll(); };
}
function openUnderstandingModal() {
  const subjects = todaySubjects(state, currentDate); const list = subjects.length ? subjects : state.subjects.filter((s) => s.kind === 'school');
  openModal('今日の授業の理解度', `<p class="muted">授業があった教科ごとに、今の感覚を選びます。不安な教科からおすすめします。</p><div class="understanding-form">${list.map((s) => { const old = Object.values(state.understanding).filter((x) => x.date === currentDate && x.subjectId === s.id && !x.after).at(-1)?.level; return `<div class="form-field"><label>${esc(s.name)}</label><select name="under-${esc(s.id)}"><option value="">未入力</option>${UNDERSTANDING.map((u) => `<option value="${u.value}" ${u.value === old ? 'selected' : ''}>${u.label}</option>`).join('')}</select></div>`; }).join('')}</div><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>キャンセル</button><button type="button" class="primary-button" data-save-understanding>保存</button></div>`);
  $('#modal [data-modal-cancel]').onclick = closeModal; $('#modal [data-save-understanding]').onclick = async () => { list.forEach((s) => { const level = $(`[name="under-${s.id}"]`, $('#modal')).value; if (level) { const id = uidFor('understanding'); state.understanding[id] = { id, date: currentDate, subjectId: s.id, level, after: false, at: isoNow() }; } }); closeModal(); await persist('授業後の理解度を保存しました'); renderAll(); };
}

function renderCalendar() {
  if (!$('#manual-record')) $('#calendar-heading').parentElement.insertAdjacentHTML('afterend', '<button id="manual-record" class="outline-button" type="button">＋ 手動で記録</button>'); const manualButton = $('#manual-record'); if (manualButton && !manualButton.dataset.wired) { manualButton.dataset.wired = 'yes'; manualButton.addEventListener('click', openManualRecordModal); }
  const { year, month } = calendarCursor; const names = ['月', '火', '水', '木', '金', '土', '日']; $('#calendar-month').textContent = `${year}年${month + 1}月`; const data = calendarDays(effectiveState(), year, month); const first = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  $('#calendar-grid').innerHTML = names.map((n) => `<div class="weekday">${n}</div>`).join('') + Array.from({ length: first }, () => '<div class="calendar-cell empty"></div>').join('') + data.map((d) => `<button type="button" class="calendar-cell ${d.completed ? 'done' : d.minutes ? 'partial' : ''} ${d.date === currentDate ? 'today' : ''}" data-calendar-date="${d.date}"><span>${d.day}</span><small class="minutes">${d.minutes ? `${d.minutes}分` : ''}</small></button>`).join('');
  $$('#calendar-grid [data-calendar-date]').forEach((button) => button.onclick = () => { selectDate(button.dataset.calendarDate); setView('today'); renderToday(); });
  const chartRange = periodBounds(currentDate, chartPeriod); const subjectMap = {};
  for (let d = chartRange.start; d <= chartRange.end; d = addDays(d, 1)) Object.entries(subjectDurations(effectiveState(), d)).forEach(([id, ms]) => { subjectMap[id] = (subjectMap[id] || 0) + ms; });
  const chartRows = Object.entries(subjectMap); const max = Math.max(1, ...chartRows.map(([, ms]) => ms));
  const chartLabel = chartPeriod === 'week' ? `今週（${chartRange.start}〜${chartRange.end}）` : `今月（1日から${chartRange.end}まで）`;
  $('#subject-chart-period-label').textContent = chartLabel;
  $$('[data-chart-period]').forEach((button) => { const active = button.dataset.chartPeriod === chartPeriod; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('#subject-chart').innerHTML = chartRows.length ? chartRows.map(([id, ms]) => { const subject = state.subjects.find((s) => s.id === id); return `<div><div class="subject-bar-label"><span>${esc(subject?.name || '科目未設定')}</span><strong>${formatMinutes(ms / 60000)}</strong></div><div class="subject-bar-track"><span style="width:${Math.round(ms / max * 100)}%;background:${esc(subject?.color || '#176b50')}"></span></div></div>`; }).join('') : '<p class="muted">この期間の勉強記録はありません。</p>';
  const total = Object.values(dailyDurations()).reduce((a, b) => a + b, 0); $('#streak-total').textContent = `${streakThrough(effectiveState(), currentDate)}日`; $('#lifetime-total').textContent = formatMinutes(total / 60000); $('#lifetime-average').textContent = `${Math.round(averageMinutes(effectiveState(), 'lifetime', currentDate))}分`; $('#calendar-week-average').textContent = `${Math.round(averageMinutes(effectiveState(), 'week', currentDate))}分 / 日`; $('#calendar-month-average').textContent = `${Math.round(averageMinutes(effectiveState(), 'month', currentDate))}分 / 日`;
  if (!$('#record-history')) $('#view-calendar').insertAdjacentHTML('beforeend', '<article id="record-history" class="panel record-history"><div class="panel-heading"><h2>記録の一覧</h2><span class="muted">教科・種類・メモをあとから修正できます</span></div><div id="record-history-list"></div></article>'); renderRecordHistory();
}
function renderRecordHistory() {
  const list = $('#record-history-list'); if (!list) return; const rows = state.sessions.slice().sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '')).slice(0, 20);
  list.innerHTML = rows.length ? rows.map((session) => { const ms = (session.segments || []).reduce((sum, segment) => sum + Math.max(0, new Date(segment.endedAt).getTime() - new Date(segment.startedAt).getTime()), 0); const first = session.segments?.[0]; const by = {}; (session.segments || []).forEach((segment) => { by[segment.subjectId] = (by[segment.subjectId] || 0) + Math.max(0, new Date(segment.endedAt).getTime() - new Date(segment.startedAt).getTime()); }); const subjects = Object.entries(by).map(([id, value]) => `${subjectName(state, id)} ${formatMinutes(value / 60000)}`).join(' ／ '); return `<div class="record-row"><div><strong>${esc(localDate(session.finishedAt || session.startedAt))}　${esc(subjects || subjectName(state, first?.subjectId))}</strong><small>${esc(typeLabel[session.type] || session.type || '勉強')}　合計${formatMinutes(ms / 60000)}${session.memo ? `　${esc(session.memo)}` : ''}</small></div><button type="button" class="small-button" data-edit-session="${esc(session.id)}">編集</button></div>`; }).join('') : '<p class="muted">勉強を終了すると、ここに記録が残ります。</p>';
  $$('[data-edit-session]').forEach((button) => button.onclick = () => openEditSessionModal(state.sessions.find((s) => s.id === button.dataset.editSession)));
}
function segmentMs(segment) {
  return Math.max(0, new Date(segment.endedAt).getTime() - new Date(segment.startedAt).getTime());
}
function resizeSegmentsBySubject(originalSegments, rows) {
  const targets = new Map();
  rows.forEach((row) => targets.set(row.subjectId, (targets.get(row.subjectId) || 0) + row.minutes * 60000));
  const groups = new Map();
  originalSegments.forEach((segment, index) => {
    const item = { segment, index, ms: segmentMs(segment) };
    if (!groups.has(segment.subjectId)) groups.set(segment.subjectId, []);
    groups.get(segment.subjectId).push(item);
  });
  const resized = [];
  for (const segment of originalSegments) {
    const group = groups.get(segment.subjectId);
    const position = group.findIndex((item) => item.segment === segment);
    const target = targets.get(segment.subjectId) || 0;
    const before = group.slice(0, position).reduce((sum, item) => sum + item.ms, 0);
    // Keep the original segment start and its date boundary. The requested
    // total is allocated in original segment order, then any increase extends
    // the final segment, so no requested minutes disappear.
    const available = Math.max(0, target - before);
    let allocated = Math.min(group[position].ms, available);
    if (position === group.length - 1 && target > before + group[position].ms) allocated = target - before;
    if (allocated <= 0) continue;
    resized.push({ ...segment, endedAt: new Date(new Date(segment.startedAt).getTime() + allocated).toISOString() });
  }
  return resized;
}
function openEditSessionModal(session) {
  if (!session) return; const originalSegments = (session.segments || []).map((segment) => ({ ...segment })); const originalBy = {}; originalSegments.forEach((segment) => { originalBy[segment.subjectId] = (originalBy[segment.subjectId] || 0) + Math.max(0, new Date(segment.endedAt).getTime() - new Date(segment.startedAt).getTime()); }); const entries = Object.entries(originalBy); const total = entries.reduce((sum, [, value]) => sum + value, 0); const date = localDate(session.finishedAt || session.startedAt); const rowHtml = ([subjectId, value], i) => `<div class="edit-segment-row form-grid three" data-edit-segment-row><select data-edit-segment-subject="${i}">${subjectOptions(subjectId)}</select><input data-edit-segment-minutes="${i}" type="number" min="1" step="1" value="${Math.max(1, Math.round(value / 60000))}" aria-label="勉強時間（分）"><span class="muted">分</span><button type="button" class="small-button" data-remove-edit-segment>削除</button></div>`;
  openModal('勉強記録を修正', `<div class="form-grid"><div class="form-grid two"><div class="form-field"><label for="edit-session-date">日付</label><input id="edit-session-date" type="date" value="${date}"></div><div class="form-field"><label>合計</label><strong id="edit-session-total">${Math.round(total / 60000)}分</strong></div></div><div class="form-field"><label>教科別の時間（行を変えると区間を修正）</label><div id="edit-segment-rows">${entries.map(rowHtml).join('')}</div><button type="button" class="small-button" id="add-edit-segment">＋ 教科を追加</button></div><div class="form-field"><label for="edit-session-type">種類</label><select id="edit-session-type"><option value="review" ${session.type === 'review' ? 'selected' : ''}>復習</option><option value="exam" ${session.type === 'exam' ? 'selected' : ''}>テスト対策</option><option value="qualification" ${session.type === 'qualification' ? 'selected' : ''}>資格</option><option value="assignment" ${session.type === 'assignment' ? 'selected' : ''}>提出物</option></select></div><div class="form-field"><label for="edit-session-memo">メモ</label><textarea id="edit-session-memo">${esc(session.memo || '')}</textarea></div><p class="muted">メモや種類だけを変更した場合、元の教科区間と時刻はそのまま保存されます。</p></div><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>キャンセル</button><button type="button" class="primary-button" data-save-session>保存</button></div>`);
  const bindEditRows = () => { $$('#edit-segment-rows [data-remove-edit-segment]').forEach((button) => button.onclick = () => { if ($$('#edit-segment-rows [data-edit-segment-row]').length > 1) { button.closest('[data-edit-segment-row]').remove(); updateEditTotal(); } }); $$('#edit-segment-rows [data-edit-segment-minutes]').forEach((input) => input.oninput = updateEditTotal); };
  const updateEditTotal = () => { const totalMinutes = $$('#edit-segment-rows [data-edit-segment-minutes]').reduce((sum, input) => sum + (Number(input.value) || 0), 0); $('#edit-session-total').textContent = `${totalMinutes}分`; }; bindEditRows(); $('#modal #add-edit-segment').onclick = () => { const i = $$('#edit-segment-rows [data-edit-segment-row]').length; $('#edit-segment-rows').insertAdjacentHTML('beforeend', rowHtml([state.subjects[0]?.id || '', 30 * 60000], i)); bindEditRows(); updateEditTotal(); };
  $('#modal [data-modal-cancel]').onclick = closeModal;
  $('#modal [data-save-session]').onclick = async () => {
    const editDate = $('#edit-session-date').value;
    const rows = $$('#edit-segment-rows [data-edit-segment-row]').map((row) => ({
      subjectId: $('[data-edit-segment-subject]', row).value,
      minutes: Number($('[data-edit-segment-minutes]', row).value),
    }));
    // Every visible row is part of the edit. Do not discard malformed rows,
    // because silently filtering one would make the saved total surprising.
    if (!editDate || !rows.length || rows.some((row) => !state.subjects.some((subject) => subject.id === row.subjectId) || !Number.isFinite(row.minutes) || row.minutes <= 0)) {
      return toast('日付と教科別の時間を確認してください');
    }
    const originalIds = entries.map(([id]) => id);
    const editedIds = rows.map((row) => row.subjectId);
    const sameSubjects = editedIds.length === originalIds.length && editedIds.every((id) => originalIds.includes(id)) && originalIds.every((id) => editedIds.includes(id));
    const oldSignature = entries.map(([id, value]) => `${id}:${Math.round(value / 60000)}`).join('|');
    const newSignature = rows.map((row) => `${row.subjectId}:${Math.round(row.minutes)}`).join('|');
    const dateChanged = editDate !== date;
    if (dateChanged || oldSignature !== newSignature) {
      if (!dateChanged && sameSubjects) {
        session.segments = resizeSegmentsBySubject(originalSegments, rows);
      } else {
        const start = new Date(`${editDate}T12:00:00+09:00`);
        let cursor = start.getTime();
        session.segments = rows.map((row) => {
          const segment = { subjectId: row.subjectId, startedAt: new Date(cursor).toISOString(), endedAt: new Date(cursor + row.minutes * 60000).toISOString(), type: session.type || 'review' };
          cursor += row.minutes * 60000;
          return segment;
        });
      }
      session.startedAt = session.segments[0]?.startedAt || session.startedAt;
      session.finishedAt = session.segments.at(-1)?.endedAt || session.finishedAt;
      if (dateChanged) selectDate(editDate);
    }
    session.type = $('#edit-session-type').value;
    session.segments = session.segments.map((segment) => ({ ...segment, type: session.type }));
    session.memo = $('#edit-session-memo').value.trim();
    closeModal();
    await persist('勉強記録を修正しました');
    renderAll();
  };
}
function renderTasks() {
  $('#task-list').classList.toggle('hidden', taskTab !== 'assignments'); $('#exam-list').classList.toggle('hidden', taskTab !== 'exams');
  $('#task-list').innerHTML = state.assignments.length ? state.assignments.map((a, i) => { const overdue = a.dueDate && a.dueDate < currentDate && a.status !== '提出済み'; return `<div class="task-item"><div class="task-main"><strong>${esc(a.title)}</strong><div class="task-meta ${overdue ? 'overdue' : ''}">${esc(subjectName(state, a.subjectId))}　期限 ${esc(a.dueDate || '未設定')}${overdue ? '　期限超過' : ''}</div></div><select class="task-status" data-status-id="${esc(a.id)}"><option ${a.status === '未着手' ? 'selected' : ''}>未着手</option><option ${a.status === '作業中' ? 'selected' : ''}>作業中</option><option ${a.status === '完成未提出' ? 'selected' : ''}>完成未提出</option><option ${a.status === '提出済み' ? 'selected' : ''}>提出済み</option></select><button type="button" class="icon-button" data-move-task="up" data-task-index="${i}" title="同じ期限内で上へ">↑</button><button type="button" class="icon-button" data-move-task="down" data-task-index="${i}" title="同じ期限内で下へ">↓</button></div>`; }).join('') : '<div class="panel"><p class="muted">提出物はまだありません。期限を登録すると、3日前から今日の候補になります。</p></div>';
  $('#exam-list').innerHTML = state.exams.length ? state.exams.map((exam) => `<div class="task-item"><div class="task-main"><strong>${esc(exam.name)}</strong><div class="task-meta">対策開始 ${esc(exam.prepStart || '未設定')}　教科別試験日：${(exam.subjects || []).map((x) => `${esc(subjectName(state, x.subjectId))} ${esc(x.examDate || '')}${x.range ? `（${esc(x.range)}）` : ''}`).join(' ／ ')}</div></div><button class="small-button" type="button" data-edit-exam="${esc(exam.id)}">編集</button></div>`).join('') : '<div class="panel"><p class="muted">テストを登録すると、対策開始日から候補に入ります。</p></div>';
  $$('[data-status-id]').forEach((select) => select.onchange = async () => { const item = state.assignments.find((a) => a.id === select.dataset.statusId); if (item) { item.status = select.value; await persist('提出物の状態を保存しました'); renderTasks(); renderToday(); } });
   $$('[data-move-task]').forEach((button) => button.onclick = async () => {
     const i = Number(button.dataset.taskIndex); const direction = button.dataset.moveTask === 'up' ? -1 : 1; const dueDate = state.assignments[i]?.dueDate;
     // Move within the same-deadline group even when another deadline is
     // interleaved in the underlying array.
     let to = i + direction;
     while (to >= 0 && to < state.assignments.length && state.assignments[to]?.dueDate !== dueDate) to += direction;
     if (to < 0 || to >= state.assignments.length) return;
     [state.assignments[i], state.assignments[to]] = [state.assignments[to], state.assignments[i]]; await persist('提出物の順番を変更しました'); chosenCandidate = null; renderTasks(); renderToday();
   });
  $$('[data-edit-exam]').forEach((button) => button.onclick = () => openExamModal(state.exams.find((e) => e.id === button.dataset.editExam)));
}

function subjectOptions(selected = '') { return state.subjects.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join(''); }
function timetableSubjectOptions(selected = '') { return `<option value="" ${selected ? '' : 'selected'}>教科を開始時に選ぶ</option>${subjectOptions(selected)}`; }
function openAssignmentModal() {
  openModal('提出物を追加', `<div class="form-grid"><div class="form-field"><label for="assignment-title">提出物の名前</label><input id="assignment-title" required placeholder="例：問題集の提出"></div><div class="form-grid two"><div class="form-field"><label for="assignment-subject">教科</label><select id="assignment-subject">${subjectOptions()}</select></div><div class="form-field"><label for="assignment-due">提出期限</label><input id="assignment-due" type="date" value="${currentDate}" required></div></div><div class="form-field"><label for="assignment-memo">メモ（任意）</label><textarea id="assignment-memo"></textarea></div></div><p class="modal-error hidden" id="form-error"></p><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>キャンセル</button><button type="button" class="primary-button" data-save-assignment>追加する</button></div>`);
  $('#modal [data-modal-cancel]').onclick = closeModal; $('#modal [data-save-assignment]').onclick = async () => { const title = $('#assignment-title').value.trim(); const due = $('#assignment-due').value; if (!title || !due) return toast('名前と期限を入力してください'); state.assignments.push({ id: uidFor('assignment'), title, subjectId: $('#assignment-subject').value, dueDate: due, status: '未着手', memo: $('#assignment-memo').value.trim(), createdAt: isoNow() }); closeModal(); await persist('提出物を追加しました'); renderTasks(); renderToday(); };
}
function openExamModal(existing = null) {
  const subjects = existing?.subjects || state.subjects.filter((s) => s.kind === 'school').slice(0, 3).map((s) => ({ subjectId: s.id, examDate: '', range: '' })); const rowHtml = (x = {}, i = 0) => `<div class="exam-row form-grid three" data-exam-row><select data-exam-subject="${i}">${subjectOptions(x.subjectId)}</select><input data-exam-date="${i}" type="date" value="${esc(x.examDate || '')}" aria-label="試験日"><input data-exam-range="${i}" value="${esc(x.range || '')}" placeholder="範囲（任意）" aria-label="試験範囲"><button type="button" class="small-button" data-remove-exam-row>削除</button></div>`;
  openModal(existing ? 'テストを編集' : 'テストを登録', `<div class="form-grid"><div class="form-field"><label for="exam-name">テストのまとまり</label><input id="exam-name" required value="${esc(existing?.name || '')}" placeholder="例：2学期中間テスト"></div><div class="form-field"><label for="exam-prep">資格枠を切り替える対策開始日</label><input id="exam-prep" type="date" value="${esc(existing?.prepStart || currentDate)}"></div><div class="form-field"><label>教科ごとの試験日・範囲</label><div id="exam-subject-fields">${subjects.map(rowHtml).join('')}</div><button type="button" class="small-button" id="add-exam-row">＋ 教科を追加</button></div></div><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>キャンセル</button><button type="button" class="primary-button" data-save-exam>保存</button></div>`);
  $('#modal [data-modal-cancel]').onclick = closeModal; $('#modal #add-exam-row').onclick = () => { const i = $$('#exam-subject-fields [data-exam-row]').length; $('#exam-subject-fields').insertAdjacentHTML('beforeend', rowHtml({}, i)); bindExamRowRemoval(); }; const bindExamRowRemoval = () => $$('#exam-subject-fields [data-remove-exam-row]').forEach((button) => button.onclick = () => { if ($$('#exam-subject-fields [data-exam-row]').length > 1) button.closest('[data-exam-row]').remove(); }); bindExamRowRemoval();
  $('#modal [data-save-exam]').onclick = async () => { const name = $('#exam-name').value.trim(); const prepStart = $('#exam-prep').value; const rows = $$('#exam-subject-fields [data-exam-row]').map((row) => ({ subjectId: $('[data-exam-subject]', row).value, examDate: $('[data-exam-date]', row).value, range: $('[data-exam-range]', row).value.trim() })).filter((x) => x.subjectId && x.examDate); if (!name || !prepStart || !rows.length || rows.some((x) => x.examDate < prepStart)) return toast('名前、対策開始日、対策開始日以降の試験日を入力してください'); const exam = { id: existing?.id || uidFor('exam'), name, prepStart, finalDate: rows.map((x) => x.examDate).sort().at(-1), subjects: rows, createdAt: existing?.createdAt || isoNow() }; if (existing) Object.assign(existing, exam); else state.exams.push(exam); closeModal(); await persist('テストを保存しました'); renderTasks(); renderToday(); };
}

function renderSettings() {
  $('#subject-settings').innerHTML = state.subjects.map((s) => `<div class="subject-row"><div class="subject-row-main"><i class="subject-id" style="background:${esc(s.color || '#176b50')}"></i><input value="${esc(s.name)}" data-subject-name="${esc(s.id)}" aria-label="${esc(s.name)}の名前"><small>${s.kind === 'qualification' ? '資格' : '学校の教科'}</small></div></div>`).join('');
  const names = ['日', '月', '火', '水', '木', '金', '土'];
  const fallbackSlot = (day) => ({ start: day === 1 ? '16:00' : day >= 2 && day <= 5 ? '17:00' : '08:00', end: day === 0 || day === 6 ? '11:00' : '18:00', label: day === 0 || day === 6 ? '休日：復習・資格（50分×3）' : '帰宅後の復習', ...(day === 0 || day === 6 ? { cycles: 3, study: 50, break: 10 } : {}) });
  $('#timetable-settings').innerHTML = names.map((name, day) => {
    const slots = state.timetable?.[day]?.length ? state.timetable[day] : [fallbackSlot(day)]; const selected = state.classTimetable?.[day] || [];
    const slotHtml = slots.map((slot, index) => `<div class="slot-row" data-slot-row="${day}-${index}"><div class="slot-inputs"><input type="time" data-slot-start="${day}" data-slot-index="${index}" value="${esc(slot.start)}" aria-label="${name}曜日${index + 1}枠の開始"><span>–</span><input type="time" data-slot-end="${day}" data-slot-index="${index}" value="${esc(slot.end)}" aria-label="${name}曜日${index + 1}枠の終了"><button type="button" class="small-button" data-remove-slot="${day}-${index}" ${slots.length === 1 ? 'disabled' : ''}>削除</button></div><label class="slot-subject-field"><span>固定する教科</span><select data-slot-subject="${day}" data-slot-index="${index}" aria-label="${name}曜日${index + 1}枠の固定教科">${timetableSubjectOptions(slot.subjectId)}</select></label></div>`).join('');
    return `<div class="weekday-row"><b>${name}曜日</b><div><div class="day-slots" data-day-slots="${day}">${slotHtml}</div><button type="button" class="small-button add-slot" data-add-slot="${day}">＋ 時間枠</button><select multiple data-class-day="${day}" aria-label="${name}曜日の授業科目" style="width:100%;margin-top:6px;border:1px solid var(--line);border-radius:7px;padding:4px;background:var(--bg);color:var(--ink)">${state.subjects.filter((s) => s.kind === 'school').map((s) => `<option value="${esc(s.id)}" ${selected.includes(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div></div>`;
  }).join('');
  const overrideDates = Object.keys(state.dateOverrides || {}).sort(); $('#override-list').innerHTML = overrideDates.length ? overrideDates.map((date) => { const x = state.dateOverrides[date]; return `<div class="override-chip"><span>${esc(date)}　${x.holiday ? '休日（午前枠）' : `${(x.subjects || []).map((id) => subjectName(state, id)).join('・') || '日付変更'}`}</span><button type="button" class="small-button" data-remove-override="${date}">解除</button></div>`; }).join('') : '<p class="muted">日付ごとの変更はありません。</p>';
  const lastExport = state.settings.lastExportAt ? localDate(state.settings.lastExportAt) : null; const firstUse = state.settings.firstUseDate || currentJst(); const reminderBase = lastExport || firstUse; const daysSinceBase = diffDays(currentJst(), reminderBase); $('#export-reminder').textContent = daysSinceBase >= 7 ? '7日以上書き出していません。端末を移す前にJSONを書き出してください。' : (lastExport ? `最終書き出し：${lastExport}` : `利用開始から${Math.max(0, daysSinceBase)}日目です。7日後から書き出しをお知らせします。`);
  $('#backup-list').innerHTML = state.backups?.length ? state.backups.slice().reverse().map((b) => `<button type="button" class="backup-chip" data-restore-backup="${esc(b.id)}">${esc(localDate(b.createdAt))} のバックアップを復元</button>`).join('') : '<span class="muted">自動バックアップはまだありません。</span>';
  $$('#subject-settings [data-subject-name]').forEach((input) => input.onchange = async () => { const s = state.subjects.find((x) => x.id === input.dataset.subjectName); if (s && input.value.trim()) { s.name = input.value.trim(); await persist('教科名を保存しました'); renderAll(); } });
  const saveDaySlots = async (day) => {
    const rows = $$(`[data-day-slots="${day}"] [data-slot-row]`).map((row) => ({ start: $('[data-slot-start]', row).value, end: $('[data-slot-end]', row).value, subjectId: $('[data-slot-subject]', row).value || null }));
    if (!rows.length || rows.some((row) => !row.start || !row.end || row.start >= row.end)) { toast('時間枠の開始・終了を確認してください'); renderSettings(); return; }
    const existingSlots = state.timetable[day] || [];
    state.timetable[day] = rows.map((row, index) => {
      const previous = existingSlots[index] || {};
      const slot = { ...previous, ...row, label: previous.label || '学習予定' };
      // 50+10 cycles belong only to the old three-hour block. A new 30-minute
      // weekend slot must remain a single study period after later UI edits.
      if (previous.start !== row.start || previous.end !== row.end) {
        delete slot.cycles; delete slot.study; delete slot.break;
      }
      return slot;
    });
    await persist('時間枠を保存しました'); renderAll();
  };
  $$('[data-slot-start], [data-slot-end]').forEach((input) => input.onchange = () => saveDaySlots(input.dataset.slotStart || input.dataset.slotEnd));
  $$('[data-slot-subject]').forEach((select) => select.onchange = () => saveDaySlots(select.dataset.slotSubject));
  $$('[data-add-slot]').forEach((button) => button.onclick = () => { const day = button.dataset.addSlot; const container = $(`[data-day-slots="${day}"]`); const i = $$('[data-slot-row]', container).length; const defaults = i ? { start: '19:30', end: '20:30', label: '夜の勉強枠' } : fallbackSlot(Number(day)); container.insertAdjacentHTML('beforeend', `<div class="slot-row" data-slot-row="${day}-${i}"><div class="slot-inputs"><input type="time" data-slot-start="${day}" data-slot-index="${i}" value="${defaults.start}" aria-label="追加枠の開始"><span>–</span><input type="time" data-slot-end="${day}" data-slot-index="${i}" value="${defaults.end}" aria-label="追加枠の終了"><button type="button" class="small-button" data-remove-slot="${day}-${i}">削除</button></div><label class="slot-subject-field"><span>固定する教科</span><select data-slot-subject="${day}" data-slot-index="${i}" aria-label="追加枠の固定教科">${timetableSubjectOptions()}</select></label></div>`); bindSlotButtons(); });
  const bindSlotButtons = () => $$('[data-remove-slot]').forEach((button) => button.onclick = async () => { const day = button.dataset.removeSlot.split('-')[0]; const rows = $$(`[data-day-slots="${day}"] [data-slot-row]`); if (rows.length <= 1) return; button.closest('[data-slot-row]').remove(); await saveDaySlots(day); });
  bindSlotButtons();
  $$('[data-class-day]').forEach((select) => select.onchange = async () => { state.classTimetable[select.dataset.classDay] = [...select.selectedOptions].map((x) => x.value); await persist('時間割の授業教科を保存しました'); renderToday(); });
  $$('[data-remove-override]').forEach((button) => button.onclick = async () => { delete state.dateOverrides[button.dataset.removeOverride]; await persist('日付の変更を解除しました'); renderSettings(); renderToday(); }); $$('[data-restore-backup]').forEach((button) => button.onclick = () => restoreBackup(button.dataset.restoreBackup));
}
function openSubjectModal() {
  openModal('教科・資格を追加', `<div class="form-grid"><div class="form-field"><label for="new-subject-name">名前</label><input id="new-subject-name" required placeholder="例：情報処理"></div><div class="form-field"><label for="new-subject-kind">種類</label><select id="new-subject-kind"><option value="school">学校の教科</option><option value="qualification">資格</option></select></div></div><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>キャンセル</button><button type="button" class="primary-button" data-save-subject>追加する</button></div>`);
  $('#modal [data-modal-cancel]').onclick = closeModal; $('#modal [data-save-subject]').onclick = async () => { const name = $('#new-subject-name').value.trim(); if (!name) return toast('名前を入力してください'); state.subjects.push({ id: uidFor('subject'), name, kind: $('#new-subject-kind').value, color: '#607d72' }); closeModal(); await persist('教科を追加しました'); renderAll(); };
}
function openDateOverrideModal() {
  const existing = state.dateOverrides[currentDate] || {}; const school = state.subjects.filter((s) => s.kind === 'school');
  const initialHoliday = Boolean(existing.holiday); const holidayDefault = { start: '08:00', end: '11:00', label: '休日：復習・資格（50分×3）', cycles: 3, study: 50, break: 10 };
  const baseSlots = existing.slots?.length ? existing.slots : (initialHoliday ? [holidayDefault] : (state.timetable[dayIndex(currentDate)] || [{ start: '17:00', end: '18:00', label: '日付ごとの勉強枠' }]));
  const selectedSubjects = Array.isArray(existing.subjects) ? existing.subjects : (state.classTimetable?.[dayIndex(currentDate)] || []);
  const slotHtml = (slot, index) => `<div class="slot-row" data-override-slot-row="${index}"><div class="slot-inputs"><input type="time" data-override-start data-slot-index="${index}" value="${esc(slot.start)}" aria-label="この日の${index + 1}枠の開始"><span>–</span><input type="time" data-override-end data-slot-index="${index}" value="${esc(slot.end)}" aria-label="この日の${index + 1}枠の終了"><button type="button" class="small-button" data-remove-override-slot="${index}" ${baseSlots.length === 1 ? 'disabled' : ''}>削除</button></div><label class="slot-subject-field"><span>固定する教科</span><select data-override-subject-slot data-slot-index="${index}" aria-label="この日の${index + 1}枠の固定教科">${timetableSubjectOptions(slot.subjectId)}</select></label></div>`;
  openModal('日付ごとの時間割変更', `<div class="form-grid"><div class="form-field"><label for="override-date">日付</label><input id="override-date" type="date" value="${currentDate}"></div><label class="setting-row"><span><strong>休日として扱う</strong><small>午前8–11時の50分＋10分休憩×3（実勉強150分）</small></span><input id="override-holiday" type="checkbox" ${initialHoliday ? 'checked' : ''}></label><div class="form-field"><label>この日の時間枠</label><div id="override-slot-rows">${baseSlots.map(slotHtml).join('')}</div><button type="button" class="small-button add-slot" data-add-override-slot>＋ 時間枠</button></div><div class="form-field"><label>その日の授業教科</label><div class="check-list">${school.map((s) => `<label><input type="checkbox" data-override-subject="${esc(s.id)}" ${selectedSubjects.includes(s.id) ? 'checked' : ''}>${esc(s.name)}</label>`).join('')}</div></div></div><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>キャンセル</button><button type="button" class="primary-button" data-save-override>保存</button></div>`);
  let holidayTouched = false;
  const renderOverrideSlots = (slots) => { $('#override-slot-rows').innerHTML = slots.map(slotHtml).join(''); bindOverrideSlotButtons(); };
  const readOverrideSlots = () => $$('[data-override-slot-row]', $('#modal')).map((row) => ({ start: $('[data-override-start]', row).value, end: $('[data-override-end]', row).value, subjectId: $('[data-override-subject-slot]', row).value || null }));
  const bindOverrideSlotButtons = () => $$('[data-remove-override-slot]', $('#modal')).forEach((button) => button.onclick = () => { const rows = $$('[data-override-slot-row]', $('#modal')); if (rows.length <= 1) return; button.closest('[data-override-slot-row]').remove(); bindOverrideSlotButtons(); });
  bindOverrideSlotButtons();
  $('#modal [data-add-override-slot]').onclick = () => { const i = $$('[data-override-slot-row]', $('#modal')).length; const start = i ? '19:30' : '17:00'; const end = i ? '20:30' : '18:00'; $('#override-slot-rows').insertAdjacentHTML('beforeend', slotHtml({ start, end }, i)); bindOverrideSlotButtons(); };
  $('#modal #override-holiday').onchange = () => { holidayTouched = true; if ($('#override-holiday').checked && !initialHoliday) renderOverrideSlots([holidayDefault]); else if (!$('#override-holiday').checked && initialHoliday) renderOverrideSlots(state.timetable[dayIndex(currentDate)] || [{ start: '17:00', end: '18:00' }]); };
  $('#modal [data-modal-cancel]').onclick = closeModal; $('#modal [data-save-override]').onclick = async () => { const date = $('#override-date').value; const holiday = $('#override-holiday').checked; const rows = readOverrideSlots(); if (!date || !rows.length || rows.some((row) => !row.start || !row.end || row.start >= row.end)) return toast('日付と時間枠を確認してください'); const subjects = $$('[data-override-subject]:checked', $('#modal')).map((x) => x.dataset.overrideSubject); const previousSlots = existing.slots || baseSlots; const slots = rows.map((row, index) => ({ ...(previousSlots[index] || {}), ...row, label: previousSlots[index]?.label || (holiday ? '休日：復習・資格（50分×3）' : index ? '夜の勉強枠' : '日付ごとの勉強枠'), ...(holiday ? { cycles: 3, study: 50, break: 10 } : {}) })); state.dateOverrides[date] = { holiday, subjects, slots }; selectDate(date); closeModal(); await persist('日付の変更を保存しました'); renderAll(); };
}
function openManualRecordModal() {
  openModal('勉強時間を手動で記録', `<div class="form-grid"><div class="form-grid two"><div class="form-field"><label for="manual-date">日付</label><input id="manual-date" type="date" value="${currentDate}"></div><div class="form-field"><label for="manual-minutes">勉強時間（分）</label><input id="manual-minutes" type="number" min="1" step="1" value="30"></div></div><div class="form-field"><label for="manual-subject">教科・種類</label><select id="manual-subject">${subjectOptions()}</select></div><div class="form-field"><label for="manual-type">種類</label><select id="manual-type"><option value="review">復習</option><option value="exam">テスト対策</option><option value="qualification">資格</option><option value="assignment">提出物</option></select></div><div class="form-field"><label for="manual-memo">メモ（任意）</label><textarea id="manual-memo"></textarea></div></div><div class="modal-actions"><button type="button" class="outline-button cancel" data-modal-cancel>キャンセル</button><button type="button" class="primary-button" data-save-manual>記録する</button></div>`);
  $('#modal [data-modal-cancel]').onclick = closeModal; $('#modal [data-save-manual]').onclick = async () => { const date = $('#manual-date').value; const minutes = Number($('#manual-minutes').value); if (!date || !Number.isFinite(minutes) || minutes <= 0) return toast('日付と時間を確認してください'); const start = new Date(`${date}T12:00:00+09:00`); const end = new Date(start.getTime() + minutes * 60000); const type = $('#manual-type').value; const subjectId = $('#manual-subject').value; state.sessions.push({ id: uidFor('session'), startedAt: start.toISOString(), finishedAt: end.toISOString(), type, segments: [{ subjectId, startedAt: start.toISOString(), endedAt: end.toISOString(), type }], memo: $('#manual-memo').value.trim(), manual: true }); selectDate(date); closeModal(); await persist('手動記録を保存しました'); renderAll(); };
}
async function restoreBackup(id) {
  if (state.timer) return toast('タイマー中は復元できません。終了してから行ってください。'); const item = state.backups.find((x) => x.id === id); if (!item) return; confirmModal('バックアップを復元しますか？', '現在のデータを新しいバックアップとして保存してから置き換えます。', '復元する', async () => { try { state = await replaceStateWithBackup(normalizeState(item.state)); toast('バックアップを復元しました'); renderAll(); } catch (error) { toast(`復元に失敗しました：${error.message}`, 'error'); } });
}
function downloadJson() { state.settings.lastExportAt = isoNow(); const blob = new Blob([serializeState(state)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `study-routine-${currentDate}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); persist('JSONを書き出しました').then(renderSettings); }
function importJsonFile(file) { if (state.timer) return toast('タイマー中は読み込めません。終了してから行ってください。'); const reader = new FileReader(); reader.onload = () => { try { const incoming = parseImport(String(reader.result)); confirmModal('データを置き換えますか？', '現在のデータを自動バックアップしてから、読み込んだJSONですべて置き換えます。', '置き換える', async () => { try { state = await replaceStateWithBackup(incoming); toast('JSONを読み込みました'); renderAll(); } catch (error) { toast(`読み込みに失敗しました：${error.message}`, 'error'); } }); } catch (error) { toast(error.message, 'error'); } }; reader.readAsText(file);
}
function maybeShowReminder() {
  if (document.visibilityState !== 'visible' || !state?.settings?.reminderEnabled || currentDate !== currentJst()) return; const now = jpTime(); const slot = scheduleForDate(state, currentDate).slots.find((x) => x.start === now); if (!slot) return; const key = `${currentDate}:${now}`; if (key === reminderKey) return; reminderKey = key; toast(`勉強の時間です（${now}〜${slot.end}）`);
}
function refreshBreakPrompt() {
  const banner = $('#schedule-banner'); if (!banner) return;
  banner.querySelector('.break-prompt')?.remove();
  if (currentDate !== currentJst()) return;
  const now = jpTime(); const rows = expandScheduleRows(scheduleForDate(state, currentDate).slots); const breakRow = rows.find((row) => row.kind === 'break' && now >= row.start && now < row.end);
  if (breakRow) banner.insertAdjacentHTML('beforeend', `<span class="break-prompt">☕ ${breakRow.start}–${breakRow.end} は休憩です</span>`);
}
function refreshLiveStats() {
  if (!state) return;
  const live = effectiveState(); const durations = dailyDurations(); const raw = durations[currentDate] || 0; const mins = Math.floor(raw / 60000); const pct = Math.min(100, Math.round(raw / 1800000 * 100));
  if ($('#progress-minutes')) $('#progress-minutes').textContent = mins;
  if ($('#progress-meter')) $('#progress-meter').style.width = `${pct}%`;
  if ($('#progress-ring')) $('#progress-ring').style.setProperty('--progress', `${pct}%`);
  if ($('#progress-goal')) $('#progress-goal').textContent = mins >= 30 ? '今日の最低ライン達成' : `あと${Math.max(0, 30 - mins)}分で印がつきます`;
  if ($('#week-average')) $('#week-average').textContent = `${Math.round(averageMinutes(live, 'week', currentDate))}分`;
  if ($('#month-average')) $('#month-average').textContent = `${Math.round(averageMinutes(live, 'month', currentDate))}分`;
  if ($('#streak-mini')) $('#streak-mini').textContent = `${streakThrough(live, currentDate)}日連続`;
  if ($('#streak-total')) $('#streak-total').textContent = `${streakThrough(live, currentDate)}日`;
  if ($('#lifetime-total')) $('#lifetime-total').textContent = formatMinutes(Object.values(durations).reduce((sum, value) => sum + value, 0) / 60000);
  if ($('#lifetime-average')) $('#lifetime-average').textContent = `${Math.round(averageMinutes(live, 'lifetime', currentDate))}分`;
  if ($('#calendar-week-average')) $('#calendar-week-average').textContent = `${Math.round(averageMinutes(live, 'week', currentDate))}分 / 日`;
  if ($('#calendar-month-average')) $('#calendar-month-average').textContent = `${Math.round(averageMinutes(live, 'month', currentDate))}分 / 日`;
}
function openLongTimerPrompt() {
  if (!state.timer || !['running', 'paused'].includes(state.timer.status) || timerElapsed(state.timer) <= 6 * 3600000) return;
  openModal('長時間タイマーを確認してください', '<p>前回保存から6時間以上経過しています。続ける場合はそのまま再開できます。確かな時間に直す場合は、修正して記録できます。</p><div class="modal-actions"><button type="button" class="outline-button" data-long-correct>修正する</button><button type="button" class="primary-button" data-long-continue>続ける</button></div>');
  $('#modal [data-long-continue]').onclick = async () => { state.timer.reopenCheckedAt = isoNow(); closeModal(); await persist('タイマーを続けます'); renderAll(); };
  $('#modal [data-long-correct]').onclick = openTimerCorrectionModal;
}
function openTimerCorrectionModal() {
  const timer = state.timer; if (!timer) return; const date = localDate(timer.startedAt); const subject = timer.currentSubjectId || timer.segments.at(-1)?.subjectId;
  openModal('計測時間を修正', `<p class="muted">長時間開いたままになっていました。確かな時間に直して記録できます。</p><div class="form-grid"><div class="form-grid two"><div class="form-field"><label for="correct-date">日付</label><input id="correct-date" type="date" value="${date}"></div><div class="form-field"><label for="correct-minutes">確かな勉強時間（分）</label><input id="correct-minutes" type="number" min="1" value="${Math.max(1, Math.floor(timerElapsed(timer) / 60000))}"></div></div><div class="form-field"><label for="correct-subject">教科</label><select id="correct-subject">${subjectOptions(subject)}</select></div><div class="form-field"><label for="correct-memo">メモ（任意）</label><textarea id="correct-memo">長時間タイマーを修正</textarea></div></div><div class="modal-actions"><button type="button" class="outline-button cancel" data-correct-cancel>タイマーを残す</button><button type="button" class="primary-button" data-save-correction>修正して記録</button></div>`);
  $('#modal [data-correct-cancel]').onclick = closeModal; $('#modal [data-save-correction]').onclick = async () => { const editDate = $('#correct-date').value; const minutes = Number($('#correct-minutes').value); if (!editDate || !Number.isFinite(minutes) || minutes <= 0) return toast('日付と時間を確認してください'); const start = new Date(`${editDate}T12:00:00+09:00`); const end = new Date(start.getTime() + minutes * 60000); const type = timer.type || 'review'; const subjectId = $('#correct-subject').value; state.sessions.push({ id: uidFor('session'), startedAt: start.toISOString(), finishedAt: end.toISOString(), type, manual: true, memo: $('#correct-memo').value.trim(), segments: [{ subjectId, startedAt: start.toISOString(), endedAt: end.toISOString(), type }] }); state.timer = null; selectDate(editDate); closeModal(); await persist('計測時間を修正して記録しました'); renderAll(); };
}

function renderAll() { applyTheme(); renderToday(); renderCalendar(); renderTasks(); renderSettings(); }
function wireEvents() {
  $$('.nav-item').forEach((button) => button.onclick = () => setView(button.dataset.view)); $('#theme-toggle').onclick = () => { const order = ['auto', 'light', 'dark']; state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length]; persist('テーマを変更しました').then(applyTheme); }; $('#theme-select').onchange = async () => { state.settings.theme = $('#theme-select').value; await persist('テーマを保存しました'); applyTheme(); }; $('#reminder-toggle').onchange = async () => { state.settings.reminderEnabled = $('#reminder-toggle').checked; await persist('お知らせ設定を保存しました'); }; $('#open-understanding').onclick = openUnderstandingModal; $('#edit-today-schedule').onclick = openDateOverrideModal; $('#date-picker-button').onclick = () => openModal('日付を選ぶ', `<div class="form-field"><label for="jump-date">表示する日付</label><input id="jump-date" type="date" value="${currentDate}"></div><div class="modal-actions"><button type="button" class="primary-button" data-jump-date>表示する</button></div>`); $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); }); $('#modal-close').onclick = closeModal; $('#add-assignment').onclick = openAssignmentModal; $('#add-exam').onclick = () => openExamModal(); $('#add-subject').onclick = openSubjectModal; $('#add-date-override').onclick = openDateOverrideModal; $('#manual-record')?.addEventListener('click', openManualRecordModal); $('#prev-month').onclick = () => { calendarCursor.month -= 1; if (calendarCursor.month < 0) { calendarCursor.month = 11; calendarCursor.year -= 1; } renderCalendar(); }; $('#next-month').onclick = () => { calendarCursor.month += 1; if (calendarCursor.month > 11) { calendarCursor.month = 0; calendarCursor.year += 1; } renderCalendar(); }; $$('.section-tab').forEach((button) => button.onclick = () => { taskTab = button.dataset.taskTab; $$('.section-tab').forEach((x) => x.classList.toggle('active', x === button)); renderTasks(); }); $$('[data-chart-period]').forEach((button) => button.onclick = () => { chartPeriod = button.dataset.chartPeriod === 'week' ? 'week' : 'month'; renderCalendar(); }); $('#export-data').onclick = downloadJson; $('#import-data').onclick = () => $('#import-file').click(); $('#import-file').onchange = () => { if ($('#import-file').files[0]) importJsonFile($('#import-file').files[0]); $('#import-file').value = ''; }; $('#app-update').onclick = updateApp; $('#modal').addEventListener('click', (e) => { if (e.target.id === 'jump-date' && e.target.value) { /* handled by button below */ } if (e.target.matches('[data-jump-date]')) { selectDate($('#jump-date').value || currentDate); closeModal(); renderAll(); } });
}
async function updateApp() {
  if (state.timer && ['running', 'paused'].includes(state.timer.status)) return toast('タイマー中は更新を適用できません。終了してから行ってください。');
  if (pendingWorker) { pendingWorker.postMessage({ type: 'SKIP_WAITING' }); setOfflineStatus('更新を適用中…'); toast('更新を適用しています…'); return; }
  try { await navigator.serviceWorker?.ready; await navigator.serviceWorker?.getRegistration().then((registration) => registration?.update()); setOfflineStatus('更新を確認しました'); toast('更新を確認しました'); }
  catch (_) { setOfflineStatus('更新を確認できませんでした', 'error'); toast('更新を確認できませんでした'); }
}
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) { setOfflineStatus('オフライン準備なし', 'error'); return; }
  setOfflineStatus('オフライン準備中');
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    const markWaiting = (worker) => { if (!worker) return; pendingWorker = worker; if (navigator.serviceWorker.controller) { setOfflineStatus('更新があります'); toast('新しい更新があります。↻で適用できます。'); } };
    // A waiting worker can already exist before this page is opened.
    if (registration.waiting) markWaiting(registration.waiting);
    registration.addEventListener('updatefound', () => { const worker = registration.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) markWaiting(worker); }); });
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    const readyRegistration = await navigator.serviceWorker.ready;
    if (readyRegistration.waiting) markWaiting(readyRegistration.waiting);
    if (!pendingWorker) setOfflineStatus('オフライン準備完了');
  } catch (_) {
    // Local file previews and restricted browsers can still use the app data;
    // expose the unavailable offline layer instead of silently hiding it.
    setOfflineStatus('オフライン準備を確認できません', 'error');
  }
}
async function init() {
  try {
    state = await loadState();
    // Persist the generated defaults once so firstUseDate and the initial
    // snapshot survive the first reload. __fresh is non-enumerable metadata
    // from loadState and disappears when saveState clones the state.
    if (state.__fresh) state = await saveState(state);
  }
  catch (error) { document.body.innerHTML = `<main style="max-width:640px;margin:20vh auto;padding:24px;font-family:system-ui"><h1>データを読み込めません</h1><p>保存領域の読み込みに失敗しました。ページを閉じず、保存領域を確認してから再読み込みしてください。</p><p style="color:#a44">${esc(error.message)}</p></main>`; return; }
  wireEvents(); document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') return; if (!followJstDate()) { refreshBreakPrompt(); refreshLiveStats(); } maybeShowReminder(); }); $('#reminder-toggle').checked = state.settings.reminderEnabled; renderAll(); await registerServiceWorker();
  if (state.timer && ['running', 'paused'].includes(state.timer.status) && timerElapsed(state.timer) > 6 * 3600000) openLongTimerPrompt();
  clearInterval(timerInterval); timerInterval = setInterval(() => { const followed = followJstDate(); if (!followed) refreshBreakPrompt(); if (state?.timer) { const elapsedNow = timerElapsed(state.timer); const isUnder = elapsedNow < 1800000; const timerNumber = $('.timer-number'); if (timerNumber) timerNumber.textContent = isUnder ? formatClock(timerRemaining(state.timer)) : `＋${formatClock(Math.max(0, elapsedNow - 1800000))}`; if (timerWasUnderMinimum !== null && timerWasUnderMinimum !== isUnder) { renderToday(); renderCalendar(); } const durations = dailyDurations(); const raw = durations[currentDate] || 0; const mins = Math.floor(raw / 60000); $('#progress-minutes').textContent = mins; $('#progress-meter').style.width = `${Math.min(100, Math.round(raw / 1800000 * 100))}%`; $('#progress-ring').style.setProperty('--progress', `${Math.min(100, Math.round(raw / 1800000 * 100))}%`); } maybeShowReminder(); }, 1000);
}
init();

export { effectiveState, renderToday, renderCalendar, renderTasks, renderSettings };
