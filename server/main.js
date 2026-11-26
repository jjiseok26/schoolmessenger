'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { MessengerServer } = require('./server');
const { UpdateManager } = require('./update-manager');
const core = require('./admin-core');

let win = null;
let tray = null;
let quitting = false;
let server = null;
let settings = { port: 7777, schoolName: '', update: {} };
let updater = null; // GitHub 자동 업데이트 관리
let settingsFile = null;

// 관리 화면은 단순해서 그래픽 가속이 필요 없다 — 끄면 GPU 프로세스가 없어져 메모리가 줄어든다 (메모리 4GB PC 대응)
app.disableHardwareAcceleration();

// 중복 실행 방지: 이미 실행 중이면 기존 창을 앞으로
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => showWindow());
}

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch (e) {}
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 1)); } catch (e) {}
}

function windowTitle() {
  return settings.schoolName ? `${settings.schoolName} 메신저 서버` : '학교메신저 서버';
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    title: windowTitle(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  // HTML <title>이 창 제목을 덮어쓰지 않도록 고정 (학교 이름 표시)
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.on('did-finish-load', () => { if (win) win.setTitle(windowTitle()); });
  // 창을 닫아도 서버는 트레이에서 계속 실행. 창은 숨기지 않고 없애서 관리 화면이 쓰던 메모리를 돌려준다
  // (다시 열면 새로 만든다 — 서버 자체는 메인 프로세스에서 계속 동작)
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); win.focus(); }
}

async function quitApp() {
  quitting = true;
  if (server) { try { await server.stop(); } catch (e) {} }
  app.exit(0);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('학교메신저 서버 (실행 중)');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '관리 화면 열기', click: showWindow },
    { type: 'separator' },
    { label: '서버 종료', click: quitApp }
  ]));
  tray.on('double-click', showWindow);
}

function fixAutostartPath() {
  // Electron 이 시작 프로그램에 쓰는 값 이름 = 'electron.app.' + 실행 파일의 제품 이름(= exe 이름).
  // app.getName() 은 package.json 의 name(school-messenger-server)이라 다르다
  const name = 'electron.app.' + path.basename(process.execPath, '.exe');
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  require('child_process').execFile('reg', ['query', key, '/v', name], { windowsHide: true }, (err, out) => {
    if (err) return; // 자동 실행이 꺼져 있음 → 그대로 둔다
    const m = /REG_SZ\s+(.+)$/m.exec(String(out));
    if (!m) return;
    const registered = m[1].trim().replace(/^"([^"]+)".*$/, '$1');
    if (path.resolve(registered).toLowerCase() === path.resolve(process.execPath).toLowerCase()) return;
    // 다른 곳에 제대로 설치된 서버라면 건드리지 않고, 빌드 폴더이거나 이미 없어진 위치일 때만 바로잡는다
    if (fs.existsSync(registered) && !/[\\/]win-unpacked[\\/]/i.test(registered)) return;
    app.setLoginItemSettings({ openAtLogin: true, name });
    if (server) server.log(`자동 실행 경로 바로잡음: ${registered} → ${process.execPath}`);
  });
}

function pushStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('status', server.getStatus());
    win.webContents.send('users', server.listUsers());
  }
}

app.whenReady().then(async () => {
  loadSettings();
  // 설치 후 첫 실행: Windows 시작 시 자동 실행 기본 켜기 (이후엔 사용자 설정 존중)
  // 빌드 폴더(win-unpacked)에서 시험 삼아 켠 것은 등록하지 않는다 — 시작 프로그램이 그 폴더를 가리키게 되어
  // 다시 빌드하면 엉뚱한(옛) 서버가 켜졌다
  const installed = app.isPackaged && !/[\\/]win-unpacked[\\/]/i.test(process.execPath);
  if (!settings.autostartInit && installed) {
    app.setLoginItemSettings({ openAtLogin: true });
    settings.autostartInit = true;
    saveSettings();
  }
  // 자동 실행이 다른 위치(빌드 폴더·예전 설치 위치)의 서버로 등록돼 있으면 지금 설치된 서버로 바로잡는다
  // (Electron 의 launchItems 는 경로가 다른 항목을 보여 주지 않아 레지스트리 값을 직접 읽는다)
  if (installed && process.platform === 'win32') fixAutostartPath();
  // 데이터 저장 위치: 사용자가 변경한 경우 그 위치 사용
  let dataDir = path.join(app.getPath('userData'), 'serverdata');
  if (settings.dataDir) {
    try {
      fs.mkdirSync(settings.dataDir, { recursive: true });
      dataDir = settings.dataDir;
    } catch (e) {
      dialog.showErrorBox('데이터 폴더 오류',
        `설정된 데이터 저장 위치를 사용할 수 없어 기본 위치를 사용합니다.\n${settings.dataDir}`);
    }
  }
  server = new MessengerServer(dataDir);
  server.schoolName = settings.schoolName || '';
  server.version = app.getVersion();
  server.onStatusChange = pushStatus;
  // 데이터 파일이 손상되어 백업으로 복구했으면 관리자에게 알림
  if (server._recovered) {
    server.log('데이터 복구: ' + server._recovered.replace(/\n/g, ' '));
    dialog.showErrorBox('데이터 복구 안내', server._recovered);
  }
  try {
    await server.start(settings.port);
  } catch (e) {
    dialog.showErrorBox('서버 시작 실패',
      `포트 ${settings.port} 에서 서버를 시작할 수 없습니다.\n다른 프로그램이 포트를 사용 중일 수 있습니다.\n\n${e.message}`);
  }
  createWindow();
  createTray();
  startUpdater();
});

