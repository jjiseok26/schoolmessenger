#!/usr/bin/env node
'use strict';
// 학교메신저 서버 — 리눅스(화면 없는 서버)용 실행 파일
//   node headless.js [--home 폴더] [--port 7777] [--data-dir 폴더]
//   관리: 웹 브라우저에서 http://서버주소:7777/admin (관리자 권한 계정으로 로그인)
//   보통은 install.sh 로 systemd 서비스(school-messenger-server)로 설치해 부팅 때 자동 실행한다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MessengerServer } = require('./server');
const { UpdateManager } = require('./update-manager');
const { mountWebAdmin } = require('./web-admin');
const core = require('./admin-core');
const pkg = require('./package.json');
// 윈도우에서 시험할 때는 기본 tar(bsdtar) 사용 (Git 의 GNU tar 는 C: 를 원격 주소로 읽음)
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function argOf(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const homeDir = path.resolve(argOf('home') || process.env.SM_HOME ||
  (isRoot ? '/var/lib/school-messenger-server' : path.join(os.homedir(), '.school-messenger-server')));
fs.mkdirSync(homeDir, { recursive: true });

const settingsFile = path.join(homeDir, 'settings.json');
const settings = { port: 7777, schoolName: '', dataDir: '', update: {} };
try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch (e) {}
function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 1), { mode: 0o600 }); // 토큰이 들어 있을 수 있어 본인만 읽기
  } catch (e) { console.error('설정 저장 실패:', e.message); }
}
if (argOf('port')) settings.port = Number(argOf('port'));

const dataDir = path.resolve(argOf('data-dir') || settings.dataDir || path.join(homeDir, 'serverdata'));
const server = new MessengerServer(dataDir);
server.schoolName = settings.schoolName || '';
server.version = pkg.version;
if (server._recovered) {
  console.error(server._recovered);
  server.log('데이터 복구: ' + server._recovered.replace(/\n/g, ' '));
}

const underSystemd = !!process.env.INVOCATION_ID;
const host = {
  settings, saveSettings, homeDir, updater: null,
  // 다시 시작: systemd(Restart=always)가 곧바로 다시 띄움
  async restart(reason, alreadyStopped) {
    server.log(`서버 다시 시작 (${reason})`);
    if (!alreadyStopped) { try { await server.stop(); } catch (e) {} }
    if (!underSystemd) console.log(`[${reason}] 프로그램을 종료했습니다. 다시 실행하세요: node ${path.join(__dirname, 'headless.js')}`);
    process.exit(0);
  }
};

mountWebAdmin(server, host);

// GitHub 에서 받은 새 버전(tar.gz)을 풀어 프로그램 폴더를 덮어쓴 뒤 다시 시작 (데이터 폴더는 건드리지 않음)
async function installLinux(p) {
  const tmp = fs.mkdtempSync(path.join(homeDir, 'update', 'unpack-'));
  try {
    execFileSync(TAR, ['-xzf', p.file, '-C', tmp]);
    const top = fs.readdirSync(tmp).map(f => path.join(tmp, f)).find(d => fs.existsSync(path.join(d, 'headless.js')));
    const src = top || (fs.existsSync(path.join(tmp, 'headless.js')) ? tmp : null);
    if (!src) throw new Error('업데이트 파일에 headless.js 가 없습니다.');
    const ver = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
    if (ver !== p.version) throw new Error(`업데이트 파일 버전이 맞지 않습니다 (${ver} ≠ ${p.version})`);
    fs.accessSync(__dirname, fs.constants.W_OK);
    core.copyDirSync(src, __dirname);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  server.log(`서버 v${p.version} 파일 교체 완료 — 다시 시작합니다`);
  setTimeout(() => host.restart(`v${p.version} 업데이트`), 300);
}

settings.update = settings.update || {};
const updater = new UpdateManager({
  server,
  options: settings.update,
  saveOptions: saveSettings,
  currentVersion: pkg.version,
  serverAssetKind: 'serverLinux',
  workDir: path.join(homeDir, 'update'),
  apiBase: process.env.SM_UPDATE_API || undefined,
  install: installLinux
});
host.updater = updater;
fs.mkdirSync(path.join(homeDir, 'update'), { recursive: true });

server.start(settings.port).then((port) => {
  const ips = server.getStatus().ips;
  console.log(`학교메신저 서버 v${pkg.version} 실행 중 — 포트 ${port}`);
  console.log(`  데이터: ${dataDir}`);
  console.log(`  접속 주소: ${(ips.length ? ips : ['127.0.0.1']).map(ip => ip + ':' + port).join(', ')}`);
  console.log(`  웹 관리 화면: http://${ips[0] || '127.0.0.1'}:${port}/admin  (처음 계정: admin / admin1234)`);
  if (!process.env.SM_NO_UPDATE) updater.start();
}).catch((e) => {
  console.error(`포트 ${settings.port} 에서 서버를 시작할 수 없습니다: ${e.message}`);
  process.exit(1);
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    updater.stop();
    try { await server.stop(); } catch (e) {}
    process.exit(0);
  });
}
