'use strict';
// 서버 관리 기능 공용 도우미 (윈도우 관리 프로그램·리눅스 웹 관리 화면이 함께 씀)
const fs = require('fs');
const path = require('path');

const CSV_HEADER = '아이디,이름,부서,직위,비밀번호,담당과목,사무실위치,사무실전화,핸드폰,이메일';

// 사용자 목록 → 엑셀용 CSV (BOM 포함 UTF-8: 엑셀에서 한글이 깨지지 않음)
// 비밀번호 칸은 비워 둠 — 그대로 다시 가져오면 새 계정은 1234 로 만들어짐
function buildUsersCsv(users) {
  const clean = (s) => String(s || '').replace(/[,\r\n]/g, ' ').trim();
  const rows = users.filter(u => u.id !== 'admin').map(u => [
    u.id, clean(u.name), clean((u.depts || [u.dept]).join(';')), clean(u.position), '',
    clean(u.subject), clean(u.office), clean(u.phone), clean(u.mobile), clean(u.email)
  ].join(','));
  return '﻿' + CSV_HEADER + '\r\n' + rows.join('\r\n');
}

// 엑셀(xlsx/xls) 또는 CSV/텍스트 파일 내용 → bulkAdd 형식 줄 목록
function importLinesFromBuffer(buf, filename) {
  if (/\.xlsx?$/i.test(filename || '')) {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const lines = rows
      .map(r => r.map(c => String(c).trim().replace(/,/g, ' ')).join(','))
      .filter(l => l.replace(/,/g, '').trim());
    if (lines.length && /^(아이디|id)\s*,/i.test(lines[0].trim())) lines.shift(); // 머리글 행 무시
    return lines;
  }
  let text = buf.toString('utf8');
  if (text.includes('�')) {
    // 한글 Windows 엑셀의 구형 CSV(CP949/EUC-KR) 대응
    try { text = new TextDecoder('euc-kr').decode(buf); } catch (e) {}
  }
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length && /^(아이디|id)\s*,/i.test(lines[0].trim())) lines.shift();
  return lines;
}

function importUsers(server, buf, filename) {
  const result = server.bulkAdd(importLinesFromBuffer(buf, filename).join('\n'));
  return { result, users: server.listUsers() };
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function backupName(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `학교메신저-백업-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

// 1.0.1~ 쪽지·채팅은 날짜별 파일 폴더에 저장 (data.json 에는 계정·공지·채팅방·설정)
const CHUNK_DIRS = ['messages', 'roommsgs'];

// 날짜별 파일 폴더 복사 (.bak·임시 파일은 빼고 본 파일만)
function copyChunks(srcDir, dstDir) {
  for (const d of CHUNK_DIRS) {
    const s = path.join(srcDir, d);
    if (!fs.existsSync(s)) continue;
    fs.mkdirSync(path.join(dstDir, d), { recursive: true });
    for (const f of fs.readdirSync(s)) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) fs.copyFileSync(path.join(s, f), path.join(dstDir, d, f));
    }
  }
}

// 백업: parentDir 아래에 날짜 이름 폴더를 만들어 data.json + 날짜별 쪽지·채팅 + uploads 복사 → 만든 폴더 경로
function backupTo(server, parentDir) {
  const dst = path.join(parentDir, backupName());
  server.saveNow();
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(server.dataDir, 'data.json'), path.join(dst, 'data.json'));
  copyChunks(server.dataDir, dst);
  if (fs.existsSync(server.uploadDir)) copyDirSync(server.uploadDir, path.join(dst, 'uploads'));
  server.log('백업 내보내기: ' + dst);
  return dst;
}

// 복원 (서버를 멈춘 뒤 호출) — 백업 폴더의 data.json + 날짜별 쪽지·채팅 + uploads 를 데이터 폴더로.
// 지금 있는 날짜별 파일은 지운다 (남겨 두면 복원한 내용과 섞임). 예전(1.0.0 이하) 백업은 data.json 안에 쪽지가 모두 들어 있어
// 다음 실행 때 자동으로 날짜별 파일로 옮겨진다.
function restoreFrom(server, srcDir) {
  if (!fs.existsSync(path.join(srcDir, 'data.json'))) {
    throw new Error('선택한 폴더에 data.json이 없습니다. 백업 폴더를 선택하세요.');
  }
  for (const d of CHUNK_DIRS) fs.rmSync(path.join(server.dataDir, d), { recursive: true, force: true });
  fs.rmSync(path.join(server.dataDir, 'data.json.bak'), { force: true });
  fs.copyFileSync(path.join(srcDir, 'data.json'), path.join(server.dataDir, 'data.json'));
  copyChunks(srcDir, server.dataDir);
  if (fs.existsSync(path.join(srcDir, 'uploads'))) copyDirSync(path.join(srcDir, 'uploads'), server.uploadDir);
}

module.exports = { buildUsersCsv, importLinesFromBuffer, importUsers, copyDirSync, backupName, backupTo, restoreFrom, CSV_HEADER };
