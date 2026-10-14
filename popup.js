'use strict';
const $ = id => document.getElementById(id);
let state = null;
let busy = false;
let initialized = false;
let lastLogs = [];
let savedLogVisible = true;

function chosen(name) {return document.querySelector(`input[name="${name}"]:checked`)?.value;}
function choose(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}
function feedback(id, message, level = 'info') {
  const node = $(id);
  node.textContent = message;
  node.className = 'feedback ' + level;
}
function remaining(ts) {
  if (!ts) return '--:--';
  let s = Math.max(0, Math.ceil((ts - Date.now()) / 1000));
  const hours = Math.floor(s / 3600); s %= 3600;
  const mins = Math.floor(s / 60); s %= 60;
  return hours ? `${hours}时${mins}分${s}秒` : `${mins}分${s}秒`;
}
function readOpen() {
  const urls = $('urls-input').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!urls.length || urls.length > 20) throw new Error('请输入 1–20 个目标网址。');
  const intervalMinutes = Number($('open-interval').value);
  const closeSeconds = Number($('close-delay').value);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error('打开间隔为 1–1440 分钟。');
  if (!Number.isInteger(closeSeconds) || closeSeconds < 1 || closeSeconds > 3600) throw new Error('自动关闭时间为 1–3600 秒。');
  return {urls, intervalMinutes, closeSeconds, mode: chosen('openMode'),
    multiMode: chosen('multiMode'), resumeAfterRestart: $('resume-input').checked};
}
function fillOpen(settings) {
  $('urls-input').value = settings.urls.join('\n');
  $('open-interval').value = settings.intervalMinutes;
  $('close-delay').value = settings.closeSeconds;
  choose('openMode', settings.mode);
  choose('multiMode', settings.multiMode);
  $('resume-input').checked = !!settings.resumeAfterRestart;
}
function readRefresh() {
  const number = Number($('refresh-interval').value);
  const unit = $('refresh-unit').value;
  if (!Number.isInteger(number) || number < 1) throw new Error('刷新间隔必须是正整数。');
  const seconds = unit === 'minutes' ? number * 60 : number;
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86400) {
    throw new Error('刷新间隔范围为 30 秒到 24 小时。');
  }
  return {intervalSeconds: seconds, scope: chosen('refreshScope')};
}
function fillRefresh(settings) {
  choose('refreshScope', settings.scope);
  const useMinutes = settings.intervalSeconds % 60 === 0;
  $('refresh-unit').value = useMinutes ? 'minutes' : 'seconds';
  $('refresh-interval').value = useMinutes ? settings.intervalSeconds / 60 : settings.intervalSeconds;
  updateRefreshNumberBounds();
}
function updateRefreshNumberBounds() {
  const minutes = $('refresh-unit').value === 'minutes';
  $('refresh-interval').min = minutes ? 1 : 30;
  $('refresh-interval').max = minutes ? 1440 : 86400;
}
async function selectTarget() {
  const win = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({active: true, windowId: win.id});
  if (!tab) throw new Error('无法找到当前窗口的网页标签。');
  return {windowId: win.id, tabId: tab.id};
}
async function request(action, extra = {}) {
  const result = await chrome.runtime.sendMessage({action, ...extra, includeLogs: savedLogVisible});
  if (!result || !result.ok) throw new Error(result?.error || '插件后台没有响应，请重新打开插件。');
  state = result;
  render();
  return result;
}
function setBusy(flag) {busy = flag; render();}
async function doAction(action, section) {
  if (busy) return;
  const own = section === 'open';
  try {
    const settings = own ? (['STOP_OPEN'].includes(action) ? null : readOpen())
      : (['STOP_REFRESH'].includes(action) ? null : readRefresh());
    const selection = !own && ['START_REFRESH', 'RUN_REFRESH_ONCE'].includes(action)
      ? await selectTarget() : null;
    setBusy(true);
    feedback(own ? 'open-feedback' : 'refresh-feedback', '正在执行，请稍候…');
    const result = await request(action, {settings, selection});
    if (settings) (own ? fillOpen : fillRefresh)(own ? result.settings : result.refreshSettings);
    if (own) {
      const words = {
        SAVE_OPEN: '✓ 打开设置已保存。', START_OPEN: '✓ 打开循环已启动，首轮已执行。',
        STOP_OPEN: '✓ 已停止后续打开；现有临时页仍会按时关闭。',
        RUN_OPEN_ONCE: `✓ 已打开 ${result.runner.lastOpened} 个网页，等待自动关闭。`
      };
      feedback('open-feedback', words[action], 'success');
    } else {
      const words = {
        SAVE_REFRESH: '✓ 刷新设置已保存。', START_REFRESH: '✓ 刷新任务已启动，等待首次计时。',
        STOP_REFRESH: '✓ 自动刷新已停止。', RUN_REFRESH_ONCE: '✓ 已执行一次刷新，请查看下面的日志。'
      };
      feedback('refresh-feedback', words[action], 'success');
    }
  } catch (error) {
    feedback(own ? 'open-feedback' : 'refresh-feedback', '⚠ ' + error.message, 'error');
  } finally {setBusy(false);}
}
function render() {
  if (!state) return;
  const {runner, refreshRunner, activeJobs} = state;
  $('open-pill').textContent = runner.running ? '● 运行中' : '已停止';
  $('open-pill').classList.toggle('on', runner.running);
  $('refresh-pill').textContent = refreshRunner.running ? '● 运行中' : '已停止';
  $('refresh-pill').classList.toggle('on', refreshRunner.running);
  $('open-next').textContent = runner.running ? remaining(runner.nextAt) : '--:--';
  $('open-count').textContent = String(runner.runCount || 0);
  $('open-active').textContent = String(activeJobs || 0);
  $('refresh-next').textContent = refreshRunner.running ? remaining(refreshRunner.nextAt) : '--:--';
  $('refresh-count').textContent = String(refreshRunner.refreshCount || 0);
  $('refresh-total').textContent = String(refreshRunner.totalRefreshed || 0);
  $('refresh-target').textContent = refreshRunner.running
    ? (state.refreshSettings.scope === 'tab'
      ? `✓ 目标已固定：${refreshRunner.tabTitle || `标签 #${refreshRunner.tabId}`}（不随切换标签改变）`
      : `✓ 目标已固定：Chrome ${refreshRunner.windowLabel} 的所有网页标签（不含插件临时页）`)
    : '尚未绑定刷新目标；请在目标 Chrome 窗口中点击“开始刷新”。';
  for (const [id, disabled] of Object.entries({
    'open-start': runner.running, 'open-stop': !runner.running,
    'refresh-start': refreshRunner.running, 'refresh-stop': !refreshRunner.running,
    'open-save': false, 'open-once': false, 'refresh-save': false, 'refresh-once': false
  })) $(id).disabled = busy || disabled;
  $('log-number').textContent = String((state.logs || lastLogs).length);
  if (state.logs) {lastLogs = state.logs; renderLogs();}
}
function formatLogTime(at) {
  return new Date(at).toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'});
}
function renderLogs() {
  if (!savedLogVisible) return;
  const filter = $('log-filter').value;
  const chosenLogs = filter === 'all' ? lastLogs : lastLogs.filter(log => log.type === filter);
  const list = $('log-list');
  list.replaceChildren();
  if (!chosenLogs.length) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = '暂无匹配的日志记录。';
    list.append(empty);
    return;
  }
  for (const log of chosenLogs.slice(0, 120)) {
    const line = document.createElement('div');
    line.className = 'log-entry ' + (['error', 'warn'].includes(log.level) ? log.level : '');
    const time = document.createElement('time');
    time.className = 'log-when';
    time.textContent = formatLogTime(log.at);
    const body = document.createElement('div');
    body.className = 'log-content-area';
    const kind = document.createElement('span');
    kind.className = 'log-kind ' + (log.type === 'refresh' ? 'refresh' : log.type === 'system' ? 'system' : '');
    kind.textContent = log.type === 'open' ? '打开 / 关闭' : log.type === 'refresh' ? '自动刷新' : '系统';
    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = log.message;
    body.append(kind, message);
    line.append(time, body);
    list.append(line);
  }
}
function applyLogVisibility(visible) {
  savedLogVisible = visible;
  $('log-content').hidden = !visible;
  $('toggle-logs').textContent = visible ? '隐藏日志 ↑' : '显示日志 ↓';
  $('toggle-logs').setAttribute('aria-expanded', String(visible));
  if (visible) renderLogs();
}