// ---------- GitHub 자동 업데이트 ----------
// 새 서버 설치파일: /S=무음, --updated=실행 중인 서버가 스스로 종료되길 기다림, --force-run=설치 후 다시 실행
function startUpdater() {
  settings.update = settings.update || {};
  updater = new UpdateManager({
    server,
    options: settings.update,
    saveOptions: saveSettings,
    currentVersion: app.getVersion(),
    serverAssetKind: 'serverWin',
    workDir: path.join(app.getPath('userData'), 'update'),
    apiBase: process.env.SM_UPDATE_API || undefined, // 시험용 가짜 GitHub 주소
    install: async (p) => {
      if (!app.isPackaged && !process.env.SM_UPDATE_TEST) throw new Error('개발 실행 중에는 설치할 수 없습니다.');
      const child = require('child_process').spawn(p.file, ['/S', '--updated', '--force-run'], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      child.unref();
      setTimeout(quitApp, 500); // 설치 프로그램이 서버 종료를 기다렸다가 파일을 교체함
    }
  });
  updater.onChange = (st) => { if (win && !win.isDestroyed()) win.webContents.send('update-state', st); };
  if (app.isPackaged || process.env.SM_UPDATE_TEST) updater.start();
}

app.on('window-all-closed', () => {
  // 트레이 상주: 창이 없어도 서버는 계속 실행
});
app.on('before-quit', () => { quitting = true; });

// ---------- IPC ----------
// alert/confirm 등 네이티브 대화상자 뒤 입력창 포커스가 깨지는 Electron 버그 해결
ipcMain.on('refocus', () => {
  if (win && !win.isDestroyed() && win.isFocused()) { win.blur(); win.focus(); }
});
ipcMain.handle('get-status', () => server.getStatus());
ipcMain.handle('get-users', () => server.listUsers());
ipcMain.handle('get-settings', () => ({ ...settings, update: undefined })); // 토큰은 화면에 보내지 않음
ipcMain.handle('get-data-dir', () => server.dataDir);

ipcMain.handle('add-user', (e, u) => {
  server.addUser(u);
  return server.listUsers();
});
ipcMain.handle('update-user', (e, id, patch) => {
  server.updateUser(id, patch);
  return server.listUsers();
});
ipcMain.handle('delete-user', (e, id) => {
  server.deleteUser(id);
  return server.listUsers();
});
ipcMain.handle('reset-pw', (e, id, pw) => {
  server.resetPw(id, pw);
  return true;
});
ipcMain.handle('bulk-add', (e, text) => {
  const r = server.bulkAdd(text);
  return { result: r, users: server.listUsers() };
});
// ---------- CSV 내보내기/가져오기 ----------
ipcMain.handle('export-csv', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '사용자 목록 내보내기',
    defaultPath: '사용자목록.csv',
    filters: [{ name: 'CSV 파일', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, core.buildUsersCsv(server.listUsers()), 'utf8');
  return filePath;
});

ipcMain.handle('import-csv', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '사용자 엑셀/CSV 가져오기',
    filters: [
      { name: '엑셀/CSV', extensions: ['xlsx', 'xls', 'csv', 'txt'] },
      { name: '엑셀 파일', extensions: ['xlsx', 'xls'] },
      { name: 'CSV/텍스트', extensions: ['csv', 'txt'] }
    ],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  return core.importUsers(server, fs.readFileSync(filePaths[0]), filePaths[0]);
});

