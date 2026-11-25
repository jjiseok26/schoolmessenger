'use strict';
const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Windows 알림 상단에 영문 앱 이름 대신 바로가기 이름(학교메신저)이 표시되도록 설정
app.setAppUserModelId('kr.school.messenger.client');

let win = null;
let tray = null;
let quitting = false;
let pendingUpdateUrl = null;     // 자동 업데이트 다운로드 중인 URL
let pendingUpdateVersion = '';   // 내려받는 중인 버전
let updateReady = null;          // { path, version } 설치 준비 완료된 업데이트
let installingUpdate = false;    // 설치 프로그램을 이미 띄웠는지 (중복 실행 방지)
const pendingSaves = new Map();  // 첨부 주소 → 저장 완료를 기다리는 요청 { resolve, reject }

function verNewer(a, b) { // a > b ?
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
// 이미 적용된(현재 버전 이하) 업데이트 설치파일을 임시 폴더에서 정리
function cleanOldUpdateFiles() {
  try {
    const dir = app.getPath('temp');
    for (const f of fs.readdirSync(dir)) {
      const m = /^SchoolMessenger-Update-(\d+\.\d+\.\d+)\.exe$/.exec(f);
      if (m && !verNewer(m[1], app.getVersion())) fs.unlink(path.join(dir, f), () => {});
    }
  } catch (e) {}
}

// 무음 설치 후 자동 재실행 (재시작 버튼) / 종료 시 무음 설치만 (다음 실행 때 새 버전)
// /S=무음, --updated=실행 중인 앱이 스스로 종료되길 기다린 뒤 진행, --force-run=설치 후 앱 실행
function installUpdate(relaunch) {
  if (!updateReady || installingUpdate) return false;
  if (!fs.existsSync(updateReady.path)) { updateReady = null; return false; }
  installingUpdate = true;
  const args = ['/S', '--updated'];
  if (relaunch) args.push('--force-run');
  try {
    const child = require('child_process').spawn(updateReady.path, args, {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
  } catch (e) {
    installingUpdate = false;
    dialog.showErrorBox('업데이트 실패', '설치 프로그램을 실행하지 못했습니다.\n' + e.message);
    return false;
  }
  quitting = true;
  app.quit(); // 설치 프로그램이 앱 종료를 기다렸다가 파일을 교체함
  return true;
}

// 중복 실행 방지: 이미 실행 중이면 기존 창을 앞으로
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => showWindow());
}

// ---------- 첨부파일 저장 폴더 (기본: 문서\schoolmessenger) ----------
let settings = {};
function settingsPath() { return path.join(app.getPath('userData'), 'client-settings.json'); }
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (e) { settings = {}; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 1)); } catch (e) {}
}
function defaultDownloadDir() {
  return path.join(app.getPath('documents'), 'schoolmessenger');
}
// 저장 폴더 안에서 겹치지 않는 파일 경로 (같은 이름이 있으면 "이름 (1).확장자" 처럼 숫자를 붙임)
function uniqueSavePath(name) {
  const dir = downloadDir();
  const parsed = path.parse(path.basename(String(name || 'file')) || 'file');
  let candidate = parsed.base, n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${parsed.name} (${n++})${parsed.ext}`;
  }
  return path.join(dir, candidate);
}

function downloadDir() {
  const dir = settings.downloadDir || defaultDownloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); return dir; }
  catch (e) {
    // 설정 폴더를 못 쓰면 기본 위치로 대체
    const fb = defaultDownloadDir();
    try { fs.mkdirSync(fb, { recursive: true }); } catch (e2) {}
    return fb;
  }
}

function createWindow() {
  // 작은 화면에서는 화면 크기에 맞춰 축소 (작업표시줄 제외 영역 기준)
  const { width: sw, height: sh } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1320, sw - 40),   // 버튼 글자가 아이콘으로 축약되지 않는 너비 (축약 기준 1100px)
    height: Math.min(820, sh - 60),
    minWidth: 900,
    minHeight: 600,
    title: '학교메신저',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // 쪽지 속 링크는 기본 웹 브라우저로 열기 (첨부파일 다운로드 /files/ 는 예외)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    try { if (new URL(url).pathname.startsWith('/files/')) return; } catch (err) {}
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  // 창을 닫아도 트레이에서 계속 실행 (알림 수신 유지)
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); win.focus(); }
}

let trayBaseImage = null;

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  trayBaseImage = img;
  tray = new Tray(img);
  tray.setToolTip('학교메신저');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: showWindow },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWindow);
}

app.whenReady().then(() => {
  loadSettings();
  setTimeout(cleanOldUpdateFiles, 15000); // 설치 프로그램이 완전히 끝난 뒤 정리
  // 설치 후 첫 실행: Windows 시작 시 자동 실행 기본 켜기 (이후엔 설정에서 변경 가능)
  const initFlag = path.join(app.getPath('userData'), '.autostart-init');
  if (app.isPackaged && !fs.existsSync(initFlag)) {
    app.setLoginItemSettings({ openAtLogin: true });
    try { fs.writeFileSync(initFlag, '1'); } catch (e) {}
  }
  session.defaultSession.on('will-download', (e, item) => {
    // GitHub 는 실제 파일 주소로 넘겨 주므로 거쳐 온 주소 목록까지 확인
    if (pendingUpdateUrl && (item.getURL() === pendingUpdateUrl || item.getURLChain().includes(pendingUpdateUrl))) {
      // 자동 업데이트: 백그라운드로 내려받고, 완료되면 "재시작" 안내만 표시 (강제 종료 없음)
      pendingUpdateUrl = null;
      const version = pendingUpdateVersion;
      const savePath = path.join(app.getPath('temp'), `SchoolMessenger-Update-${version || Date.now()}.exe`);
      item.setSavePath(savePath);
      const dlId = 'update-' + Date.now();
      const sendProgress = (state) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('download-progress', {
            id: dlId, name: `새 버전 v${version} 내려받는 중`,
            path: savePath, state, isUpdate: true,
            received: item.getReceivedBytes(), total: item.getTotalBytes()
          });
        }
      };
      sendProgress('progressing');
      item.on('updated', (ev, state) => sendProgress(state));
      item.once('done', (ev, state) => {
        sendProgress(state);
        if (state === 'completed') {
          updateReady = { path: savePath, version };
          if (win && !win.isDestroyed()) win.webContents.send('update-ready', { version });
        } else {
          pendingUpdateVersion = '';
          if (win && !win.isDestroyed()) win.webContents.send('update-failed', { version });
        }
      });
      return;
    }
    // 일반 첨부파일: 다운로드 폴더에 자동 저장 (같은 이름이 있으면 숫자 붙임) + 진행률 표시
    const waiter = pendingSaves.get(item.getURL()); // 열기/폴더 열기를 기다리는 요청
    if (waiter) pendingSaves.delete(item.getURL());
    const savePath = uniqueSavePath(item.getFilename() || 'file');
    const candidate = path.basename(savePath);
    item.setSavePath(savePath);
    const dlId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const srcUrl = item.getURL();
    const sendProgress = (state) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('download-progress', {
          id: dlId, name: candidate, path: savePath, state, url: srcUrl,
          received: item.getReceivedBytes(), total: item.getTotalBytes()
        });
      }
    };
    sendProgress('progressing');
    item.on('updated', (ev, state) => sendProgress(state));
    item.once('done', (ev, state) => {
      sendProgress(state);
      if (!waiter) return;
      if (state === 'completed') waiter.resolve(savePath);
      else waiter.reject(new Error('다운로드가 완료되지 않았습니다.'));
    });
  });
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // 트레이 상주: 창이 없어도 알림 수신을 위해 계속 실행
});
app.on('before-quit', () => {
  quitting = true;
  // 준비된 업데이트가 있는데 사용자가 그냥 종료하면 조용히 설치 (다음 실행 때 새 버전)
  if (updateReady && !installingUpdate) {
    installingUpdate = true;
    try {
      const child = require('child_process').spawn(updateReady.path, ['/S', '--updated'], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      child.unref();
    } catch (e) {}
  }
});

ipcMain.handle('get-version', () => app.getVersion());
// 새 버전 자동 다운로드 시작 (이미 준비됐거나 받는 중이면 건너뜀)
// 내려받을 수 있는 주소: 서버의 /client-update 또는 GitHub 릴리스의 클라이언트 설치파일
function isUpdateUrl(url) {
  url = String(url || '');
  if (/^https?:\/\/[^/]+\/client-update$/.test(url)) return true;
  const gh = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^/]+\/SchoolMessenger-Client-Setup-\d+\.\d+\.\d+\.exe$/i;
  if (gh.test(url)) return true;
  // 시험용 가짜 GitHub (SM_GITHUB_API 를 지정했을 때만)
  return !!process.env.SM_GITHUB_API && url.startsWith(process.env.SM_GITHUB_API) && /SchoolMessenger-Client-Setup-\d+\.\d+\.\d+\.exe$/i.test(url);
}
ipcMain.handle('download-update', (e, url, version) => {
  if (!isUpdateUrl(url)) return { ok: false };
  version = String(version || '');
  if (updateReady && updateReady.version === version && fs.existsSync(updateReady.path)) {
    return { ok: true, ready: true, version };
  }
  if (pendingUpdateUrl) return { ok: true, downloading: true };
  pendingUpdateUrl = url;
  pendingUpdateVersion = version;
  win.webContents.downloadURL(url);
  return { ok: true, downloading: true };
});
// 서버에 새 버전이 없을 때 GitHub(공개 저장소)에서 직접 최신 클라이언트 확인
ipcMain.handle('check-github-update', async (e, repo) => {
  repo = String(repo || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { ok: false, error: '저장소 정보가 없습니다.' };
  const api = process.env.SM_GITHUB_API || 'https://api.github.com';
  try {
    const res = await fetch(`${api}/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'SchoolMessenger-Client', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      return { ok: false, error: res.status === 404
        ? 'GitHub 에서 릴리스를 찾을 수 없습니다. (비공개 저장소이거나 아직 릴리스가 없음)'
        : 'GitHub 응답 오류 (' + res.status + ')' };
    }
    const rel = await res.json();
    let best = null;
    for (const a of rel.assets || []) {
      const m = /^SchoolMessenger-Client-Setup-(\d+\.\d+\.\d+)\.exe$/i.exec(a.name || '');
      if (m && (!best || verNewer(m[1], best.version))) best = { version: m[1], url: a.browser_download_url, size: a.size };
    }
    return { ok: true, page: rel.html_url || '', ...(best || { version: '' }) };
  } catch (err) {
    return { ok: false, error: 'GitHub 에 연결할 수 없습니다. (인터넷이 막혀 있으면 서버를 통해 업데이트됩니다)' };
  }
});
ipcMain.handle('get-update-ready', () =>
  (updateReady && fs.existsSync(updateReady.path)) ? { version: updateReady.version } : null);
