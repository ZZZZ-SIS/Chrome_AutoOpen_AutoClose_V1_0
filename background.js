'use strict';

// MV3 Service Worker：两个任务互不干扰，各自计时、启动、暂停与恢复。
// 原 V2.1 的设置键保留：升级时沿用网址、间隔、打开模式等数据。
const OPEN_SETTINGS_KEY = 'timerSettingsV2';
const OPEN_RUNNER_KEY = 'timerRunnerV2';
const OPEN_JOBS_KEY = 'timerOpenJobsV2';
const REFRESH_SETTINGS_KEY = 'timerRefreshSettingsV3';
const REFRESH_RUNNER_KEY = 'timerRefreshRunnerV3';
const LOGS_KEY = 'timerLogsV3';
const LOG_VISIBLE_KEY = 'timerLogsVisibleV3';
const OPEN_ALARM = 'timer:repeat';
const REFRESH_ALARM = 'timer:refresh';
const CLOSE_PREFIX = 'timer:close:';
const MAX_URLS = 20;
const MAX_OPEN_JOBS = 30;
const MAX_LOGS = 500;

const DEFAULT_OPEN = Object.freeze({
  urls: ['https://www.facebook.com/'],
  intervalMinutes: 5,
  closeSeconds: 5,
  mode: 'tab',
  multiMode: 'all',
  resumeAfterRestart: false
});
const DEFAULT_OPEN_RUNNER = Object.freeze({
  running: false, nextAt: null, runCount: 0, totalOpened: 0,
  rotationIndex: 0, lastAt: null, lastOpened: 0, lastError: ''
});
const DEFAULT_REFRESH = Object.freeze({intervalSeconds: 60, scope: 'window'});
const DEFAULT_REFRESH_RUNNER = Object.freeze({
  running: false, nextAt: null, refreshCount: 0, totalRefreshed: 0,
  lastAt: null, lastRefreshed: 0, lastError: '',
  tabId: null, windowId: null, tabTitle: '', windowLabel: ''
});

const closeTimers = new Map();
let queue = Promise.resolve();
function serial(fn) {
  const task = queue.then(fn, fn);
  queue = task.catch(error => console.error('[定时网页插件]', safeErrorText(error)));
  return task;
}