// ---------- 클라이언트 자동 업데이트 파일 등록 ----------
ipcMain.handle('register-client-update', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '새 클라이언트 설치파일 선택',
    filters: [{ name: '설치파일', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  return server.registerClientUpdate(filePaths[0]);
});
ipcMain.handle('get-client-update', () =>
  server.clientUpdate ? { version: server.clientUpdate.version } : null);

// ---------- 회원가입 요청 ----------
ipcMain.handle('get-signups', () => server.listSignups());
ipcMain.handle('approve-signup', (e, reqId) => { server.approveSignup(reqId); return server.listSignups(); });
ipcMain.handle('reject-signup', (e, reqId) => { server.rejectSignup(reqId); return server.listSignups(); });

// ---------- 활동 로그 ----------
ipcMain.handle('get-logs', () => server.getLogs());
ipcMain.on('open-log', () => {
  const { shell } = require('electron');
  if (fs.existsSync(server.logFile)) shell.showItemInFolder(server.logFile);
});
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-platform', () => process.platform);
ipcMain.handle('get-update-state', () => updater ? updater.getState() : null);
ipcMain.handle('set-update-options', (e, o) => updater.setOptions(o));
ipcMain.handle('check-update', () => updater.check(true));
ipcMain.handle('install-server-update', () => updater.installNow('manual'));

// ---------- 부서(그룹) 표시 순서 ----------
ipcMain.handle('get-dept-order', () => server.getDeptOrder());
ipcMain.handle('get-extra-depts', () => server.db.settings.extraDepts || []);
ipcMain.handle('set-dept-order', (e, order) => server.setDeptOrder(order));

// ---------- 학교 이름 ----------
ipcMain.handle('set-school-name', (e, name) => {
  settings.schoolName = String(name || '').trim().slice(0, 40);
  saveSettings();
  server.schoolName = settings.schoolName;
  if (win && !win.isDestroyed()) win.setTitle(windowTitle());
  if (tray) tray.setToolTip(windowTitle() + ' (실행 중)');
  return settings.schoolName;
});

// ---------- 백업 (서버 이전용) ----------
ipcMain.handle('backup-export', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '백업을 저장할 폴더 선택',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return null;
  return core.backupTo(server, filePaths[0]);
});

ipcMain.handle('backup-import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '백업 폴더 선택 (data.json이 들어 있는 폴더)',
    properties: ['openDirectory']
  });
  if (canceled || !filePaths.length) return null;
  const src = filePaths[0];
  if (!fs.existsSync(path.join(src, 'data.json'))) {
    throw new Error('선택한 폴더에 data.json이 없습니다. 백업 폴더를 선택하세요.');
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '백업 복원',
    message: '현재 서버의 모든 데이터가 선택한 백업으로 교체됩니다.\n복원 후 프로그램이 다시 시작됩니다. 계속할까요?',
    buttons: ['복원', '취소'], defaultId: 1
  });
  if (response !== 0) return null;
  await server.stop();
  core.restoreFrom(server, src);
  quitting = true;
  app.relaunch();
  app.exit(0);
});

// ---------- 데이터 저장 위치 변경 ----------
ipcMain.handle('change-data-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '새 데이터 저장 폴더 선택',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return null;
  let dst = filePaths[0];
  // 이미 데이터 폴더가 아니라면 하위 폴더를 만들어 사용
  if (!fs.existsSync(path.join(dst, 'data.json'))) dst = path.join(dst, 'SchoolMessengerData');
  if (path.resolve(dst) === path.resolve(server.dataDir)) {
    throw new Error('현재 저장 위치와 같은 폴더입니다.');
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '데이터 저장 위치 변경',
    message: `데이터 저장 위치를 아래 폴더로 변경할까요?\n\n${dst}\n\n기존 데이터(쪽지·계정·첨부파일)를 복사한 뒤 프로그램이 다시 시작됩니다.`,
    buttons: ['변경', '취소'], defaultId: 1
  });
  if (response !== 0) return null;
  await server.stop();
  server.saveNow();
  core.copyDirSync(server.dataDir, dst);
  settings.dataDir = dst;
  saveSettings();
  quitting = true;
  app.relaunch();
  app.exit(0);
});

// ---------- 데이터 관리 ----------
ipcMain.handle('get-storage', () => server.getStorage());
ipcMain.handle('set-retention', (e, days) => server.setRetention(days));
ipcMain.handle('run-cleanup', () => server.cleanup());

ipcMain.handle('get-autostart', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-autostart', (e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('set-port', async (e, port) => {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('올바른 포트 번호(1~65535)를 입력하세요.');
  await server.stop();
  try {
    await server.start(port);
    settings.port = port;
    saveSettings();
  } catch (err) {
    // 실패 시 기존 포트로 복구 시도
    try { await server.start(settings.port); } catch (e2) {}
    throw new Error('포트 변경 실패: ' + err.message);
  }
  return server.getStatus();
});