// "지금 재시작하여 업데이트" 버튼
ipcMain.handle('install-update', () => installUpdate(true));

ipcMain.handle('get-autostart', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-autostart', (e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  return app.getLoginItemSettings().openAtLogin;
});

// alert/confirm 등 네이티브 대화상자 뒤 입력창 포커스가 깨지는 Electron 버그 해결
ipcMain.on('refocus', () => {
  if (win && !win.isDestroyed() && win.isFocused()) { win.blur(); win.focus(); }
});
ipcMain.on('show-in-folder', (e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
});

// 그림/입력창 우클릭 메뉴 (대화·쪽지 속 그림을 저장하거나 복사)
// 반환값: 메뉴에 담은 항목 수 (0이면 띄우지 않음)
ipcMain.handle('context-menu', (e, opt = {}) => {
  if (!win || win.isDestroyed()) return 0;
  const imageItems = [];
  const url = String(opt.imageUrl || '');
  if (/^https?:\/\//i.test(url)) {
    // 미리보기용 inline 주소에서 받으면 파일 이름이 빠질 수 있어 원래 주소로 내려받는다
    const dlUrl = url.replace(/([?&])inline=1(&|$)/, '$1').replace(/[?&]$/, '');
    imageItems.push({ label: '그림 저장', click: () => win.webContents.downloadURL(dlUrl) });
    imageItems.push({
      label: '그림 복사',
      click: () => win.webContents.copyImageAt(Number(opt.x) || 0, Number(opt.y) || 0)
    });
  }
  const editItems = [];
  if (opt.hasSelection) editItems.push({ label: '복사', role: 'copy' });
  if (opt.editable) {
    if (opt.hasSelection) editItems.push({ label: '잘라내기', role: 'cut' });
    editItems.push({ label: '붙여넣기', role: 'paste' });
    editItems.push({ label: '모두 선택', role: 'selectAll' });
  }
  const items = imageItems.length && editItems.length
    ? [...imageItems, { type: 'separator' }, ...editItems]
    : [...imageItems, ...editItems];
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  return items.length;
});
ipcMain.on('open-file', (e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.openPath(p);
});

