'use strict';
const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Windows 알림 상단에 영문 앱 이름 대신 바로가기 이름(학교메신저)이 표시되도록 설정
app.setAppUserModelId('kr.school.messenger.client');

let win = null;
let tray = null;
let quitting = false;
let pendingUpdateUrl = null; // 자동 업데이트 다운로드 중인 URL

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
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 560,
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
  // 설치 후 첫 실행: Windows 시작 시 자동 실행 기본 켜기 (이후엔 설정에서 변경 가능)
  const initFlag = path.join(app.getPath('userData'), '.autostart-init');
  if (app.isPackaged && !fs.existsSync(initFlag)) {
    app.setLoginItemSettings({ openAtLogin: true });
    try { fs.writeFileSync(initFlag, '1'); } catch (e) {}
  }
  session.defaultSession.on('will-download', (e, item) => {
    if (pendingUpdateUrl && item.getURL() === pendingUpdateUrl) {
      // 자동 업데이트: 진행률을 화면에 표시하며 내려받고, 완료되면 설치파일을 바로 실행
      pendingUpdateUrl = null;
      const savePath = path.join(app.getPath('temp'), item.getFilename());
      item.setSavePath(savePath);
      const dlId = 'update-' + Date.now();
      const sendProgress = (state) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('download-progress', {
            id: dlId, name: '새 버전 설치파일 — ' + item.getFilename(),
            path: savePath, state, isUpdate: true,
            received: item.getReceivedBytes(), total: item.getTotalBytes()
          });
        }
      };
      sendProgress('progressing');
      item.on('updated', (ev, state) => sendProgress(state));
      item.once('done', async (ev, state) => {
        sendProgress(state);
        if (state === 'completed') {
          await shell.openPath(savePath); // 설치 즉시 시작
          quitting = true;
          app.quit();
        } else {
          dialog.showErrorBox('업데이트 실패', '업데이트 파일을 내려받지 못했습니다. 잠시 후 다시 시도해 주세요.');
        }
      });
      return;
    }
    // 일반 첨부파일: 다운로드 폴더에 자동 저장 (같은 이름이 있으면 숫자 붙임) + 진행률 표시
    const dir = downloadDir();
    const parsed = path.parse(item.getFilename() || 'file');
    let candidate = parsed.base, n = 1;
    while (fs.existsSync(path.join(dir, candidate))) {
      candidate = `${parsed.name} (${n++})${parsed.ext}`;
    }
    const savePath = path.join(dir, candidate);
    item.setSavePath(savePath);
    const dlId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const sendProgress = (state) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('download-progress', {
          id: dlId, name: candidate, path: savePath, state,
          received: item.getReceivedBytes(), total: item.getTotalBytes()
        });
      }
    };
    sendProgress('progressing');
    item.on('updated', (ev, state) => sendProgress(state));
    item.once('done', (ev, state) => sendProgress(state));
  });
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // 트레이 상주: 창이 없어도 알림 수신을 위해 계속 실행
});
app.on('before-quit', () => { quitting = true; });

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('download-update', (e, url) => {
  if (!/^https?:\/\/[^/]+\/client-update$/.test(String(url))) return false;
  pendingUpdateUrl = url;
  win.webContents.downloadURL(url);
  return true;
});

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
ipcMain.on('open-file', (e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.openPath(p);
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