$('open-save').addEventListener('click', () => doAction('SAVE_OPEN', 'open'));
$('open-start').addEventListener('click', () => doAction('START_OPEN', 'open'));
$('open-stop').addEventListener('click', () => doAction('STOP_OPEN', 'open'));
$('open-once').addEventListener('click', () => doAction('RUN_OPEN_ONCE', 'open'));
$('refresh-save').addEventListener('click', () => doAction('SAVE_REFRESH', 'refresh'));
$('refresh-start').addEventListener('click', () => doAction('START_REFRESH', 'refresh'));
$('refresh-stop').addEventListener('click', () => doAction('STOP_REFRESH', 'refresh'));
$('refresh-once').addEventListener('click', () => doAction('RUN_REFRESH_ONCE', 'refresh'));
$('refresh-unit').addEventListener('change', updateRefreshNumberBounds);
$('log-filter').addEventListener('change', renderLogs);
$('toggle-logs').addEventListener('click', async () => {
  const visible = !savedLogVisible;
  try {
    // 先切换显示，再保存 preference；折叠不阻止后台写入日志。
    applyLogVisibility(visible);
    await request('SET_LOG_VISIBLE', {visible, includeLogs: visible});
  } catch (error) {applyLogVisibility(!visible);}
});
$('clear-logs').addEventListener('click', async () => {
  if (!confirm('确定清空全部执行日志吗？清空后无法恢复。')) return;
  try {
    const result = await request('CLEAR_LOGS');
    lastLogs = result.logs || [];
    renderLogs();
  } catch (error) {feedback('refresh-feedback', '清空日志失败：' + error.message, 'error');}
});

async function boot() {
  try {
    const result = await request('GET_STATE', {includeLogs: true});
    if (!initialized) {
      fillOpen(result.settings);
      fillRefresh(result.refreshSettings);
      applyLogVisibility(result.logsVisible);
      initialized = true;
    }
  } catch (error) {
    feedback('open-feedback', '无法连接到插件后台：' + error.message, 'error');
  }
}
boot();
setInterval(render, 1000);
setInterval(async () => {
  if (!busy) {
    try {await request('GET_STATE');} catch (_) { /* Chrome service worker might restart */ }
  }
}, 3000);
