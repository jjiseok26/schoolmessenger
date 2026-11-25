'use strict';
// 웹 관리 화면 (리눅스 서버용) — http://서버주소:포트/admin
//  - 윈도우 관리 프로그램과 같은 화면(ui/)을 브라우저로 보여 주고, ui/web-api.js 가 window.api 를 HTTP 로 연결
//  - 관리자 권한이 있는 메신저 계정으로 로그인
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const core = require('./admin-core');

const SESSION_MS = 12 * 3600000;

function mountWebAdmin(server, host) {
  const sessions = new Map(); // 토큰 → { userId, expires }
  const fails = new Map();    // IP → { count, until } (비밀번호 대입 막기)

  const backupsDir = path.join(host.homeDir, 'backups');

  const auth = (req, res, next) => {
    const token = String(req.get('X-Admin-Token') || '');
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) {
      if (s) sessions.delete(token);
      return res.status(401).json({ ok: false, error: '다시 로그인하세요.' });
    }
    const u = server.db.users.find(x => x.id === s.userId);
    if (!u || !u.admin) { sessions.delete(token); return res.status(403).json({ ok: false, error: '관리자 권한이 없습니다.' }); }
    s.expires = Date.now() + SESSION_MS;
    req.adminUser = u;
    next();
  };

  // window.api 와 같은 이름의 기능들 (인자는 JSON 배열로 받음)
  const api = {
    getStatus: () => server.getStatus(),
    getUsers: () => server.listUsers(),
    getSettings: () => ({ ...host.settings, update: undefined }),
    getDataDir: () => server.dataDir,
    addUser: (u) => { server.addUser(u || {}); return server.listUsers(); },
    updateUser: (id, patch) => { server.updateUser(String(id), patch || {}); return server.listUsers(); },
    deleteUser: (id) => { server.deleteUser(String(id)); return server.listUsers(); },
    resetPw: (id, pw) => { server.resetPw(String(id), pw); return true; },
    bulkAdd: (text) => ({ result: server.bulkAdd(text), users: server.listUsers() }),
    setPort: (port) => {
      port = Number(port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('올바른 포트 번호(1~65535)를 입력하세요.');
      host.settings.port = port;
      host.saveSettings();
      setTimeout(() => host.restart('포트 변경'), 800); // 응답을 보낸 뒤 새 포트로 다시 시작
      return { ...server.getStatus(), port, restarting: true };
    },
    getAutostart: () => true,   // systemd 서비스로 설치하면 부팅 때 자동 실행
    setAutostart: () => true,
    setSchoolName: (name) => {
      host.settings.schoolName = String(name || '').trim().slice(0, 40);
      host.saveSettings();
      server.schoolName = host.settings.schoolName;
      return host.settings.schoolName;
    },
    getDeptOrder: () => server.getDeptOrder(),
    getExtraDepts: () => server.db.settings.extraDepts || [],
    setDeptOrder: (order) => server.setDeptOrder(order),
    getSignups: () => server.listSignups(),
    approveSignup: (reqId) => { server.approveSignup(String(reqId)); return server.listSignups(); },
    rejectSignup: (reqId) => { server.rejectSignup(String(reqId)); return server.listSignups(); },
    getLogs: () => server.getLogs(),
    backupExport: () => core.backupTo(server, backupsDir),
    listBackups: () => {
      try {
        return fs.readdirSync(backupsDir)
          .filter(f => fs.existsSync(path.join(backupsDir, f, 'data.json')))
          .sort().reverse();
      } catch (e) { return []; }
    },
    backupImport: async (name) => {
      const n = path.basename(String(name || ''));
      const src = path.join(backupsDir, n);
      if (!n || !fs.existsSync(path.join(src, 'data.json'))) throw new Error('백업을 찾을 수 없습니다: ' + n);
      server.log(`백업 복원: ${src}`);
      setTimeout(async () => {
        await server.stop();
        core.restoreFrom(server, src);
        host.restart('백업 복원', true);
      }, 500);
      return true;
    },
    changeDataDir: () => {
      throw new Error(`리눅스 버전은 설정 파일(${path.join(host.homeDir, 'settings.json')})의 "dataDir" 을 바꾼 뒤\n서비스를 다시 시작하세요: sudo systemctl restart school-messenger-server`);
    },
    getAppVersion: () => server.version,
    getClientUpdate: () => (server.clientUpdate ? { version: server.clientUpdate.version } : null),
    getStorage: () => server.getStorage(),
    setRetention: (days) => server.setRetention(days),
    runCleanup: () => server.cleanup(),
    getPlatform: () => process.platform,
    getUpdateState: () => (host.updater ? host.updater.getState() : null),
    setUpdateOptions: (o) => host.updater.setOptions(o || {}),
    checkUpdate: () => host.updater.check(true),
    installServerUpdate: () => host.updater.installNow('manual')
  };

  server.httpHooks.push((app) => {
    const uiDir = path.join(__dirname, 'ui');
    // /admin → /admin/ (상대 주소 api/… 가 맞게 풀리도록). 라우터는 끝 / 를 구분하지 않으므로 원래 주소로 판단
    app.get('/admin', (req, res, next) => (req.originalUrl.split('?')[0].endsWith('/') ? next() : res.redirect('/admin/')));

    app.post('/admin/api/login', express.json({ limit: '10kb' }), (req, res) => {
      const ip = req.socket.remoteAddress || '';
      const f = fails.get(ip);
      if (f && f.until > Date.now()) {
        return res.status(429).json({ ok: false, error: '로그인 실패가 많아 10분 동안 막았습니다.' });
      }
      const id = String((req.body || {}).id || '').trim();
      const u = server.db.users.find(x => x.id === id);
      if (!u || !server.checkPassword(u, String((req.body || {}).pw || ''))) {
        const c = (f && f.until <= Date.now() ? 0 : (f ? f.count : 0)) + 1;
        fails.set(ip, { count: c, until: c >= 10 ? Date.now() + 600000 : 0 });
        server.log(`웹 관리 화면 로그인 실패: ${id} (${ip})`);
        return res.status(401).json({ ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
      }
      if (!u.admin) return res.status(403).json({ ok: false, error: '관리자 권한이 있는 계정만 들어올 수 있습니다.' });
      fails.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { userId: u.id, expires: Date.now() + SESSION_MS });
      server.log(`웹 관리 화면 로그인: ${u.name}(${u.id}) (${ip})`);
      res.json({ ok: true, token, name: u.name });
    });

    app.post('/admin/api/logout', (req, res) => {
      sessions.delete(String(req.get('X-Admin-Token') || ''));
      res.json({ ok: true });
    });

    app.post('/admin/api/call', express.json({ limit: '2mb' }), auth, async (req, res) => {
      const { fn, args } = req.body || {};
      if (!Object.prototype.hasOwnProperty.call(api, fn)) return res.status(404).json({ ok: false, error: '알 수 없는 기능: ' + fn });
      try {
        const result = await api[fn](...(Array.isArray(args) ? args : []));
        res.json({ ok: true, result: result === undefined ? null : result });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    // 내려받기: 사용자 목록 CSV, 활동 로그
    app.get('/admin/api/download/:what', auth, (req, res) => {
      if (req.params.what === 'users.csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('사용자목록.csv'));
        return res.end(core.buildUsersCsv(server.listUsers()));
      }
      if (req.params.what === 'activity.log') {
        if (!fs.existsSync(server.logFile)) return res.status(404).send('로그 파일이 없습니다.');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="activity.log"');
        return fs.createReadStream(server.logFile).pipe(res);
      }
      res.status(404).end();
    });

    // 올리기: 사용자 엑셀/CSV, 클라이언트 설치파일 (?name=원래 파일 이름)
    app.post('/admin/api/upload/:what', auth, express.raw({ type: () => true, limit: 300 * 1024 * 1024 }), (req, res) => {
      const name = path.basename(String(req.query.name || 'file')).slice(0, 200);
      try {
        if (req.params.what === 'users') {
          return res.json({ ok: true, result: core.importUsers(server, req.body, name) });
        }
        if (req.params.what === 'client-update') {
          if (!/\.exe$/i.test(name)) throw new Error('설치파일(.exe)만 올릴 수 있습니다.');
          const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-')), name);
          fs.writeFileSync(tmp, req.body);
          try { return res.json({ ok: true, result: server.registerClientUpdate(tmp) }); }
          finally { fs.rm(path.dirname(tmp), { recursive: true, force: true }, () => {}); }
        }
        res.status(404).json({ ok: false, error: '알 수 없는 요청' });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    app.use('/admin', express.static(uiDir, { index: 'index.html' }));
  });
}

module.exports = { mountWebAdmin };