function errorText(error) {return error instanceof Error ? error.message : String(error);}
// 日志只展示网站来源，不保存 URL 路径、查询参数及片段中的潜在凭据。
function siteLabel(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '[非网页地址]';
  } catch (_) {return '[网址已隐藏]';}
}
function safeLogMessage(value) {
  return String(value)
    .replace(/(?:https?:\/\/|www\.)[^\s<>"'，。；）)\]]+/gi, matched =>
      /^https?:\/\//i.test(matched) ? siteLabel(matched) : '[网址已隐藏]')
    .replace(/\b(?:access_token|refresh_token|auth_token|api[_-]?key|password|secret|session[_-]?id)\s*[=:]\s*[^\s&;，。]+/gi, '[敏感字段已隐藏]')
    .slice(0, 950);
}
function safeErrorText(error) {
  return safeLogMessage(errorText(error)).slice(0, 240);
}
async function appendLog(type, message, level = 'info') {
  const data = await chrome.storage.local.get(LOGS_KEY);
  const logs = Array.isArray(data[LOGS_KEY]) ? data[LOGS_KEY] : [];
  logs.unshift({id: crypto.randomUUID(), at: Date.now(), type, level, message: safeLogMessage(message)});
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  await chrome.storage.local.set({[LOGS_KEY]: logs});
}

function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('请输入目标网址。');
  const original = input.trim();
  const raw = /^[a-zA-Z][\w+.-]*:\/\//.test(original) ? original : `https://${original}`;
  let url;
  try { url = new URL(raw); } catch (_) {throw new Error('网址格式有误：' + original);}
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('只支持 HTTP 或 HTTPS 网址：' + original);
  }
  return url.href;
}
function validateOpen(input) {
  if (!input || typeof input !== 'object') throw new Error('打开设置格式不正确。');
  const rawUrls = Array.isArray(input.urls) ? input.urls : String(input.urls || '').split(/\r?\n/);
  const urls = [...new Set(rawUrls.map(x => String(x).trim()).filter(Boolean).map(normalizeUrl))];
  if (!urls.length || urls.length > MAX_URLS) throw new Error('请输入 1–20 个网址，每行一个。');
  const intervalMinutes = Number(input.intervalMinutes);
  const closeSeconds = Number(input.closeSeconds);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new Error('打开间隔必须是 1–1440 分钟的整数。');
  }
  if (!Number.isInteger(closeSeconds) || closeSeconds < 1 || closeSeconds > 3600) {
    throw new Error('关闭延时必须是 1–3600 秒的整数。');
  }
  if (!['tab', 'window'].includes(input.mode)) throw new Error('请选择有效的打开方式。');
  if (!['all', 'rotate'].includes(input.multiMode)) throw new Error('请选择有效的多个网址模式。');
  return {urls, intervalMinutes, closeSeconds, mode: input.mode,
    multiMode: input.multiMode, resumeAfterRestart: input.resumeAfterRestart === true};
}
async function getOpenSettings() {
  const stored = await chrome.storage.local.get([OPEN_SETTINGS_KEY, 'url', 'mode']);
  if (stored[OPEN_SETTINGS_KEY]) {
    try {return validateOpen(stored[OPEN_SETTINGS_KEY]);} catch (error) {console.warn('旧设置无效', error);}
  }
  const copy = {...DEFAULT_OPEN, urls: [...DEFAULT_OPEN.urls]};
  if (stored.url) {try {copy.urls = [normalizeUrl(stored.url)];} catch (_) { /* ignore */ }}
  if (['tab', 'window'].includes(stored.mode)) copy.mode = stored.mode;
  return copy;
}
async function getOpenRunner() {
  const data = await chrome.storage.local.get(OPEN_RUNNER_KEY);
  return {...DEFAULT_OPEN_RUNNER, ...(data[OPEN_RUNNER_KEY] || {})};
}
async function getRefreshSettings() {
  const data = await chrome.storage.local.get(REFRESH_SETTINGS_KEY);
  try {return validateRefresh(data[REFRESH_SETTINGS_KEY] || DEFAULT_REFRESH);}
  catch (_) {return {...DEFAULT_REFRESH};}
}
function validateRefresh(input) {
  if (!input || typeof input !== 'object') throw new Error('刷新设置格式不正确。');
  const intervalSeconds = Number(input.intervalSeconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 86400) {
    throw new Error('刷新间隔必须为 30–86400 秒（最短 30 秒）。');
  }
  if (!['tab', 'window'].includes(input.scope)) throw new Error('请选择当前标签页或当前窗口所有网页。');
  return {intervalSeconds, scope: input.scope};
}
async function getRefreshRunner() {
  const data = await chrome.storage.local.get(REFRESH_RUNNER_KEY);
  return {...DEFAULT_REFRESH_RUNNER, ...(data[REFRESH_RUNNER_KEY] || {})};
}
async function setBadge() {
  const [open, refresh] = await Promise.all([getOpenRunner(), getRefreshRunner()]);
  const number = Number(open.running) + Number(refresh.running);
  await chrome.action.setBadgeText({text: number ? String(number) : ''});
  if (number) await chrome.action.setBadgeBackgroundColor({color: '#0b9a86'});
}
async function putOpenRunner(runner) {
  await chrome.storage.local.set({[OPEN_RUNNER_KEY]: runner});
  await setBadge();
}
async function putRefreshRunner(runner) {
  await chrome.storage.local.set({[REFRESH_RUNNER_KEY]: runner});
  await setBadge();
}
async function armOpen(runner) {
  if (!runner.running) return chrome.alarms.clear(OPEN_ALARM);
  await chrome.alarms.create(OPEN_ALARM, {when: Math.max(Date.now() + 1000, runner.nextAt || Date.now() + 60000)});
}
async function armRefresh(runner) {
  if (!runner.running) return chrome.alarms.clear(REFRESH_ALARM);
  await chrome.alarms.create(REFRESH_ALARM, {when: Math.max(Date.now() + 1000, runner.nextAt || Date.now() + 60000)});
}
async function getJobs() {
  return (await chrome.storage.session.get(OPEN_JOBS_KEY))[OPEN_JOBS_KEY] || {};
}
async function putJobs(jobs) {
  await chrome.storage.session.set({[OPEN_JOBS_KEY]: jobs});
}
async function disarmJob(jobId) {
  clearTimeout(closeTimers.get(jobId));
  closeTimers.delete(jobId);
  await chrome.alarms.clear(CLOSE_PREFIX + jobId);
  const jobs = await getJobs();
  const job = jobs[jobId];
  if (!job) return null;
  delete jobs[jobId];
  await putJobs(jobs);
  return job;
}
async function closeJob(jobId) {
  const job = await disarmJob(jobId);
  if (!job) return;
  try {
    if (job.mode === 'window') await chrome.windows.remove(job.targetId);
    else await chrome.tabs.remove(job.targetId);
    await appendLog('open', `自动关闭成功：${siteLabel(job.url)}（${job.closeSeconds} 秒后）`, 'success');
  } catch (error) {
    await appendLog('open', `关闭失败或网页已提前关闭：${siteLabel(job.url)} · ${safeErrorText(error)}`, 'warn');
  }
}
function armCloseTimer(job) {
  clearTimeout(closeTimers.get(job.id));
  closeTimers.delete(job.id);
  const milliseconds = job.closeAt - Date.now();
  if (milliseconds <= 30000) {
    const timer = setTimeout(() => {
      closeTimers.delete(job.id);
      serial(() => closeJob(job.id));
    }, Math.max(0, milliseconds));
    closeTimers.set(job.id, timer);
  }
}
async function registerJob(url, mode, targetId, seconds) {
  const job = {
    id: crypto.randomUUID(), url, mode, targetId,
    closeSeconds: seconds, closeAt: Date.now() + seconds * 1000
  };
  const jobs = await getJobs();
  jobs[job.id] = job;
  try {
    await putJobs(jobs);
    // MV3 闹钟在 Chrome 120+ 至少 30 秒一次；内存秒级计时 + 闹钟兜底。
    await chrome.alarms.create(CLOSE_PREFIX + job.id, {
      when: Math.max(Date.now() + 30000, job.closeAt)
    });
    armCloseTimer(job);
  } catch (error) {
    await disarmJob(job.id);
    throw error;
  }
}
async function openOne(url, settings) {
  let targetId;
  if (settings.mode === 'window') {
    const win = await chrome.windows.create({url, type: 'popup', focused: false, state: 'minimized'});
    targetId = win?.id;
  } else {
    // 不激活标签页，不尝试将 Chrome 浏览器置前。
    const tab = await chrome.tabs.create({url, active: false});
    targetId = tab?.id;
  }
  if (!Number.isInteger(targetId)) throw new Error('Chrome 未返回有效页面编号。');
  try {
    await registerJob(url, settings.mode, targetId, settings.closeSeconds);
  } catch (error) {
    try {
      if (settings.mode === 'window') await chrome.windows.remove(targetId);
      else await chrome.tabs.remove(targetId);
    } catch (_) { /* ignore */ }
    throw error;
  }
  await appendLog('open', `后台打开成功：${siteLabel(url)}；${settings.closeSeconds} 秒后关闭`, 'success');
}
async function doOpenCycle() {
  const settings = await getOpenSettings();
  const old = await getOpenRunner();
  const jobs = await getJobs();
  const selected = settings.multiMode === 'rotate'
    ? [settings.urls[old.rotationIndex % settings.urls.length]]
    : settings.urls;
  const free = Math.max(0, MAX_OPEN_JOBS - Object.keys(jobs).length);
  let opened = 0;
  let lastError = '';
  for (const url of selected.slice(0, free)) {
    try {await openOne(url, settings); opened++;}
    catch (error) {
      lastError = `打开 ${siteLabel(url)} 失败：${safeErrorText(error)}`;
      await appendLog('open', lastError, 'error');
    }
  }
  if (free < selected.length) {
    lastError = `临时页面上限 ${MAX_OPEN_JOBS} 个，本轮跳过 ${selected.length - free} 个。`;
    await appendLog('open', lastError, 'warn');
  }
  const state = await getOpenRunner();
  Object.assign(state, {
    runCount: state.runCount + 1,
    totalOpened: state.totalOpened + opened,
    lastAt: Date.now(), lastOpened: opened, lastError,
    rotationIndex: (old.rotationIndex + (settings.multiMode === 'rotate' ? 1 : 0)) % settings.urls.length
  });
  await putOpenRunner(state);
  await appendLog('open', `打开任务第 ${state.runCount} 轮完成：成功 ${opened}/${selected.length} 个`, lastError ? 'warn' : 'info');
}
async function saveOpen(input) {
  const settings = validateOpen(input);
  await chrome.storage.local.set({[OPEN_SETTINGS_KEY]: settings});
  const state = await getOpenRunner();
  if (state.running) {
    state.nextAt = Date.now() + settings.intervalMinutes * 60000;
    state.rotationIndex = 0;
    await putOpenRunner(state);
    await armOpen(state);
  }
  await appendLog('open', `打开设置已保存：${settings.urls.length} 个网址，每 ${settings.intervalMinutes} 分钟打开，${settings.closeSeconds} 秒后关闭`, 'info');
}
async function startOpen(input) {
  await saveOpen(input);
  const state = await getOpenRunner();
  if (state.running) return;
  Object.assign(state, DEFAULT_OPEN_RUNNER, {running: true, nextAt: Date.now() + (await getOpenSettings()).intervalMinutes * 60000});
  await putOpenRunner(state);
  await armOpen(state);
  await appendLog('open', '打开任务已启动：立即执行首轮，之后按间隔循环', 'success');
  await doOpenCycle();
}
async function stopOpen(note = '用户停止') {
  const state = await getOpenRunner();
  const wasRunning = state.running;
  state.running = false;
  state.nextAt = null;
  await putOpenRunner(state);
  await chrome.alarms.clear(OPEN_ALARM);
  if (wasRunning) await appendLog('open', `打开任务已停止：${note}；已打开页面仍会按时关闭`, 'warn');
}
async function tickOpen() {
  const state = await getOpenRunner();
  if (!state.running) return;
  const settings = await getOpenSettings();
  state.nextAt = Date.now() + settings.intervalMinutes * 60000;
  await putOpenRunner(state);
  await armOpen(state);
  await doOpenCycle();
}

