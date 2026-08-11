'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { MessengerServer } = require('./server');

let win = null;
let tray = null;
let quitting = false;
let server = null;
let settings = { port: 7777, schoolName: '' };
let settingsFile = null;

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
  // 창을 닫아도 서버는 트레이에서 계속 실행
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
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

function pushStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('status', server.getStatus());
    win.webContents.send('users', server.listUsers());
  }
}

app.whenReady().then(async () => {
  loadSettings();
  // 설치 후 첫 실행: Windows 시작 시 자동 실행 기본 켜기 (이후엔 사용자 설정 존중)
  if (!settings.autostartInit && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
    settings.autostartInit = true;
    saveSettings();
  }
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
  server.onStatusChange = pushStatus;
  try {
    await server.start(settings.port);
  } catch (e) {
    dialog.showErrorBox('서버 시작 실패',
      `포트 ${settings.port} 에서 서버를 시작할 수 없습니다.\n다른 프로그램이 포트를 사용 중일 수 있습니다.\n\n${e.message}`);
  }
  createWindow();
  createTray();
});

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
ipcMain.handle('get-settings', () => settings);
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
  const clean = (s) => String(s || '').replace(/[,\r\n]/g, ' ').trim();
  const rows = server.listUsers().map(u =>
    [u.id, clean(u.name), clean((u.depts || [u.dept]).join(';')), clean(u.position)].join(','));
  // BOM 포함 UTF-8: 엑셀에서 한글이 깨지지 않음
  fs.writeFileSync(filePath, '\uFEFF아이디,이름,부서,직위\r\n' + rows.join('\r\n'), 'utf8');
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
  const file = filePaths[0];
  if (/\.xlsx?$/i.test(file)) {
    // 엑셀 파일: 첫 번째 시트를 읽어 CSV 형식 줄로 변환
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const lines = rows
      .map(r => r.map(c => String(c).trim().replace(/,/g, ' ')).join(','))
      .filter(l => l.replace(/,/g, '').trim());
    if (lines.length && /^(아이디|id)\s*,/i.test(lines[0].trim())) lines.shift();
    const result = server.bulkAdd(lines.join('\n'));
    return { result, users: server.listUsers() };
  }
  const buf = fs.readFileSync(file);
  let text = buf.toString('utf8');
  if (text.includes('�')) {
    // 한글 Windows 엑셀의 구형 CSV(CP949/EUC-KR) 대응
    try { text = new TextDecoder('euc-kr').decode(buf); } catch (e) {}
  }
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length && /^(아이디|id)\s*,/i.test(lines[0].trim())) lines.shift(); // 머리글 행 무시
  const result = server.bulkAdd(lines.join('\n'));
  return { result, users: server.listUsers() };
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

// ---------- 부서(그룹) 표시 순서 ----------
ipcMain.handle('get-dept-order', () => server.getDeptOrder());
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
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

ipcMain.handle('backup-export', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '백업을 저장할 폴더 선택',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return null;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `학교메신저-백업-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const dst = path.join(filePaths[0], name);
  server.saveNow();
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(server.dataDir, 'data.json'), path.join(dst, 'data.json'));
  if (fs.existsSync(server.uploadDir)) copyDirSync(server.uploadDir, path.join(dst, 'uploads'));
  server.log('백업 내보내기: ' + dst);
  return dst;
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
  fs.copyFileSync(path.join(src, 'data.json'), path.join(server.dataDir, 'data.json'));
  if (fs.existsSync(path.join(src, 'uploads'))) {
    copyDirSync(path.join(src, 'uploads'), server.uploadDir);
  }
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
  copyDirSync(server.dataDir, dst);
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