// 이미 받아 둔 파일이 아직 그 자리에 있는지 확인 (지웠으면 다시 받아야 함)
ipcMain.handle('file-exists', (e, p) => {
  try { return typeof p === 'string' && fs.existsSync(p); } catch (err) { return false; }
});

// 첨부파일을 내려받고 저장된 경로를 돌려줌 (쪽지 창을 열어 둔 채로 바로 열기/폴더 열기)
ipcMain.handle('save-attachment', (e, url) => new Promise((resolve, reject) => {
  url = String(url || '');
  if (!/^https?:\/\/[^/]+\/files\//.test(url)) return reject(new Error('첨부파일 주소가 아닙니다.'));
  if (!win || win.isDestroyed()) return reject(new Error('창을 찾을 수 없습니다.'));
  const prev = pendingSaves.get(url);
  if (prev) return reject(new Error('이미 내려받고 있습니다.'));
  const timer = setTimeout(() => {
    pendingSaves.delete(url);
    reject(new Error('다운로드 시간이 초과되었습니다.'));
  }, 10 * 60 * 1000);
  pendingSaves.set(url, {
    resolve: (p) => { clearTimeout(timer); resolve(p); },
    reject: (err) => { clearTimeout(timer); reject(err); }
  });
  win.webContents.downloadURL(url);
}));

// 렌더러가 받아 온 파일(설문 결과 엑셀)을 첨부파일 저장 폴더에 저장하고 경로를 돌려줌
ipcMain.handle('save-file', (e, name, data) => {
  // 파일 이름 정리: 경로·금지 문자 제거, 엑셀 파일만 허용
  let base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 150);
  if (!base) base = '설문결과.xlsx';
  if (!/\.xlsx$/i.test(base)) base += '.xlsx';
  const buf = Buffer.from(data || []);
  if (!buf.length) throw new Error('받은 파일이 비어 있습니다.');
  if (buf.length > 50 * 1024 * 1024) throw new Error('파일이 너무 큽니다.');
  const savePath = uniqueSavePath(base);
  fs.writeFileSync(savePath, buf);
  return savePath;
});

