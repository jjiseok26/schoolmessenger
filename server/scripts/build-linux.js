'use strict';
// 리눅스용 서버 꾸러미 만들기 → dist/SchoolMessenger-Server-Linux-<버전>.tar.gz
//   node scripts/build-linux.js   (npm run dist:linux)
//  - Electron 없이 Node.js 로 실행하는 headless.js + 웹 관리 화면(ui/) + 운영용 라이브러리(node_modules)
//  - 압축 안의 최상위 폴더: school-messenger-server/
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const outDir = path.join(root, 'dist');
const stageRoot = path.join(outDir, 'linux-stage');
const stage = path.join(stageRoot, 'school-messenger-server');
const outFile = path.join(outDir, `SchoolMessenger-Server-Linux-${pkg.version}.tar.gz`);

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 프로그램 파일
for (const f of ['server.js', 'headless.js', 'updater.js', 'update-manager.js', 'admin-core.js', 'web-admin.js', 'icon.png']) {
  copy(path.join(root, f), path.join(stage, f));
}
copy(path.join(root, 'ui'), path.join(stage, 'ui'));
// 설치 스크립트: 윈도우에서 꺼내도 줄바꿈이 LF 여야 bash 가 읽을 수 있음
for (const f of fs.readdirSync(path.join(root, 'linux'))) {
  const src = path.join(root, 'linux', f);
  let text = fs.readFileSync(src);
  if (/\.(sh|txt)$/.test(f)) text = Buffer.from(text.toString('utf8').replace(/\r\n/g, '\n'));
  fs.writeFileSync(path.join(stage, f), text);
}

// package.json: 운영에 필요한 정보만
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, description: pkg.description + ' (리눅스용)',
  main: 'headless.js', license: pkg.license, author: pkg.author,
  scripts: { start: 'node headless.js' },
  engines: { node: '>=18' },
  dependencies: pkg.dependencies
}, null, 2));

// 운영용 라이브러리만 복사 (electron 등 개발용 제외) — 모두 순수 자바스크립트라 리눅스에서 그대로 동작
const list = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const nm = path.join(root, 'node_modules');
const tops = new Set();
for (const p of list) {
  const rel = path.relative(nm, p);
  if (!rel || rel.startsWith('..')) continue;
  const parts = rel.split(path.sep);
  tops.add(parts[0].startsWith('@') ? parts.slice(0, 2).join(path.sep) : parts[0]);
}
for (const t of tops) copy(path.join(nm, t), path.join(stage, 'node_modules', t));
console.log(`라이브러리 ${tops.size}개 복사`);

// tar.gz 만들기 (윈도우 10 이상 기본 tar 사용 — Git 의 GNU tar 는 C: 를 원격 주소로 읽으므로 경로를 지정)
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
fs.rmSync(outFile, { force: true });
execFileSync(TAR, ['-czf', outFile, '-C', stageRoot, 'school-messenger-server'], { stdio: 'inherit' });
fs.rmSync(stageRoot, { recursive: true, force: true });
console.log('만듦: ' + outFile + ` (${Math.round(fs.statSync(outFile).size / 1024)}KB)`);