function isWebTab(tab) {
  return !!(tab && Number.isInteger(tab.id) && /^https?:\/\//i.test(tab.url || ''));
}
async function saveRefresh(input) {
  const settings = validateRefresh(input);
  const previous = await getRefreshSettings();
  const runner = await getRefreshRunner();
  if (runner.running && previous.scope !== settings.scope) {
    throw new Error('刷新任务运行中不能切换目标类型，请先停止再选择。');
  }
  await chrome.storage.local.set({[REFRESH_SETTINGS_KEY]: settings});
  if (runner.running) {
    runner.nextAt = Date.now() + settings.intervalSeconds * 1000;
    await putRefreshRunner(runner);
    await armRefresh(runner);
  }
  await appendLog('refresh', `刷新设置已保存：${settings.scope === 'tab' ? '固定标签页' : '当前窗口所有网页'}，每 ${settings.intervalSeconds} 秒刷新`, 'info');
}
async function getTarget(selection, scope) {
  if (!selection || !Number.isInteger(selection.windowId) || !Number.isInteger(selection.tabId)) {
    throw new Error('无法定位当前浏览器标签页。请在需要刷新的浏览器窗口中打开本插件。');
  }
  const window = await chrome.windows.get(selection.windowId);
  if (window.type !== 'normal') throw new Error('只能刷新普通 Chrome 窗口中的网页。');
  const tab = await chrome.tabs.get(selection.tabId);
  if (tab.windowId !== window.id || !tab.active) throw new Error('当前标签页发生变化，请重新启动刷新任务。');
  if (scope === 'tab' && !isWebTab(tab)) throw new Error('当前标签不是 HTTP/HTTPS 网页，无法定时刷新。');
  return {windowId: window.id, tabId: tab.id, tabTitle: siteLabel(tab.url), windowLabel: `窗口 #${window.id}`};
}
async function startRefresh(input, selection) {
  const settings = validateRefresh(input);
  const runner = await getRefreshRunner();
  if (runner.running) return;
  const target = await getTarget(selection, settings.scope);
  await saveRefresh(settings);
  const state = {...DEFAULT_REFRESH_RUNNER, ...target, running: true,
    nextAt: Date.now() + settings.intervalSeconds * 1000};
  await putRefreshRunner(state);
  await armRefresh(state);
  await appendLog('refresh', `刷新任务已启动：${settings.scope === 'tab' ? '固定标签页：' + target.tabTitle : target.windowLabel + ' 的所有网页'}，每 ${settings.intervalSeconds} 秒`, 'success');
}
async function stopRefresh(note = '用户停止') {
  const runner = await getRefreshRunner();
  const wasRunning = runner.running;
  runner.running = false;
  runner.nextAt = null;
  await putRefreshRunner(runner);
  await chrome.alarms.clear(REFRESH_ALARM);
  if (wasRunning) await appendLog('refresh', `刷新任务已停止：${note}`, 'warn');
}
async function refreshCycle(selection = null, onceOnly = false) {
  const settings = await getRefreshSettings();
  let runner = await getRefreshRunner();
  let effective = runner;
  if (onceOnly && !runner.running) effective = await getTarget(selection, settings.scope);
  if (!onceOnly && !runner.running) return;

  let tabs = [];
  let fatal = '';
  if (settings.scope === 'tab') {
    try {
      const tab = await chrome.tabs.get(effective.tabId);
      if (tab.windowId !== effective.windowId) throw new Error('目标标签页已移至其他窗口');
      tabs = [tab];
    } catch (error) {fatal = `目标标签页已关闭或不可访问：${safeErrorText(error)}`;}
  } else {
    try {
      await chrome.windows.get(effective.windowId);
      tabs = await chrome.tabs.query({windowId: effective.windowId});
    } catch (error) {fatal = `目标浏览器窗口已关闭：${safeErrorText(error)}`;}
  }
  if (fatal) {
    await appendLog('refresh', fatal, 'error');
    if (runner.running) await stopRefresh('目标网页/窗口不存在');
    if (onceOnly) throw new Error(fatal);
    return;
  }
  const temporary = new Set(Object.values(await getJobs()).filter(j => j.mode === 'tab').map(j => j.targetId));
  let refreshed = 0;
  let skipped = 0;
  let lastError = '';
  for (const tab of tabs) {
    if (!isWebTab(tab) || temporary.has(tab.id)) {skipped++; continue;}
    try {
      await chrome.tabs.reload(tab.id); // 不激活目标标签，不抢占焦点
      refreshed++;
      await appendLog('refresh', `已刷新：${siteLabel(tab.url)}`, 'success');
    } catch (error) {
      lastError = `刷新失败：${siteLabel(tab.url)} · ${safeErrorText(error)}`;
      await appendLog('refresh', lastError, 'error');
    }
  }
  if (onceOnly && !runner.running) {
    await appendLog('refresh', `手动刷新完成：成功 ${refreshed} 页、跳过 ${skipped} 页`, 'info');
    return;
  }
  runner = await getRefreshRunner();
  runner.refreshCount += 1;
  runner.totalRefreshed += refreshed;
  runner.lastAt = Date.now();
  runner.lastRefreshed = refreshed;
  runner.lastError = lastError;
  await putRefreshRunner(runner);
  await appendLog('refresh', `刷新任务第 ${runner.refreshCount} 轮完成：刷新 ${refreshed} 页，跳过 ${skipped} 页`, lastError ? 'warn' : 'info');
}
async function tickRefresh() {
  const runner = await getRefreshRunner();
  if (!runner.running) return;
  const settings = await getRefreshSettings();
  runner.nextAt = Date.now() + settings.intervalSeconds * 1000;
  await putRefreshRunner(runner);
  await armRefresh(runner);
  await refreshCycle();
}
async function restoreJobs() {
  const jobs = await getJobs();
  for (const job of Object.values(jobs)) {
    if (Date.now() >= job.closeAt) {await closeJob(job.id); continue;}
    if (!await chrome.alarms.get(CLOSE_PREFIX + job.id)) {
      await chrome.alarms.create(CLOSE_PREFIX + job.id, {
        when: Math.max(Date.now() + 30000, job.closeAt)
      });
    }
    armCloseTimer(job);
  }
}
async function restoreAlarms() {
  await restoreJobs();
  const [open, refresh] = await Promise.all([getOpenRunner(), getRefreshRunner()]);
  if (open.running && !await chrome.alarms.get(OPEN_ALARM)) await armOpen(open);
  if (refresh.running && !await chrome.alarms.get(REFRESH_ALARM)) await armRefresh(refresh);
  await setBadge();
}
async function handleStartup() {
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) if (alarm.name.startsWith(CLOSE_PREFIX)) await chrome.alarms.clear(alarm.name);
  for (const timer of closeTimers.values()) clearTimeout(timer);
  closeTimers.clear();
  await chrome.storage.session.remove(OPEN_JOBS_KEY);
  const open = await getOpenRunner();
  const settings = await getOpenSettings();
  if (open.running && settings.resumeAfterRestart) {
    open.nextAt = Date.now() + settings.intervalMinutes * 60000;
    await putOpenRunner(open);
    await armOpen(open);
    await appendLog('open', 'Chrome 重启：打开任务已自动恢复', 'success');
    await doOpenCycle();
  } else {
    await stopOpen('浏览器已重启');
  }
  // 浏览器重启后标签 ID 会变化，不使用旧 ID 误刷新别的网页。
  await stopRefresh('浏览器重启后需要重新选择刷新目标');
  await restoreAlarms();
}
async function getState(includeLogs = false) {
  await restoreAlarms();
  const [settings, runner, refreshSettings, refreshRunner, jobs, preferences] = await Promise.all([
    getOpenSettings(), getOpenRunner(), getRefreshSettings(), getRefreshRunner(), getJobs(),
    chrome.storage.local.get(LOG_VISIBLE_KEY)
  ]);
  const result = {settings, runner, refreshSettings, refreshRunner,
    activeJobs: Object.keys(jobs).length,
    logsVisible: preferences[LOG_VISIBLE_KEY] !== false};
  if (includeLogs) result.logs = (await chrome.storage.local.get(LOGS_KEY))[LOGS_KEY] || [];
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // 当前产品只有 popup.html 会向后台发送指令；权限操作仅接受此受信任页面。
  if (!sender || sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) return false;
  if (!message || typeof message !== 'object' || typeof message.action !== 'string') return false;
  const allowed = [
    'GET_STATE', 'SAVE_OPEN', 'START_OPEN', 'STOP_OPEN', 'RUN_OPEN_ONCE',
    'SAVE_REFRESH', 'START_REFRESH', 'STOP_REFRESH', 'RUN_REFRESH_ONCE',
    'SET_LOG_VISIBLE', 'CLEAR_LOGS'
  ];
  if (!allowed.includes(message.action)) return false;
  serial(async () => {
    switch (message.action) {
      case 'GET_STATE': return getState(message.includeLogs === true);
      case 'SAVE_OPEN': await saveOpen(message.settings); break;
      case 'START_OPEN': await startOpen(message.settings); break;
      case 'STOP_OPEN': await stopOpen(); break;
      case 'RUN_OPEN_ONCE':
        await saveOpen(message.settings);
        await appendLog('open', '用户手动执行打开任务一次');
        await doOpenCycle();
        break;
      case 'SAVE_REFRESH': await saveRefresh(message.settings); break;
      case 'START_REFRESH': await startRefresh(message.settings, message.selection); break;
      case 'STOP_REFRESH': await stopRefresh(); break;
      case 'RUN_REFRESH_ONCE':
        await saveRefresh(message.settings);
        await appendLog('refresh', '用户手动执行刷新一次');
        await refreshCycle(message.selection, true);
        break;
      case 'SET_LOG_VISIBLE':
        await chrome.storage.local.set({[LOG_VISIBLE_KEY]: message.visible === true});
        break;
      case 'CLEAR_LOGS':
        await chrome.storage.local.set({[LOGS_KEY]: []});
        break;
    }
    return getState(message.includeLogs === true);
  }).then(data => respond({ok: true, ...data}))
    .catch(async error => {
      try {await appendLog('system', `${message.action} 执行失败：${safeErrorText(error)}`, 'error');}
      catch (other) {console.warn('写日志失败', other);}
      respond({ok: false, error: safeErrorText(error)});
    });
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === OPEN_ALARM) serial(tickOpen);
  else if (alarm.name === REFRESH_ALARM) serial(tickRefresh);
  else if (alarm.name.startsWith(CLOSE_PREFIX)) {
    serial(() => closeJob(alarm.name.slice(CLOSE_PREFIX.length)));
  }
});
async function untrackRemoved(mode, targetId) {
  const jobs = await getJobs();
  for (const job of Object.values(jobs)) {
    if (job.mode !== mode || job.targetId !== targetId) continue;
    await disarmJob(job.id);
    await appendLog('open', `临时网页被手动关闭：${siteLabel(job.url)}`, 'warn');
  }
}
chrome.tabs.onRemoved.addListener(tabId => {serial(async () => {
  await untrackRemoved('tab', tabId);
  const runner = await getRefreshRunner();
  const settings = await getRefreshSettings();
  if (runner.running && settings.scope === 'tab' && runner.tabId === tabId) {
    await stopRefresh('目标标签页被关闭');
  }
});});
chrome.windows.onRemoved.addListener(windowId => {serial(async () => {
  await untrackRemoved('window', windowId);
  const runner = await getRefreshRunner();
  if (runner.running && runner.windowId === windowId) await stopRefresh('目标窗口被关闭');
});});
chrome.runtime.onStartup.addListener(() => {serial(handleStartup);});
chrome.runtime.onInstalled.addListener(({reason}) => {serial(async () => {
  await restoreAlarms();
  if (reason === 'install') await appendLog('system', '插件安装完成：打开/关闭与自动刷新独立运行，日志保存在本机', 'success');
  else if (reason === 'update') await appendLog('system', '插件更新完成：沿用旧版已保存的打开网址和时间设置', 'success');
});});
// storage.local 默认也可供内容脚本访问。未来即使增加内容脚本，也不暴露网址与日志。
serial(async () => {
  try {
    await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  } catch (error) {
    // 访问限制配置异常不应让现有定时任务完全停止；最低 Chrome 版本已支持此 API。
    console.warn('存储访问限制设置失败：', safeErrorText(error));
  }
  await restoreAlarms();
});