// ---------- 첨부파일 저장 폴더 설정 ----------
ipcMain.handle('get-download-dir', () => settings.downloadDir || defaultDownloadDir());
ipcMain.handle('choose-download-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '첨부파일을 저장할 폴더 선택',
    defaultPath: downloadDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return null;
  settings.downloadDir = filePaths[0];
  saveSettings();
  return settings.downloadDir;
});
ipcMain.handle('reset-download-dir', () => {
  delete settings.downloadDir;
  saveSettings();
  return defaultDownloadDir();
});
ipcMain.on('open-download-dir', () => shell.openPath(downloadDir()));

// 작업표시줄 아이콘 배지 + 트레이 아이콘 배지에 미확인 알림 개수 표시
ipcMain.on('set-badge', (e, count, dataUrl, trayUrl) => {
  if (win && !win.isDestroyed()) {
    if (count > 0 && dataUrl) {
      try {
        win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), `읽지 않은 알림 ${count}개`);
      } catch (err) {}
    } else {
      win.setOverlayIcon(null, '');
    }
  }
  if (tray) {
    tray.setToolTip(count > 0 ? `학교메신저 — 읽지 않은 알림 ${count}개` : '학교메신저');
    try {
      if (count > 0 && trayUrl) {
        tray.setImage(nativeImage.createFromDataURL(trayUrl).resize({ width: 16, height: 16 }));
      } else if (trayBaseImage) {
        tray.setImage(trayBaseImage);
      }
    } catch (err) {}
  }
});

// 새 쪽지 도착 시 작업표시줄 깜빡임
ipcMain.on('flash', () => {
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
});
ipcMain.on('focus-app', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else showWindow();
});
