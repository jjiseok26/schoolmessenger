'use strict';
// 학교 메신저 서버 코어 (Electron 비의존 — 단독 node 실행으로도 테스트 가능)
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

// 화면에 바로 표시할 수 있는 파일 형식 (Content-Type이 있어야 <img>/<video>로 렌더링됨)
const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.pdf': 'application/pdf'
};

const MAX_TEXT_LEN = 20000;
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB
const INIT_MSG_LIMIT = 500; // 로그인 시 내려주는 최근 쪽지 수

function hashPw(pw, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pw).digest('hex');
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------- 메시지 암호화 (ECDH 키교환 + AES-256-GCM) ----------
// 형식: base64( iv(12) + ciphertext + tag(16) ). 클라이언트 Web Crypto와 호환.
function aesEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}
function aesDecrypt(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
// P-256 ECDH 공유 비밀 → SHA-256 → AES-256 키 (클라이언트와 동일한 도출)
function deriveAesKey(ecdh, clientPubB64) {
  const secret = ecdh.computeSecret(Buffer.from(clientPubB64, 'base64'));
  return crypto.createHash('sha256').update(secret).digest();
}

// 사용자 세부 정보 필드와 최대 길이 (내 정보·서버 관리 화면·엑셀 가져오기 공용)
const USER_DETAIL_FIELDS = { office: 50, subject: 50, phone: 30, mobile: 30, email: 60 };

// 부서 문자열/배열 → 부서 배열 (쉼표/세미콜론으로 여러 부서 소속 가능)
function parseDepts(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,;]/);
  const out = [...new Set(arr.map(s => String(s).trim().slice(0, 60)).filter(Boolean))];
  return out.length ? out.slice(0, 10) : ['미지정'];
}

// 설문 객체 정규화 — 저장 형태: { options[], deadline, multi, anon, votes: { userId: [항목번호...] } }
// 예전 형식(votes: { userId: 번호 })도 배열로 변환해 그대로 사용한다.
function normalizePoll(p) {
  if (!p || !Array.isArray(p.options) || p.options.length < 2) return null;
  const options = p.options.map(o => String(o).trim().slice(0, 100)).filter(Boolean);
  if (options.length < 2) return null;
  const votes = {};
  for (const [uid, v] of Object.entries(p.votes || {})) {
    const arr = [...new Set((Array.isArray(v) ? v : [v]).map(Number))]
      .filter(i => Number.isInteger(i) && i >= 0 && i < options.length);
    if (arr.length) votes[uid] = arr;
  }
  const deadline = Number(p.deadline) || 0;
  return {
    q: String(p.q || '').slice(0, 200),
    options, deadline,
    multi: !!p.multi, anon: !!p.anon, votes,
    // 결과 공개 알림을 이미 보냈는지. 불러올 때 이미 마감된 설문은 로그인 시 결과가 같이 가므로 보낸 것으로 본다
    resultSent: !!p.resultSent || deadline <= Date.now()
  };
}

class MessengerServer {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.uploadDir = path.join(dataDir, 'uploads');
    this.updateDir = path.join(dataDir, 'update');
    this.dbFile = path.join(dataDir, 'data.json');
    this.logFile = path.join(dataDir, 'activity.log');
    fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.mkdirSync(this.updateDir, { recursive: true });
    this.clientUpdate = this._loadClientUpdate();
    this.logs = []; // 최근 로그 (메모리), 전체 기록은 activity.log 파일
    this.db = this._loadDb();
    this.sockets = new Map(); // userId -> ws
    this.tokens = new Map();  // token -> userId
    this.status = new Map();  // userId -> 'online' | 'away' | 'class' | 'meeting'
    this.httpServer = null;
    this.wss = null;
    this.port = null;
    this.schoolName = '';
    this.version = '';          // 서버 프로그램 버전 (실행 환경이 넣어 줌, /health 로 확인 가능)
    this.updateRepoPublic = ''; // 클라이언트가 GitHub 에서 직접 새 버전을 확인할 공개 저장소 (owner/repo)
    this.httpHooks = [];        // start() 때 추가로 붙일 HTTP 경로 (리눅스 웹 관리 화면 등): (app) => {}
    this._saveTimer = null;
    this.onStatusChange = null; // 관리 UI 갱신 콜백
  }

  // ---------- DB ----------
  // 정상 파일 → 백업 → (실패 시) 새 DB 순으로 불러옴. 손상 파일은 절대 덮어쓰지 않고 보존한다.
  _loadDb() {
    const bakFile = this.dbFile + '.bak';
    for (const [file, label] of [[this.dbFile, '데이터'], [bakFile, '백업']]) {
      if (!fs.existsSync(file)) continue;
      try {
        const db = this._normalizeDb(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (file === bakFile) {
          // 본 파일이 손상되어 백업으로 복구한 경우: 손상 파일을 남겨 둔다
          const keep = this.dbFile + '.corrupt-' + Date.now();
          try { fs.renameSync(this.dbFile, keep); } catch (e) {}
          this._recovered = `데이터 파일이 손상되어 백업에서 복구했습니다.\n손상된 파일은 보관해 두었습니다:\n${keep}`;
        }
        return db;
      } catch (e) {
        console.error(`${label} 파일을 읽을 수 없습니다:`, e.message);
      }
    }
    // 둘 다 실패: 기존 파일이 있으면 보존한 뒤 새로 시작 (조용한 초기화 방지)
    if (fs.existsSync(this.dbFile)) {
      const keep = this.dbFile + '.corrupt-' + Date.now();
      try { fs.renameSync(this.dbFile, keep); } catch (e) {}
      this._recovered = `데이터 파일을 읽을 수 없어 새로 시작합니다.\n기존 파일은 보관해 두었습니다:\n${keep}`;
    }
    return this._createDb();
  }

  _normalizeDb(db) {
    {
      db.users = db.users || [];
      db.messages = db.messages || [];
      db.notices = db.notices || [];
      db.rooms = db.rooms || [];
      db.roomMsgs = db.roomMsgs || [];
      db.scheduled = db.scheduled || [];
      db.settings = db.settings || { retentionDays: 0 };
      db.settings.userOrder = db.settings.userOrder || {};
      db.settings.extraDepts = db.settings.extraDepts || [];
      // 다중 부서 마이그레이션: dept(문자열) → depts(배열)
      for (const u of db.users) {
        if (!Array.isArray(u.depts)) u.depts = parseDepts(u.dept);
        u.dept = u.depts[0];
      }
      db.userGroups = db.userGroups || [];
      db.scheduledNotices = db.scheduledNotices || [];
      db.signups = db.signups || [];
      // 설문 마이그레이션: 단일 선택 번호 → 배열, multi/anon 기본값 부여
      for (const list of [db.notices, db.scheduledNotices, db.roomMsgs]) {
        for (const item of list) {
          if (item.poll) {
            const p = normalizePoll(item.poll);
            if (p) item.poll = p; else delete item.poll;
          }
        }
      }
      return db;
    }
  }

  _createDb() {
    const salt = newId();
    const db = {
      users: [{
        id: 'admin', name: '관리자', dept: '관리자', depts: ['관리자'], position: '시스템관리자',
        admin: true, salt, pw: hashPw('admin1234', salt)
      }],
      messages: [],
      notices: [],
      rooms: [],
      roomMsgs: [],
      scheduled: [],
      settings: { retentionDays: 0, userOrder: {}, extraDepts: [] },
      userGroups: [],
      scheduledNotices: [],
      signups: []
    };
    fs.mkdirSync(this.dataDir, { recursive: true });
    this._writeDb(db);
    return db;
  }

  // 원자적 저장: 임시 파일에 쓰고 디스크에 반영한 뒤 교체 (쓰기 중 종료돼도 기존 파일이 온전함)
  _writeDb(db) {
    const tmp = this.dbFile + '.tmp';
    const json = JSON.stringify(db, null, 1);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json);
      fs.fsyncSync(fd);       // 디스크에 실제 기록되도록 강제
    } finally {
      fs.closeSync(fd);
    }
    // 직전 정상본을 백업으로 남긴 뒤 교체
    if (fs.existsSync(this.dbFile)) {
      try { fs.copyFileSync(this.dbFile, this.dbFile + '.bak'); } catch (e) {}
    }
    fs.renameSync(tmp, this.dbFile);
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this._writeDb(this.db);
      } catch (e) { console.error('DB 저장 실패:', e); }
    }, 300);
  }

  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try { this._writeDb(this.db); } catch (e) { console.error('DB 저장 실패:', e); }
  }

  // ---------- 활동 로그 ----------
  log(text) {
    const entry = { time: Date.now(), text: String(text) };
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
    const d = new Date(entry.time);
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    try { fs.appendFileSync(this.logFile, `[${stamp}] ${entry.text}\n`); } catch (e) {}
  }

  getLogs() {
    return this.logs.slice(-300).reverse();
  }

  _userLabel(id) {
    const u = this.db.users.find(x => x.id === id);
    return u ? `${u.name}(${id})` : id;
  }

  // ---------- 서버 시작/중지 ----------
  start(port) {
    return new Promise((resolve, reject) => {
      const app = express();

      // 클라이언트는 file:// 페이지에서 요청하므로 CORS 허용 필요 (없으면 파일 업로드 실패)
      app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.end();
        next();
      });

      app.get('/health', (req, res) => res.json({ ok: true, name: 'school-messenger', version: this.version || '' }));

      // 클라이언트 자동 업데이트: 등록된 최신 설치파일 제공
      app.get('/client-update', (req, res) => {
        if (!this.clientUpdate || !fs.existsSync(this.clientUpdate.file)) {
          return res.status(404).send('등록된 업데이트 파일이 없습니다');
        }
        res.setHeader('Content-Disposition', 'attachment; filename="SchoolMessenger-Client-Setup-' +
          this.clientUpdate.version + '.exe"');
        fs.createReadStream(this.clientUpdate.file).pipe(res);
      });

      // 파일 업로드: 원본 바이너리 body, ?name=파일명&token=로그인토큰
      app.post('/upload', express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
        const token = String(req.query.token || '');
        const userId = this.tokens.get(token);
        if (!userId) return res.status(401).json({ error: '인증 실패' });
        const name = path.basename(String(req.query.name || 'file')).slice(0, 200) || 'file';
        const fid = newId();
        try {
          fs.writeFileSync(path.join(this.uploadDir, fid), req.body);
        } catch (e) {
          return res.status(500).json({ error: '파일 저장 실패' });
        }
        this.log(`파일 업로드: ${name} (${Math.round(req.body.length / 1024)}KB) — ${this._userLabel(userId)}`);
        res.json({
          name,
          size: req.body.length,
          url: '/files/' + fid + '/' + encodeURIComponent(name)
        });
      });

      // 설문 결과 엑셀(.xlsx) 내려받기 — 마감된 설문만, 볼 수 있는 사람만
      //   ?token=&noticeId=  (공지 설문)  /  ?token=&roomId=&msgId=  (채팅방 설문, 방 참여자만)
      app.get('/poll-export', (req, res) => {
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        const userId = this.tokens.get(String(req.query.token || ''));
        if (!userId) return res.status(401).type('text/plain').send('로그인이 필요합니다.');
        let src;
        try {
          src = this._findPollForExport(userId, req.query);
        } catch (e) {
          return res.status(e.status || 400).type('text/plain').send(e.message);
        }
        let buf;
        try {
          buf = this.buildPollWorkbook(src);
        } catch (e) {
          console.error('설문 엑셀 만들기 오류:', e);
          return res.status(500).type('text/plain').send('엑셀 파일을 만들지 못했습니다.');
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const safeTitle = String(src.title || '설문').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40);
        const fname = `설문결과_${safeTitle}_${stamp}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fname));
        this.log(`설문 결과 엑셀 저장: "${src.title}" — ${this._userLabel(userId)}`);
        res.end(buf);
      });

      app.get('/files/:fid/:name', (req, res) => {
        const fid = String(req.params.fid).replace(/[^a-f0-9]/g, '');
        const file = path.join(this.uploadDir, fid);
        if (!fid || !fs.existsSync(file)) return res.status(404).send('파일이 없습니다');
        const name = String(req.params.name || '');
        // 화면에 바로 표시(이미지·영상)하려면 ?inline=1 — 올바른 Content-Type과 inline 처리 필요
        const inline = req.query.inline === '1';
        const type = MIME_TYPES[path.extname(name).toLowerCase()];
        if (type) res.setHeader('Content-Type', type);
        res.setHeader('Content-Disposition',
          (inline && type ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name));
        fs.createReadStream(file).pipe(res);
      });

      for (const hook of this.httpHooks) hook(app);

      this.httpServer = http.createServer(app);
      this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
      this.wss.on('connection', (ws) => this._onConnection(ws));

      this.httpServer.on('error', (err) => reject(err));
      this.httpServer.listen(port, '0.0.0.0', () => {
        this.port = port;
        // 예약 쪽지 발송(10초 주기) + 보관함 자동 정리(6시간 주기)
        this._schedTimer = setInterval(() => this._deliverDue(), 10000);
        this._cleanTimer = setInterval(() => this.cleanup(), 6 * 3600000);
        this._deliverDue(); // 서버가 꺼져 있던 동안 밀린 예약 쪽지 즉시 발송
        this.log(`서버 시작 (포트 ${port})`);
        resolve(port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null; }
      if (this._cleanTimer) { clearInterval(this._cleanTimer); this._cleanTimer = null; }
      this.saveNow();
      for (const ws of this.sockets.values()) { try { ws.close(); } catch (e) {} }
      this.sockets.clear();
      this.tokens.clear();
      if (this.wss) { try { this.wss.close(); } catch (e) {} this.wss = null; }
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
        this.httpServer = null;
        this.port = null;
      } else resolve();
    });
  }

  // ---------- WebSocket ----------
  _onConnection(ws) {
    ws.userId = null;
    ws.isAlive = true;
    ws.aesKey = null;
    // 암호화 핸드셰이크: 서버 ECDH 공개키를 먼저 보냄
    ws.ecdh = crypto.createECDH('prime256v1');
    ws.ecdh.generateKeys();
    ws.send(JSON.stringify({ type: 'hello', pub: ws.ecdh.getPublicKey('base64') }));
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      // 암호화된 메시지면 복호화
      if (msg.e && ws.aesKey) {
        try { msg = JSON.parse(aesDecrypt(ws.aesKey, msg.e)); } catch (e) { return; }
      }
      // 클라이언트 공개키 수신 → 세션 키 확립
      if (msg.type === 'key') {
        try { ws.aesKey = deriveAesKey(ws.ecdh, String(msg.pub || '')); } catch (e) {}
        return;
      }
      try { this._handle(ws, msg); } catch (e) { console.error('메시지 처리 오류:', e); }
    });
    ws.on('close', () => {
      if (ws.userId && this.sockets.get(ws.userId) === ws) {
        this.log(`접속 종료: ${this._userLabel(ws.userId)}`);
        this.sockets.delete(ws.userId);
        this.status.delete(ws.userId);
        this._broadcast({ type: 'presence', id: ws.userId, online: false, status: null });
        this._statusChanged();
      }
    });
  }

  _send(ws, obj) {
    if (!ws || ws.readyState !== 1) return;
    const json = JSON.stringify(obj);
    // 세션 키가 있으면 암호화해서 전송
    ws.send(ws.aesKey ? JSON.stringify({ e: aesEncrypt(ws.aesKey, json) }) : json);
  }

  _sendTo(userId, obj) {
    this._send(this.sockets.get(userId), obj);
  }

  _broadcast(obj) {
    const json = JSON.stringify(obj);
    for (const ws of this.sockets.values()) {
      if (ws.readyState !== 1) continue;
      ws.send(ws.aesKey ? JSON.stringify({ e: aesEncrypt(ws.aesKey, json) }) : json);
    }
  }

  // ---------- 설문 ----------
  // 보는 사람에게 보낼 설문 정보.
  // - 마감 전에는 항목별 결과(표 수·투표자)를 아예 보내지 않는다 → 마감 후에만 결과 공개
  // - 미공개(익명) 설문은 마감 후에도 누가 투표했는지는 보내지 않는다
  _pollView(poll, viewerId) {
    const votes = poll.votes || {};
    const closed = Date.now() >= poll.deadline;
    const view = {
      q: poll.q || '', options: poll.options, deadline: poll.deadline,
      multi: !!poll.multi, anon: !!poll.anon, closed,
      total: Object.keys(votes).length, // 참여 인원은 진행 중에도 보여 줌 (결과는 아님)
      mine: Array.isArray(votes[viewerId]) ? votes[viewerId] : (votes[viewerId] !== undefined ? [votes[viewerId]] : [])
    };
    if (!closed) return view;
    const counts = poll.options.map(() => 0);
    const voters = poll.options.map(() => []);
    for (const [uid, v] of Object.entries(votes)) {
      for (const i of (Array.isArray(v) ? v : [v])) { // 예전 형식(번호 하나)도 안전하게 처리
        if (counts[i] === undefined) continue;
        counts[i]++;
        if (!poll.anon) voters[i].push(uid);
      }
    }
    view.counts = counts;
    if (!poll.anon) view.voters = voters;
    return view;
  }

  // 마감 시각이 지난 설문은 결과를 공개해야 하므로 한 번만 다시 보내 준다 (10초 주기 타이머)
  _announceClosedPolls() {
    const now = Date.now();
    let changed = false;
    for (const n of this.db.notices) {
      if (n.poll && n.poll.deadline <= now && !n.poll.resultSent) {
        n.poll.resultSent = true;
        changed = true;
        this.log(`설문 마감·결과 공개: "${n.title}" (참여 ${Object.keys(n.poll.votes || {}).length}명)`);
        this._broadcastNotice('notice_updated', n);
      }
    }
    for (const m of this.db.roomMsgs) {
      if (m.poll && m.poll.deadline <= now && !m.poll.resultSent) {
        m.poll.resultSent = true;
        changed = true;
        const room = this.db.rooms.find(r => r.id === m.roomId);
        if (room) this._sendRoomMsg(room, m, 'room_message_updated');
      }
    }
    if (changed) this._saveSoon();
  }

  // 엑셀로 내보낼 설문 찾기 — 볼 수 있는 사람만, 마감된 설문만. 실패하면 status 가 붙은 Error
  _findPollForExport(userId, q) {
    const fail = (status, msg) => Object.assign(new Error(msg), { status });
    const nameOf = (id) => (this.db.users.find(u => u.id === id) || {}).name || id;
    let poll, title, kind, author, targets;
    if (q.noticeId) {
      const n = this.db.notices.find(x => x.id === String(q.noticeId));
      if (!n || !n.poll) throw fail(404, '설문을 찾을 수 없습니다.');
      poll = n.poll;
      title = n.title;
      kind = '공지 설문';
      author = n.authorName || nameOf(n.authorId);
      targets = this.db.users.filter(u => u.id !== 'admin').map(u => u.id); // 시스템 기본 계정 제외 전체
    } else {
      const room = this.db.rooms.find(r => r.id === String(q.roomId || ''));
      if (!room || !room.members.includes(userId)) throw fail(403, '이 채팅방의 설문은 볼 수 없습니다.');
      const m = this.db.roomMsgs.find(x => x.id === String(q.msgId || '') && x.roomId === room.id);
      if (!m || !m.poll) throw fail(404, '설문을 찾을 수 없습니다.');
      poll = m.poll;
      title = m.poll.q || '채팅방 설문';
      kind = `채팅방 설문 (${room.name})`;
      author = nameOf(m.from);
      targets = [...room.members];
    }
    if (Date.now() < poll.deadline) throw fail(403, '설문이 끝난 뒤에 결과를 받을 수 있습니다.');
    return { poll, title, kind, author, targets };
  }

  // 설문 결과 엑셀(.xlsx) 만들기
  //  - '결과' 시트: 설문 정보 + 항목별 표 수·비율(+ 공개 설문은 투표한 사람)
  //  - 공개 설문만 '응답자별'(누가 무엇을 골랐는지)·'미참여'(대상 중 투표하지 않은 사람) 시트 추가
  //    (익명 설문은 투표자 정보는 물론 미참여 명단도 넣지 않음 — 미참여 명단으로 참여자를 알 수 있으므로)
  buildPollWorkbook({ poll, title, kind, author, targets }) {
    const XLSX = require('xlsx');
    const votes = poll.votes || {};
    const voterIds = Object.keys(votes);
    const userOf = (id) => this.db.users.find(u => u.id === id);
    const nameOf = (id) => (userOf(id) || {}).name || id;
    const deptOf = (u) => (u ? (u.depts || [u.dept]).filter(Boolean).join(', ') : '');
    const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'ko');
    const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : 0);
    const fmt = (ts) => {
      const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const counts = poll.options.map(() => 0);
    const voters = poll.options.map(() => []);
    for (const [uid, v] of Object.entries(votes)) {
      for (const i of (Array.isArray(v) ? v : [v])) {
        if (counts[i] === undefined) continue;
        counts[i]++;
        voters[i].push(uid);
      }
    }
    const total = voterIds.length;
    const targetSet = new Set([...targets, ...voterIds]);
    const anon = !!poll.anon;

    const rows = [
      ['설문 결과'],
      [],
      ['설문', title],
      ['구분', kind],
      ['만든 사람', author],
      ['마감', fmt(poll.deadline)],
      ['선택 방식', poll.multi ? '여러 개 선택' : '하나만 선택'],
      ['투표자', anon ? '미공개(익명)' : '공개'],
      ['참여', `${total}명 / 대상 ${targetSet.size}명 (참여율 ${pct(total, targetSet.size)}%)`],
      ['저장한 시각', fmt(Date.now())],
      [],
      anon ? ['항목', '표 수', '비율(%)'] : ['항목', '표 수', '비율(%)', '투표한 사람']
    ];
    poll.options.forEach((opt, i) => {
      const r = [opt, counts[i], pct(counts[i], total)];
      if (!anon) r.push(voters[i].sort(byName).map(nameOf).join(', '));
      rows.push(r);
    });
    if (poll.multi) rows.push([], ['※ 여러 개를 고를 수 있는 설문이라 비율의 합이 100%를 넘을 수 있습니다. (비율 = 표 수 ÷ 참여 인원)']);
    if (anon) rows.push([], ['※ 익명 설문이라 누가 투표했는지는 담지 않았습니다.']);
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(rows);
    ws1['!cols'] = [{ wch: 26 }, { wch: 40 }, { wch: 10 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws1, '결과');

    if (!anon) {
      const r2 = [['이름', '아이디', '부서', '직위', '선택한 항목']];
      for (const uid of [...voterIds].sort(byName)) {
        const u = userOf(uid);
        const picked = (Array.isArray(votes[uid]) ? votes[uid] : [votes[uid]])
          .filter(i => poll.options[i] !== undefined).map(i => poll.options[i]);
        r2.push([nameOf(uid), uid, deptOf(u), (u && u.position) || '', picked.join(', ')]);
      }
      const ws2 = XLSX.utils.aoa_to_sheet(r2);
      ws2['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 10 }, { wch: 40 }];
      XLSX.utils.book_append_sheet(wb, ws2, '응답자별');

      const r3 = [['이름', '아이디', '부서', '직위']];
      for (const uid of [...targetSet].filter(id => !votes[id]).sort(byName)) {
        const u = userOf(uid);
        r3.push([nameOf(uid), uid, deptOf(u), (u && u.position) || '']);
      }
      const ws3 = XLSX.utils.aoa_to_sheet(r3);
      ws3['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws3, '미참여');
    }
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  // 설문 지금 마감 — 공지 설문은 작성자·관리자, 채팅방 설문은 만든 사람·관리자(방 참여자)만
  _doClosePoll(ws, msg) {
    const user = this.db.users.find(u => u.id === ws.userId);
    if (!user) return;
    const deny = (error) => this._send(ws, { type: 'error', error });
    if (msg.noticeId) {
      const n = this.db.notices.find(x => x.id === msg.noticeId);
      if (!n || !n.poll) return;
      if (n.authorId !== user.id && !user.admin) return deny('설문을 마감할 권한이 없습니다.');
      if (Date.now() >= n.poll.deadline) return;
      n.poll.deadline = Date.now();
      n.poll.resultSent = true;
      this._saveSoon();
      this.log(`설문 조기 마감: "${n.title}" — ${user.name}`);
      return this._broadcastNotice('notice_updated', n);
    }
    const room = this.db.rooms.find(r => r.id === msg.roomId);
    if (!room || !room.members.includes(user.id)) return;
    const m = this.db.roomMsgs.find(x => x.id === msg.msgId && x.roomId === room.id);
    if (!m || !m.poll) return;
    if (m.from !== user.id && !user.admin) return deny('설문을 만든 사람만 마감할 수 있습니다.');
    if (Date.now() >= m.poll.deadline) return;
    m.poll.deadline = Date.now();
    m.poll.resultSent = true;
    this._saveSoon();
    this.log(`채팅방 설문 조기 마감: "${m.poll.q}" — ${user.name} (${room.name})`);
    this._sendRoomMsg(room, m, 'room_message_updated');
  }

  _noticeView(n, viewerId) {
    return n.poll ? { ...n, poll: this._pollView(n.poll, viewerId) } : n;
  }

  _roomMsgView(m, viewerId) {
    return m.poll ? { ...m, poll: this._pollView(m.poll, viewerId) } : m;
  }

  // 공지는 사람마다 설문 내용이 달라질 수 있어 개인별로 전송한다.
  _broadcastNotice(type, n) {
    for (const [uid, ws] of this.sockets) this._send(ws, { type, notice: this._noticeView(n, uid) });
  }

  // 클라이언트가 보낸 설문 설정 검증 → 저장용 설문 객체
  _parsePoll(raw) {
    if (!raw || !Array.isArray(raw.options)) return { poll: null };
    const options = raw.options.map(o => String(o).trim().slice(0, 100)).filter(Boolean).slice(0, 10);
    if (options.length < 2) return { error: '설문 항목은 2개 이상이어야 합니다.' };
    const deadline = Number(raw.deadline) || 0;
    if (deadline <= Date.now()) return { error: '설문 마감 시각은 미래여야 합니다.' };
    return {
      poll: {
        q: String(raw.q || '').trim().slice(0, 200),
        options, deadline, multi: !!raw.multi, anon: !!raw.anon, votes: {}
      }
    };
  }

  // 투표 반영. 선택이 비어 있으면 투표 취소. 반환값: 오류 메시지 또는 null
  _applyVote(poll, userId, raw) {
    if (Date.now() >= poll.deadline) return '설문이 마감되었습니다.';
    let opts = [...new Set((Array.isArray(raw) ? raw : [raw]).map(Number))]
      .filter(i => Number.isInteger(i) && i >= 0 && i < poll.options.length);
    if (!poll.multi) opts = opts.slice(0, 1);
    poll.votes = poll.votes || {};
    if (opts.length) poll.votes[userId] = opts;
    else delete poll.votes[userId];
    return null;
  }

  _publicUser(u) {
    const online = this.sockets.has(u.id);
    return {
      id: u.id, name: u.name, dept: u.dept, depts: u.depts || [u.dept], position: u.position,
      office: u.office || '', subject: u.subject || '',
      phone: u.phone || '', mobile: u.mobile || '', email: u.email || '',
      admin: !!u.admin,
      system: u.id === 'admin', // 시스템 기본 계정 표시 (숨김 처리는 이 값으로만)
      online,
      status: online ? (this.status.get(u.id) || 'online') : null
    };
  }

  _requireAdmin(ws) {
    const u = this.db.users.find(x => x.id === ws.userId);
    return u && u.admin ? u : null;
  }

  _statusChanged() {
    if (this.onStatusChange) try { this.onStatusChange(); } catch (e) {}
  }

  _handle(ws, msg) {
    if (msg.type === 'login') return this._doLogin(ws, msg);
    if (msg.type === 'signup_request') return this._doSignupRequest(ws, msg); // 로그인 전 허용
    if (!ws.userId) return this._send(ws, { type: 'error', error: '로그인이 필요합니다' });

    switch (msg.type) {
      case 'send_message': return this._doSendMessage(ws, msg);
      case 'read': return this._doRead(ws, msg);
      case 'recall_message': return this._doRecallMessage(ws, msg);
      case 'delete_message': return this._doDeleteMessage(ws, msg);
      case 'cancel_scheduled': return this._doCancelScheduled(ws, msg);
      case 'set_status': return this._doSetStatus(ws, msg);
      case 'create_room': return this._doCreateRoom(ws, msg);
      case 'room_message': return this._doRoomMessage(ws, msg);
      case 'room_poll': return this._doRoomPoll(ws, msg);
      case 'vote_room_poll': return this._doVoteRoomPoll(ws, msg);
      case 'close_poll': return this._doClosePoll(ws, msg);
      case 'add_room_members': return this._doAddRoomMembers(ws, msg);
      case 'leave_room': return this._doLeaveRoom(ws, msg);
      case 'post_notice': return this._doPostNotice(ws, msg);
      case 'edit_notice': return this._doEditNotice(ws, msg);
      case 'delete_notice': return this._doDeleteNotice(ws, msg);
      case 'vote_poll': return this._doVotePoll(ws, msg);
      case 'cancel_scheduled_notice': return this._doCancelScheduledNotice(ws, msg);
      case 'save_group': return this._doSaveGroup(ws, msg);
      case 'delete_group': return this._doDeleteGroup(ws, msg);
      case 'reorder_groups': return this._doReorderGroups(ws, msg);
      case 'set_dept_order': return this._doSetDeptOrder(ws, msg);
      case 'set_user_order': return this._doSetUserOrder(ws, msg);
      case 'rename_dept': return this._doRenameDept(ws, msg);
      case 'add_dept': return this._doAddDept(ws, msg);
      case 'delete_dept': return this._doDeleteDept(ws, msg);
      case 'admin_add_user': return this._doAdminAddUser(ws, msg);
      case 'admin_update_user': return this._doAdminUpdateUser(ws, msg);
      case 'admin_delete_user': return this._doAdminDeleteUser(ws, msg);
      case 'list_signups': return this._doListSignups(ws);
      case 'approve_signup': return this._doApproveSignup(ws, msg);
      case 'reject_signup': return this._doRejectSignup(ws, msg);
      case 'change_pw': return this._doChangePw(ws, msg);
      case 'update_profile': return this._doUpdateProfile(ws, msg);
      case 'ping': return this._send(ws, { type: 'pong' });
    }
  }

  _doLogin(ws, msg) {
    const id = String(msg.id || '').trim();
    const pw = String(msg.pw || '');
    const user = this.db.users.find(u => u.id === id);
    if (!user || hashPw(pw, user.salt) !== user.pw) {
      if (id) this.log(`로그인 실패: ${id}`);
      return this._send(ws, { type: 'login_fail', error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    this.log(`로그인: ${user.name}(${id})`);
    // 중복 접속: 기존 세션 종료
    const prev = this.sockets.get(id);
    if (prev && prev !== ws) {
      this._send(prev, { type: 'kicked', reason: '다른 위치에서 로그인되어 연결이 종료되었습니다.' });
      prev.userId = null;
      try { prev.close(); } catch (e) {}
    }
    ws.userId = id;
    this.sockets.set(id, ws);
    this.status.set(id, 'online');
    const token = newId() + newId();
    this.tokens.set(token, id);
    ws.token = token;

    const mine = this.db.messages.filter(m =>
      (m.from === id || m.to.includes(id)) && !(m.deletedBy || []).includes(id));
    const recent = mine.slice(-INIT_MSG_LIMIT);
    const myRooms = this.db.rooms.filter(r => r.members.includes(id));
    const roomMsgs = {};
    for (const r of myRooms) {
      roomMsgs[r.id] = this._roomHistory(r.id, id);
    }
    this._send(ws, {
      type: 'login_ok',
      token,
      schoolName: this.schoolName || '',
      clientUpdate: this.clientUpdate ? this.clientUpdate.version : '',
      updateRepo: this.updateRepoPublic || '',
      user: this._publicUser(user),
      users: this.db.users.map(u => this._publicUser(u)),
      messages: recent,
      notices: this.db.notices.slice(-100).map(n => this._noticeView(n, id)),
      signups: user.admin ? this.listSignups() : [],
      rooms: myRooms,
      roomMsgs,
      scheduled: this.db.scheduled.filter(s => s.from === id),
      groups: this.db.userGroups.filter(g => g.owner === id),
      scheduledNotices: this.db.scheduledNotices.filter(n => n.authorId === id),
      deptOrder: this.getDeptOrder(),
      userOrder: this.db.settings.userOrder || {},
      extraDepts: this.db.settings.extraDepts || []
    });
    this._broadcast({ type: 'presence', id, online: true, status: 'online' });
    this._statusChanged();
  }

  _doSetStatus(ws, msg) {
    const st = ['online', 'away', 'class', 'meeting'].includes(msg.status) ? msg.status : 'online';
    this.status.set(ws.userId, st);
    this._broadcast({ type: 'presence', id: ws.userId, online: true, status: st });
  }

  // 내 보관함에서만 쪽지 삭제 (상대방 화면에는 유지, 모두 삭제하면 완전히 제거)
  _doDeleteMessage(ws, msg) {
    const m = this.db.messages.find(x => x.id === msg.messageId);
    if (!m || (m.from !== ws.userId && !m.to.includes(ws.userId))) return;
    m.deletedBy = m.deletedBy || [];
    if (!m.deletedBy.includes(ws.userId)) m.deletedBy.push(ws.userId);
    const everyone = [...new Set([m.from, ...m.to])];
    if (everyone.every(uid => m.deletedBy.includes(uid))) {
      this.db.messages = this.db.messages.filter(x => x.id !== m.id);
    }
    this._saveSoon();
    this._send(ws, { type: 'message_deleted', messageId: msg.messageId });
  }

  // 쪽지 회수 — 보낸 사람 본인이면 상대가 이미 읽었어도 회수할 수 있다
  _doRecallMessage(ws, msg) {
    const idx = this.db.messages.findIndex(x => x.id === msg.messageId);
    if (idx < 0 || this.db.messages[idx].from !== ws.userId) return;
    const m = this.db.messages[idx];
    this.db.messages.splice(idx, 1);
    this._saveSoon();
    this.log(`쪽지 회수: ${this._userLabel(ws.userId)} → ${m.to.length}명` +
      (m.readBy.length ? ` (이미 읽은 사람 ${m.readBy.length}명)` : ''));
    this._send(ws, { type: 'recall_result', ok: true, messageId: m.id, readCount: m.readBy.length });
    for (const uid of new Set([m.from, ...m.to])) {
      if (uid === ws.userId) continue; // 보낸 사람은 recall_result 로 처리
      this._sendTo(uid, {
        type: 'message_recalled', messageId: m.id,
        from: this._userLabel(m.from), wasRead: m.readBy.includes(uid)
      });
    }
  }

  _doSendMessage(ws, msg) {
    const text = String(msg.text || '').slice(0, MAX_TEXT_LEN);
    const to = Array.isArray(msg.to)
      ? [...new Set(msg.to.map(String))].filter(id => this.db.users.some(u => u.id === id))
      : [];
    if (!to.length || (!text.trim() && !(msg.attachments || []).length)) return;
    const attachments = this._cleanAttachments(msg.attachments);
    // 본문 서식(전체 적용): 글자 크기/색상
    let style = null;
    if (msg.style) {
      const size = Math.min(40, Math.max(10, Number(msg.style.size) || 0));
      const color = /^#[0-9a-fA-F]{6}$/.test(String(msg.style.color || '')) ? msg.style.color : '';
      if (size > 0 || color) style = { size: size || 0, color };
    }
    // 리치 편집기 HTML 본문 (렌더링 시 클라이언트에서 정화)
    const html = msg.html ? String(msg.html).slice(0, 200000) : '';
    // 예약 발송: sendAt이 20초 이상 미래이면 예약 보관함에 저장
    const sendAt = Number(msg.sendAt) || 0;
    if (sendAt > Date.now() + 20000) {
      if (sendAt > Date.now() + 366 * 86400000) {
        return this._send(ws, { type: 'error', error: '예약 시각은 1년 이내여야 합니다.' });
      }
      const item = { id: newId(), from: ws.userId, to, text, attachments, sendAt, created: Date.now() };
      if (style) item.style = style;
      if (html) item.html = html;
      this.db.scheduled.push(item);
      this._saveSoon();
      this.log(`예약 쪽지 등록: ${this._userLabel(ws.userId)} → ${to.length}명`);
      return this._send(ws, { type: 'scheduled_added', item });
    }
    const m = {
      id: newId(),
      from: ws.userId,
      to,
      text,
      attachments,
      time: Date.now(),
      // 나에게 보내기: 내가 받는 사람에 들어 있으면 보낸 즉시 읽은 것으로 둔다
      readBy: to.includes(ws.userId) ? [ws.userId] : []
    };
    if (style) m.style = style;
    if (html) m.html = html;
    this.db.messages.push(m);
    this._saveSoon();
    this.log(`쪽지 발송: ${this._userLabel(ws.userId)} → ${to.map(t => this._userLabel(t)).slice(0, 3).join(', ')}${to.length > 3 ? ` 외 ${to.length - 3}명` : ''}${attachments.length ? ` (첨부 ${attachments.length}개)` : ''}`);
    this._send(ws, { type: 'message_sent', message: m, clientRef: msg.clientRef });
    for (const rid of to) {
      if (rid !== ws.userId) this._sendTo(rid, { type: 'new_message', message: m });
    }
  }

  _doRead(ws, msg) {
    const m = this.db.messages.find(x => x.id === msg.messageId);
    if (!m || !m.to.includes(ws.userId) || m.readBy.includes(ws.userId)) return;
    m.readBy.push(ws.userId);
    this._saveSoon();
    this._sendTo(m.from, { type: 'read_receipt', messageId: m.id, readerId: ws.userId });
  }

  // ---------- 클라이언트 자동 업데이트 ----------
  _loadClientUpdate() {
    try {
      let best = null;
      for (const f of fs.readdirSync(this.updateDir)) {
        const m = /client-setup-(\d+\.\d+\.\d+)\.exe$/i.exec(f);
        if (m && (!best || this._newerVersion(m[1], best.version))) {
          best = { version: m[1], file: path.join(this.updateDir, f) };
        }
      }
      return best;
    } catch (e) { return null; }
  }

  _newerVersion(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }

  registerClientUpdate(srcPath) {
    const m = /(\d+\.\d+\.\d+)/.exec(path.basename(srcPath));
    if (!m) throw new Error('파일 이름에서 버전을 찾을 수 없습니다. (예: SchoolMessenger-Client-Setup-1.5.0.exe)');
    const version = m[1];
    // 기존 업데이트 파일 제거 후 새 파일 복사
    for (const f of fs.readdirSync(this.updateDir)) {
      if (/\.exe$/i.test(f)) { try { fs.unlinkSync(path.join(this.updateDir, f)); } catch (e) {} }
    }
    const dst = path.join(this.updateDir, 'client-setup-' + version + '.exe');
    fs.copyFileSync(srcPath, dst);
    this.clientUpdate = { version, file: dst };
    return { version, size: fs.statSync(dst).size };
  }

  // GitHub 에서 내려받은 클라이언트 설치파일을 배포용으로 등록 (복사 대신 이동, 기존 파일 정리)
  adoptClientUpdate(file, version) {
    if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('버전 형식이 올바르지 않습니다: ' + version);
    const dst = path.join(this.updateDir, 'client-setup-' + version + '.exe');
    for (const f of fs.readdirSync(this.updateDir)) {
      const p = path.join(this.updateDir, f);
      if (/\.exe$/i.test(f) && path.resolve(p) !== path.resolve(file)) { try { fs.unlinkSync(p); } catch (e) {} }
    }
    if (path.resolve(file) !== path.resolve(dst)) {
      try { fs.renameSync(file, dst); }
      catch (e) { fs.copyFileSync(file, dst); try { fs.unlinkSync(file); } catch (e2) {} } // 다른 디스크면 복사
    }
    this.clientUpdate = { version, file: dst };
    this.log(`클라이언트 v${version} 설치파일 등록 (GitHub)`);
    return { version, size: fs.statSync(dst).size };
  }

  // ---------- 예약 발송 ----------
  _deliverDue() {
    this._announceClosedPolls(); // 마감된 설문 결과 공개
    const now = Date.now();
    // 예약 공지 발행
    const dueNotices = this.db.scheduledNotices.filter(s => s.publishAt <= now);
    if (dueNotices.length) {
      this.db.scheduledNotices = this.db.scheduledNotices.filter(s => s.publishAt > now);
      for (const s of dueNotices) {
        const n = {
          id: s.id, authorId: s.authorId, authorName: s.authorName,
          title: s.title, body: s.body, attachments: s.attachments || [], time: Date.now()
        };
        if (s.poll) n.poll = s.poll;
        this.db.notices.push(n);
        this._broadcastNotice('notice', n);
      }
      this._saveSoon();
    }
    // 예약 쪽지 발송
    const due = this.db.scheduled.filter(s => s.sendAt <= now);
    if (!due.length) return;
    this.db.scheduled = this.db.scheduled.filter(s => s.sendAt > now);
    for (const s of due) {
      const to = s.to.filter(id => this.db.users.some(u => u.id === id));
      if (!to.length || !this.db.users.some(u => u.id === s.from)) continue;
      const m = {
        id: newId(), from: s.from, to, text: s.text,
        attachments: s.attachments, time: Date.now(),
        readBy: to.includes(s.from) ? [s.from] : [], scheduled: true
      };
      if (s.style) m.style = s.style;
      if (s.html) m.html = s.html;
      this.db.messages.push(m);
      for (const rid of to) {
        if (rid !== s.from) this._sendTo(rid, { type: 'new_message', message: m });
      }
      this._sendTo(s.from, { type: 'scheduled_sent', scheduledId: s.id, message: m });
    }
    this._saveSoon();
  }

  _doCancelScheduled(ws, msg) {
    const idx = this.db.scheduled.findIndex(s => s.id === msg.id && s.from === ws.userId);
    if (idx < 0) return;
    this.db.scheduled.splice(idx, 1);
    this._saveSoon();
    this._send(ws, { type: 'scheduled_cancelled', id: msg.id });
  }

  // ---------- 보관함 용량 관리 ----------
  getStorage() {
    let dbSize = 0;
    try { dbSize = fs.statSync(this.dbFile).size; } catch (e) {}
    let uploadsSize = 0, uploadsCount = 0;
    try {
      for (const f of fs.readdirSync(this.uploadDir)) {
        try { uploadsSize += fs.statSync(path.join(this.uploadDir, f)).size; uploadsCount++; } catch (e) {}
      }
    } catch (e) {}
    return {
      dbSize, uploadsSize, uploadsCount,
      messageCount: this.db.messages.length,
      roomMsgCount: this.db.roomMsgs.length,
      scheduledCount: this.db.scheduled.length,
      retentionDays: this.db.settings.retentionDays || 0
    };
  }

  setRetention(days) {
    this.db.settings.retentionDays = Math.max(0, Math.floor(Number(days) || 0));
    this._saveSoon();
    return this.db.settings.retentionDays;
  }

  // 보관 기간이 지난 쪽지/채팅 삭제 + 어디에서도 참조되지 않는 첨부파일 정리
  cleanup() {
    const days = this.db.settings.retentionDays || 0;
    let removedMessages = 0, removedRoomMsgs = 0;
    if (days > 0) {
      const cutoff = Date.now() - days * 86400000;
      const beforeM = this.db.messages.length;
      this.db.messages = this.db.messages.filter(m => m.time >= cutoff);
      removedMessages = beforeM - this.db.messages.length;
      const beforeR = this.db.roomMsgs.length;
      this.db.roomMsgs = this.db.roomMsgs.filter(m => m.time >= cutoff);
      removedRoomMsgs = beforeR - this.db.roomMsgs.length;
    }
    const referenced = new Set();
    const collect = (atts) => {
      for (const a of atts || []) {
        const mm = /^\/files\/([a-f0-9]+)\//.exec(a.url);
        if (mm) referenced.add(mm[1]);
      }
    };
    // 본문(서식 HTML)에 삽입된 이미지도 참조로 인정 — 없으면 본문 이미지가 지워짐
    const collectHtml = (html) => {
      if (!html) return;
      const re = /\/files\/([a-f0-9]+)\//g;
      let mm;
      while ((mm = re.exec(html))) referenced.add(mm[1]);
    };
    for (const m of this.db.messages) { collect(m.attachments); collectHtml(m.html); }
    for (const m of this.db.roomMsgs) { collect(m.attachments); collectHtml(m.html); }
    for (const s of this.db.scheduled) { collect(s.attachments); collectHtml(s.html); }
    // 공지·예약 공지의 첨부도 보존 (누락 시 공지 첨부가 다운로드되지 않음)
    for (const n of this.db.notices) { collect(n.attachments); collectHtml(n.body); }
    for (const n of this.db.scheduledNotices) { collect(n.attachments); collectHtml(n.body); }
    let removedFiles = 0, freedBytes = 0;
    const graceMs = 3600000; // 업로드 직후(전송 전) 파일 보호: 1시간 유예
    try {
      for (const f of fs.readdirSync(this.uploadDir)) {
        if (referenced.has(f)) continue;
        const fp = path.join(this.uploadDir, f);
        try {
          const st = fs.statSync(fp);
          if (Date.now() - st.mtimeMs < graceMs) continue;
          fs.unlinkSync(fp);
          removedFiles++; freedBytes += st.size;
        } catch (e) {}
      }
    } catch (e) {}
    if (removedMessages || removedRoomMsgs) this._saveSoon();
    if (removedMessages || removedRoomMsgs || removedFiles) {
      this.log(`보관함 정리: 쪽지 ${removedMessages}건, 채팅 ${removedRoomMsgs}건, 파일 ${removedFiles}개 삭제`);
    }
    return { removedMessages, removedRoomMsgs, removedFiles, freedBytes };
  }

  // ---------- 채팅방 ----------
  _cleanAttachments(list) {
    return (Array.isArray(list) ? list : [])
      .slice(0, 10)
      .map(a => ({ name: String(a.name || 'file').slice(0, 200), size: Number(a.size) || 0, url: String(a.url || '') }))
      .filter(a => a.url.startsWith('/files/'));
  }

  _roomHistory(roomId, viewerId) {
    return this.db.roomMsgs.filter(m => m.roomId === roomId).slice(-100)
      .map(m => this._roomMsgView(m, viewerId));
  }

  // 채팅방 메시지를 참여자별로 전송 (설문이 있으면 각자 볼 수 있는 형태로)
  _sendRoomMsg(room, m, type = 'room_message') {
    for (const uid of room.members) this._sendTo(uid, { type, message: this._roomMsgView(m, uid) });
  }

  _pushRoomSystemMsg(room, text) {
    const m = { id: newId(), roomId: room.id, from: '', text, attachments: [], time: Date.now(), system: true };
    this.db.roomMsgs.push(m);
    for (const uid of room.members) this._sendTo(uid, { type: 'room_message', message: m });
  }

  _doCreateRoom(ws, msg) {
    const name = String(msg.name || '').trim().slice(0, 50);
    if (!name) return this._send(ws, { type: 'error', error: '채팅방 이름을 입력하세요.' });
    const members = [...new Set([ws.userId, ...(Array.isArray(msg.members) ? msg.members.map(String) : [])])]
      .filter(id => this.db.users.some(u => u.id === id));
    if (members.length < 2) return this._send(ws, { type: 'error', error: '채팅방에는 본인 외 1명 이상이 필요합니다.' });
    const room = { id: newId(), name, creator: ws.userId, members, time: Date.now() };
    this.db.rooms.push(room);
    this._saveSoon();
    for (const uid of members) this._sendTo(uid, { type: 'room_created', room, history: [] });
    const creator = this.db.users.find(u => u.id === ws.userId);
    this._pushRoomSystemMsg(room, `${creator ? creator.name : ws.userId} 님이 채팅방을 만들었습니다.`);
  }

  _doRoomMessage(ws, msg) {
    const room = this.db.rooms.find(r => r.id === msg.roomId);
    if (!room || !room.members.includes(ws.userId)) return;
    const text = String(msg.text || '').slice(0, MAX_TEXT_LEN);
    const attachments = this._cleanAttachments(msg.attachments);
    if (!text.trim() && !attachments.length) return;
    const m = { id: newId(), roomId: room.id, from: ws.userId, text, attachments, time: Date.now() };
    this.db.roomMsgs.push(m);
    this._saveSoon();
    this._sendRoomMsg(room, m);
  }

  // 채팅방 설문 만들기 — 채팅방 참여자만 대상이 되는 소규모 설문
  _doRoomPoll(ws, msg) {
    const room = this.db.rooms.find(r => r.id === msg.roomId);
    if (!room || !room.members.includes(ws.userId)) return;
    const { poll, error } = this._parsePoll(msg.poll);
    if (error) return this._send(ws, { type: 'error', error });
    if (!poll) return this._send(ws, { type: 'error', error: '설문 항목을 입력하세요.' });
    const user = this.db.users.find(u => u.id === ws.userId);
    const m = {
      id: newId(), roomId: room.id, from: ws.userId,
      text: '📊 설문: ' + (poll.q || poll.options.join(' / ')),
      attachments: [], poll, time: Date.now()
    };
    this.db.roomMsgs.push(m);
    this._saveSoon();
    this.log(`채팅방 설문: "${poll.q}" — ${user ? user.name : ws.userId} (${room.name}, 대상 ${room.members.length}명)`);
    this._sendRoomMsg(room, m);
  }

  _doVoteRoomPoll(ws, msg) {
    const room = this.db.rooms.find(r => r.id === msg.roomId);
    if (!room || !room.members.includes(ws.userId)) return;
    const m = this.db.roomMsgs.find(x => x.id === msg.msgId && x.roomId === room.id);
    if (!m || !m.poll) return;
    const error = this._applyVote(m.poll, ws.userId, msg.options);
    if (error) return this._send(ws, { type: 'error', error });
    this._saveSoon();
    this._sendRoomMsg(room, m, 'room_message_updated');
  }

  _doAddRoomMembers(ws, msg) {
    const room = this.db.rooms.find(r => r.id === msg.roomId);
    if (!room || !room.members.includes(ws.userId)) return;
    const add = [...new Set((Array.isArray(msg.members) ? msg.members.map(String) : []))]
      .filter(id => this.db.users.some(u => u.id === id) && !room.members.includes(id));
    if (!add.length) return;
    room.members.push(...add);
    this._saveSoon();
    for (const uid of add) {
      this._sendTo(uid, { type: 'room_created', room, history: this._roomHistory(room.id, uid) });
    }
    for (const uid of room.members) {
      if (!add.includes(uid)) this._sendTo(uid, { type: 'room_updated', room });
    }
    const names = add.map(id => { const u = this.db.users.find(x => x.id === id); return u ? u.name : id; }).join(', ');
    this._pushRoomSystemMsg(room, `${names} 님이 초대되었습니다.`);
  }

  _doLeaveRoom(ws, msg) {
    const room = this.db.rooms.find(r => r.id === msg.roomId);
    if (!room || !room.members.includes(ws.userId)) return;
    const leaver = this.db.users.find(u => u.id === ws.userId);
    room.members = room.members.filter(x => x !== ws.userId);
    this._sendTo(ws.userId, { type: 'room_removed', roomId: room.id });
    if (!room.members.length) {
      this.db.rooms = this.db.rooms.filter(r => r.id !== room.id);
      this.db.roomMsgs = this.db.roomMsgs.filter(m => m.roomId !== room.id);
    } else {
      for (const uid of room.members) this._sendTo(uid, { type: 'room_updated', room });
      this._pushRoomSystemMsg(room, `${leaver ? leaver.name : ws.userId} 님이 나갔습니다.`);
    }
    this._saveSoon();
  }

  _doPostNotice(ws, msg) {
    const user = this.db.users.find(u => u.id === ws.userId);
    if (!user) return;
    const title = String(msg.title || '').trim().slice(0, 200);
    const body = String(msg.body || '').slice(0, MAX_TEXT_LEN);
    if (!title) return;
    // 설문조사 (선택): 항목 2개 이상 + 미래의 마감 시각 + 복수선택/투표자 공개 여부
    const parsed = this._parsePoll(msg.poll);
    if (parsed.error) return this._send(ws, { type: 'error', error: parsed.error });
    const poll = parsed.poll;
    // 공지 첨부파일 (선택)
    const attachments = this._cleanAttachments(msg.attachments);
    // 예약 공지 (선택)
    const publishAt = Number(msg.publishAt) || 0;
    if (publishAt > Date.now() + 20000) {
      const item = {
        id: newId(), authorId: user.id, authorName: user.name,
        title, body, poll, attachments, publishAt, created: Date.now()
      };
      this.db.scheduledNotices.push(item);
      this._saveSoon();
      return this._send(ws, { type: 'notice_scheduled', item });
    }
    const n = {
      id: newId(), authorId: user.id, authorName: user.name,
      title, body, attachments, time: Date.now()
    };
    if (poll) n.poll = poll;
    this.db.notices.push(n);
    this._saveSoon();
    this.log(`공지 등록: "${title}" — ${user.name}${poll ? ' (설문 포함)' : ''}${attachments.length ? ` (첨부 ${attachments.length}개)` : ''}`);
    this._broadcastNotice('notice', n);
  }

  // 공지 수정 (작성자 본인 또는 관리자)
  _doEditNotice(ws, msg) {
    const user = this.db.users.find(u => u.id === ws.userId);
    const n = this.db.notices.find(x => x.id === msg.noticeId);
    if (!user || !n) return;
    if (!user.admin && n.authorId !== user.id) {
      return this._send(ws, { type: 'error', error: '공지를 수정할 권한이 없습니다.' });
    }
    const title = String(msg.title || '').trim().slice(0, 200);
    if (!title) return this._send(ws, { type: 'error', error: '제목을 입력하세요.' });
    n.title = title;
    n.body = String(msg.body || '').slice(0, MAX_TEXT_LEN);
    n.attachments = this._cleanAttachments(msg.attachments);
    n.edited = Date.now();
    n.editedBy = user.name;
    // 설문 마감 시각만 연장/변경 가능 (기존 투표·항목·선택 방식은 그대로)
    if (n.poll && msg.pollDeadline) {
      const dl = Number(msg.pollDeadline) || 0;
      if (dl > Date.now()) {
        n.poll.deadline = dl;
        n.poll.resultSent = false; // 마감을 다시 미뤘으면 결과도 다시 가려지고, 새 마감 때 다시 공개
      }
    }
    this._saveSoon();
    this.log(`공지 수정: "${title}" — ${user.name}`);
    this._broadcastNotice('notice_updated', n);
  }

  _doVotePoll(ws, msg) {
    const n = this.db.notices.find(x => x.id === msg.noticeId);
    if (!n || !n.poll) return;
    // 예전 클라이언트는 option(단일 번호), 새 클라이언트는 options(배열)로 보냄
    const error = this._applyVote(n.poll, ws.userId, msg.options !== undefined ? msg.options : msg.option);
    if (error) return this._send(ws, { type: 'error', error });
    this._saveSoon();
    this._broadcastNotice('notice_updated', n);
  }

  _doCancelScheduledNotice(ws, msg) {
    const user = this.db.users.find(u => u.id === ws.userId);
    const idx = this.db.scheduledNotices.findIndex(n => n.id === msg.id);
    if (idx < 0 || !user) return;
    if (this.db.scheduledNotices[idx].authorId !== user.id && !user.admin) return;
    this.db.scheduledNotices.splice(idx, 1);
    this._saveSoon();
    this._send(ws, { type: 'scheduled_notice_cancelled', id: msg.id });
  }

  // 내 정보(과목/전화/이메일) 수정 — 본인만
  _doUpdateProfile(ws, msg) {
    const u = this.db.users.find(x => x.id === ws.userId);
    if (!u) return;
    // 본인 부서(조직) 변경 허용
    if (msg.dept !== undefined && String(msg.dept).trim()) {
      u.depts = parseDepts(msg.dept);
      u.dept = u.depts[0];
    }
    const details = {};
    for (const f of Object.keys(USER_DETAIL_FIELDS)) details[f] = msg[f] || '';
    this._applyUserDetails(u, details);
    this._saveSoon();
    this._broadcastUsers();
    this._send(ws, { type: 'profile_updated' });
  }

  // ---------- 회원가입 요청 ----------
  _doSignupRequest(ws, msg) {
    const reply = (ok, error) => this._send(ws, { type: 'signup_result', ok, error });
    const id = String(msg.id || '').trim();
    if (!/^[a-zA-Z0-9가-힣_.-]{2,30}$/.test(id)) return reply(false, '아이디는 한글/영문/숫자 2~30자여야 합니다.');
    if (this.db.users.some(u => u.id === id)) return reply(false, '이미 사용 중인 아이디입니다.');
    if (this.db.signups.some(s => s.id === id)) return reply(false, '이미 가입 요청이 접수된 아이디입니다.\n관리자 승인을 기다려 주세요.');
    // 필수: 아이디/비밀번호/이름/부서/직위/사무실전화 (과목·핸드폰·이메일은 선택)
    for (const f of ['pw', 'name', 'dept', 'position', 'phone']) {
      if (!String(msg[f] || '').trim()) return reply(false, '필수 정보를 모두 입력하세요.');
    }
    if (String(msg.pw).length < 4) return reply(false, '비밀번호는 4자 이상이어야 합니다.');
    const salt = newId();
    const cut = (v, n) => String(v || '').trim().slice(0, n);
    const s = {
      reqId: newId(), id, salt, pw: hashPw(String(msg.pw), salt),
      name: cut(msg.name, 30), dept: cut(msg.dept, 60), position: cut(msg.position, 30),
      subject: cut(msg.subject, 50),
      phone: cut(msg.phone, 30), mobile: cut(msg.mobile, 30), email: cut(msg.email, 60),
      time: Date.now()
    };
    this.db.signups.push(s);
    this._saveSoon();
    this.log(`회원가입 요청: ${s.name}(${id}) — ${s.dept} ${s.position}`);
    this._statusChanged();
    reply(true);
    // 접속 중인 관리자 권한 사용자들에게 알림 + 대기 목록 갱신 (메신저에서 바로 승인 가능)
    for (const u of this.db.users) {
      if (u.admin && this.sockets.has(u.id)) {
        this._sendTo(u.id, { type: 'signup_alert', name: s.name, id: s.id, dept: s.dept, position: s.position });
      }
    }
    this._notifyAdminsSignups();
  }

  // 접속 중인 관리자들에게 가입 대기 목록을 보냄 (서버 화면에서 처리해도 즉시 반영)
  _notifyAdminsSignups() {
    const list = this.listSignups();
    for (const u of this.db.users) {
      if (u.admin && this.sockets.has(u.id)) this._sendTo(u.id, { type: 'signups', list });
    }
  }

  _doListSignups(ws) {
    if (!this._requireAdmin(ws)) return;
    this._send(ws, { type: 'signups', list: this.listSignups() });
  }

  _doApproveSignup(ws, msg) {
    const admin = this._requireAdmin(ws);
    if (!admin) return this._send(ws, { type: 'error', error: '관리자 권한이 필요합니다.' });
    const req = this.db.signups.find(s => s.reqId === msg.reqId);
    try {
      const id = this.approveSignup(String(msg.reqId || ''));
      this.log(`회원가입 승인(메신저): ${id} — 처리자 ${admin.name}`);
      this._send(ws, { type: 'signup_handled', ok: true, action: 'approve', name: req ? req.name : id, id });
    } catch (e) {
      this._send(ws, { type: 'signup_handled', ok: false, error: e.message });
    }
    this._notifyAdminsSignups();
    this._statusChanged();
  }

  _doRejectSignup(ws, msg) {
    const admin = this._requireAdmin(ws);
    if (!admin) return this._send(ws, { type: 'error', error: '관리자 권한이 필요합니다.' });
    const req = this.db.signups.find(s => s.reqId === msg.reqId);
    try {
      this.rejectSignup(String(msg.reqId || ''));
      this.log(`회원가입 거절(메신저): ${req ? req.id : msg.reqId} — 처리자 ${admin.name}`);
      this._send(ws, { type: 'signup_handled', ok: true, action: 'reject', name: req ? req.name : '' });
    } catch (e) {
      this._send(ws, { type: 'signup_handled', ok: false, error: e.message });
    }
    this._notifyAdminsSignups();
  }

  listSignups() {
    return this.db.signups.map(s => ({
      reqId: s.reqId, id: s.id, name: s.name, dept: s.dept, position: s.position,
      subject: s.subject || '', phone: s.phone, mobile: s.mobile, email: s.email, time: s.time
    }));
  }

  approveSignup(reqId) {
    const idx = this.db.signups.findIndex(s => s.reqId === reqId);
    if (idx < 0) throw new Error('요청을 찾을 수 없습니다.');
    const s = this.db.signups[idx];
    this.db.signups.splice(idx, 1);
    if (this.db.users.some(u => u.id === s.id)) {
      this._saveSoon();
      throw new Error('이미 존재하는 아이디라 요청을 삭제했습니다: ' + s.id);
    }
    const depts = parseDepts(s.dept);
    this.db.users.push({
      id: s.id, name: s.name, dept: depts[0], depts, position: s.position || '',
      office: '', subject: s.subject || '',
      phone: s.phone || '', mobile: s.mobile || '', email: s.email || '',
      admin: false, salt: s.salt, pw: s.pw
    });
    this._saveSoon();
    this.log(`회원가입 승인: ${s.name}(${s.id})`);
    this._broadcastUsers();
    this._notifyAdminsSignups();
    return s.id;
  }

  rejectSignup(reqId) {
    const idx = this.db.signups.findIndex(s => s.reqId === reqId);
    if (idx < 0) throw new Error('요청을 찾을 수 없습니다.');
    const s = this.db.signups.splice(idx, 1)[0];
    this._saveSoon();
    this.log(`회원가입 거절: ${s.name}(${s.id})`);
    this._notifyAdminsSignups();
    this._statusChanged();
  }

  // ---------- 부서(그룹) 표시 순서 ----------
  getDeptOrder() {
    return this.db.settings.deptOrder || [];
  }

  setDeptOrder(order) {
    this.db.settings.deptOrder =
      (Array.isArray(order) ? order.map(s => String(s).slice(0, 60)) : []).slice(0, 200);
    this._saveSoon();
    this._broadcast({ type: 'dept_order', order: this.db.settings.deptOrder });
    return this.db.settings.deptOrder;
  }

  // ---------- 조직도 순서/부서 이름 (관리자 권한 사용자) ----------
  _doSetDeptOrder(ws, msg) {
    if (!this._requireAdmin(ws)) return this._send(ws, { type: 'error', error: '관리자 권한이 필요합니다.' });
    this.setDeptOrder(msg.order);
    this.log(`부서 순서 변경 — ${this._userLabel(ws.userId)}`);
  }

  _doSetUserOrder(ws, msg) {
    if (!this._requireAdmin(ws)) return this._send(ws, { type: 'error', error: '관리자 권한이 필요합니다.' });
    const dept = String(msg.dept || '').slice(0, 60);
    if (!dept) return;
    const order = (Array.isArray(msg.order) ? msg.order.map(String) : []).slice(0, 500);
    this.db.settings.userOrder = this.db.settings.userOrder || {};
    this.db.settings.userOrder[dept] = order;
    this._saveSoon();
    this._broadcast({ type: 'user_order', userOrder: this.db.settings.userOrder });
    this.log(`'${dept}' 부서 내 사용자 순서 변경 — ${this._userLabel(ws.userId)}`);
  }

  _doRenameDept(ws, msg) {
    if (!this._requireAdmin(ws)) return this._send(ws, { type: 'error', error: '관리자 권한이 필요합니다.' });
    const from = [...new Set((Array.isArray(msg.from) ? msg.from : [msg.from])
      .map(s => String(s || '').trim()).filter(Boolean))];
    const to = String(msg.to || '').trim().slice(0, 60);
    if (!from.length || !to) return this._send(ws, { type: 'error', error: '부서 이름을 입력하세요.' });
    let count = 0;
    for (const u of this.db.users) {
      const depts = u.depts || [u.dept];
      if (depts.some(d => from.includes(d))) {
        u.depts = [...new Set(depts.map(d => (from.includes(d) ? to : d)))];
        u.dept = u.depts[0];
        count++;
      }
    }
    // 비어 있는(추가만 된) 부서 이름도 함께 변경
    const ex = this.db.settings.extraDepts || [];
    this.db.settings.extraDepts = [...new Set(ex.map(d => (from.includes(d) ? to : d)))];
    // 부서 순서 목록 갱신: 첫 번째 대상 위치에 새 이름을 넣음
    const ord = this.db.settings.deptOrder || [];
    const idx = ord.findIndex(d => from.includes(d));
    const newOrd = ord.filter(d => !from.includes(d) && d !== to);
    newOrd.splice(idx >= 0 ? Math.min(idx, newOrd.length) : newOrd.length, 0, to);
    this.db.settings.deptOrder = newOrd;
    // 부서 내 사용자 순서 병합
    const uo = this.db.settings.userOrder || {};
    const merged = [];
    for (const f of [to, ...from]) {
      if (uo[f]) { merged.push(...uo[f]); if (f !== to) delete uo[f]; }
    }
    if (merged.length) uo[to] = [...new Set(merged)];
    this._saveSoon();
    this.log(`부서 이름 변경: ${from.join(', ')} → ${to} (${count}명) — ${this._userLabel(ws.userId)}`);
    this._broadcastUsers();
    this._broadcast({ type: 'dept_order', order: this.db.settings.deptOrder });
    this._broadcast({ type: 'user_order', userOrder: uo });
    this._broadcast({ type: 'extra_depts', list: this.db.settings.extraDepts });
  }

  // 빈 부서 추가/삭제 (관리자) — 사용자가 없어도 조직도에 표시되어 드래그로 배치 가능
  _doAddDept(ws, msg) {
    if (!this._requireAdmin(ws)) return this._send(ws, { type: 'error', error: '관리자 권한이 필요합니다.' });
    const name = String(msg.name || '').trim().slice(0, 60);
    if (!name) return this._send(ws, { type: 'error', error: '부서 이름을 입력하세요.' });
    const exists = this.db.settings.extraDepts.includes(name) ||
      this.db.users.some(u => (u.depts || [u.dept]).includes(name));
    if (exists) return this._send(ws, { type: 'error', error: '이미 존재하는 부서입니다: ' + name });
    this.db.settings.extraDepts.push(name);
    this._saveSoon();
    this.log(`부서 추가: ${name} — ${this._userLabel(ws.userId)}`);
    this._broadcast({ type: 'extra_depts', list: this.db.settings.extraDepts });
  }

  _doDeleteDept(ws, msg) {
    if (!this._requireAdmin(ws)) return this._send(ws, { type: 'error', error: '관리자 권한이 필요합니다.' });
    const name = String(msg.name || '').trim();
    if (this.db.users.some(u => (u.depts || [u.dept]).includes(name))) {
      return this._send(ws, { type: 'error', error: '소속된 사용자가 있는 부서는 삭제할 수 없습니다.' });
    }
    this.db.settings.extraDepts = this.db.settings.extraDepts.filter(d => d !== name);
    this._saveSoon();
    this.log(`부서 삭제: ${name} — ${this._userLabel(ws.userId)}`);
    this._broadcast({ type: 'extra_depts', list: this.db.settings.extraDepts });
  }

  // ---------- 사용자 그룹 (개인별) ----------
  _doSaveGroup(ws, msg) {
    const name = String(msg.name || '').trim().slice(0, 40);
    const members = [...new Set(Array.isArray(msg.members) ? msg.members.map(String) : [])]
      .filter(id => this.db.users.some(u => u.id === id) && id !== ws.userId)
      .slice(0, 200);
    if (!name) return this._send(ws, { type: 'error', error: '그룹 이름을 입력하세요.' });
    if (!members.length) return this._send(ws, { type: 'error', error: '그룹 구성원을 1명 이상 선택하세요.' });
    let g;
    if (msg.id) {
      g = this.db.userGroups.find(x => x.id === msg.id && x.owner === ws.userId);
      if (!g) return;
      g.name = name;
      g.members = members;
    } else {
      g = { id: newId(), owner: ws.userId, name, members };
      this.db.userGroups.push(g);
    }
    this._saveSoon();
    this._send(ws, { type: 'group_saved', group: g });
  }

  _doDeleteGroup(ws, msg) {
    const idx = this.db.userGroups.findIndex(x => x.id === msg.id && x.owner === ws.userId);
    if (idx < 0) return;
    this.db.userGroups.splice(idx, 1);
    this._saveSoon();
    this._send(ws, { type: 'group_deleted', id: msg.id });
  }

  // 내 사용자 그룹 순서 바꾸기 — ids 순서대로, 목록에 없는 그룹은 기존 순서대로 뒤에 둔다
  // (다른 사람의 그룹은 배열 속 자리를 그대로 둔 채 내 그룹 자리에만 새 순서를 채운다)
  _doReorderGroups(ws, msg) {
    const ids = (Array.isArray(msg.ids) ? msg.ids.map(String) : []).slice(0, 500);
    const mine = this.db.userGroups.filter(g => g.owner === ws.userId);
    if (mine.length < 2) return;
    const rank = (g) => { const i = ids.indexOf(g.id); return i < 0 ? 1e6 + mine.indexOf(g) : i; };
    const sorted = [...mine].sort((a, b) => rank(a) - rank(b));
    let k = 0;
    this.db.userGroups = this.db.userGroups.map(g => (g.owner === ws.userId ? sorted[k++] : g));
    this._saveSoon();
    this._send(ws, { type: 'groups_reordered', ids: sorted.map(g => g.id) });
  }

  // ---------- 클라이언트에서의 조직 관리 (관리자 권한 사용자) ----------
  _adminResult(ws, action, fn) {
    if (!this._requireAdmin(ws)) {
      return this._send(ws, { type: 'admin_result', action, ok: false, error: '관리자 권한이 없습니다.' });
    }
    try {
      fn();
      this._send(ws, { type: 'admin_result', action, ok: true });
    } catch (e) {
      this._send(ws, { type: 'admin_result', action, ok: false, error: e.message });
    }
  }

  _doAdminAddUser(ws, msg) {
    this._adminResult(ws, 'add', () => this.addUser(msg.user || {}));
  }

  _doAdminUpdateUser(ws, msg) {
    this._adminResult(ws, 'update', () => {
      this.updateUser(String(msg.id || ''), msg.patch || {});
      if (msg.newPw) this.resetPw(String(msg.id), String(msg.newPw));
    });
  }

  _doAdminDeleteUser(ws, msg) {
    this._adminResult(ws, 'delete', () => this.deleteUser(String(msg.id || '')));
  }

  _doDeleteNotice(ws, msg) {
    const user = this.db.users.find(u => u.id === ws.userId);
    const idx = this.db.notices.findIndex(n => n.id === msg.noticeId);
    if (idx < 0 || !user) return;
    if (!user.admin && this.db.notices[idx].authorId !== user.id) return;
    this.db.notices.splice(idx, 1);
    this._saveSoon();
    this._broadcast({ type: 'notice_deleted', noticeId: msg.noticeId });
  }

  _doChangePw(ws, msg) {
    const user = this.db.users.find(u => u.id === ws.userId);
    if (!user) return;
    if (hashPw(String(msg.oldPw || ''), user.salt) !== user.pw) {
      return this._send(ws, { type: 'change_pw_result', ok: false, error: '현재 비밀번호가 올바르지 않습니다.' });
    }
    const np = String(msg.newPw || '');
    if (np.length < 4) {
      return this._send(ws, { type: 'change_pw_result', ok: false, error: '비밀번호는 4자 이상이어야 합니다.' });
    }
    user.salt = newId();
    user.pw = hashPw(np, user.salt);
    this._saveSoon();
    this._send(ws, { type: 'change_pw_result', ok: true });
  }

  // ---------- 관리 기능 (관리자 UI에서 호출) ----------
  getStatus() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const list of Object.values(nets)) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
      }
    }
    return {
      running: !!this.httpServer,
      port: this.port,
      ips,
      userCount: this.db.users.length,
      online: [...this.sockets.keys()],
      messageCount: this.db.messages.length
    };
  }

  listUsers() {
    return this.db.users.map(u => this._publicUser(u));
  }

  // 세부 정보(사무실·과목·전화·핸드폰·이메일) 반영 — 넘어온 항목만 바꾼다
  _applyUserDetails(u, d) {
    for (const [f, max] of Object.entries(USER_DETAIL_FIELDS)) {
      if (d && d[f] !== undefined) u[f] = String(d[f] ?? '').trim().slice(0, max);
    }
  }

  addUser({ id, name, dept, position, pw, admin, ...details }) {
    id = String(id || '').trim();
    name = String(name || '').trim();
    if (!/^[a-zA-Z0-9가-힣_.-]{2,30}$/.test(id)) throw new Error('아이디는 한글/영문/숫자 2~30자여야 합니다: ' + id);
    if (!name) throw new Error('이름을 입력하세요.');
    if (this.db.users.some(u => u.id === id)) throw new Error('이미 존재하는 아이디입니다: ' + id);
    const salt = newId();
    const depts = parseDepts(dept);
    const u = {
      id, name,
      dept: depts[0], depts,
      position: String(position || '').trim(),
      admin: !!admin,
      salt, pw: hashPw(String(pw || '1234'), salt)
    };
    this._applyUserDetails(u, details);
    this.db.users.push(u);
    this._saveSoon();
    this.log(`계정 추가: ${name}(${id})`);
    this._broadcastUsers();
  }

  updateUser(id, { name, dept, position, admin, ...details }) {
    const u = this.db.users.find(x => x.id === id);
    if (!u) throw new Error('사용자가 없습니다.');
    if (name !== undefined) u.name = String(name).trim() || u.name;
    if (dept !== undefined) { u.depts = parseDepts(dept); u.dept = u.depts[0]; }
    if (position !== undefined) u.position = String(position).trim();
    if (admin !== undefined && !(u.id === 'admin' && !admin)) u.admin = !!admin;
    this._applyUserDetails(u, details);
    this._saveSoon();
    this.log(`계정 수정: ${u.name}(${id})`);
    this._broadcastUsers();
  }

  deleteUser(id) {
    if (id === 'admin') throw new Error('기본 관리자 계정은 삭제할 수 없습니다.');
    const idx = this.db.users.findIndex(u => u.id === id);
    if (idx < 0) throw new Error('사용자가 없습니다.');
    this.log(`계정 삭제: ${this.db.users[idx].name}(${id})`);
    this.db.users.splice(idx, 1);
    // 사용자 그룹 정리 (본인 소유 그룹 삭제, 다른 그룹에서 구성원 제거)
    this.db.userGroups = this.db.userGroups.filter(g => g.owner !== id);
    for (const g of this.db.userGroups) g.members = g.members.filter(m => m !== id);
    // 채팅방에서도 제거 (빈 방은 삭제)
    for (const room of [...this.db.rooms]) {
      if (!room.members.includes(id)) continue;
      room.members = room.members.filter(x => x !== id);
      if (!room.members.length) {
        this.db.rooms = this.db.rooms.filter(r => r.id !== room.id);
        this.db.roomMsgs = this.db.roomMsgs.filter(m => m.roomId !== room.id);
      } else {
        for (const uid of room.members) this._sendTo(uid, { type: 'room_updated', room });
      }
    }
    const ws = this.sockets.get(id);
    if (ws) {
      this._send(ws, { type: 'kicked', reason: '계정이 삭제되었습니다.' });
      try { ws.close(); } catch (e) {}
      this.sockets.delete(id);
    }
    this._saveSoon();
    this._broadcastUsers();
  }

  checkPassword(u, pw) {
    const a = Buffer.from(hashPw(String(pw || ''), u.salt)), b = Buffer.from(String(u.pw || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  resetPw(id, newPw) {
    const u = this.db.users.find(x => x.id === id);
    if (!u) throw new Error('사용자가 없습니다.');
    u.salt = newId();
    u.pw = hashPw(String(newPw || '1234'), u.salt);
    this._saveSoon();
  }

  // "아이디,이름,부서,직위[,비밀번호,담당과목,사무실위치,사무실전화,핸드폰,이메일]" 형식 여러 줄 일괄 등록
  bulkAdd(text) {
    const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let ok = 0; const errors = [];
    for (const line of lines) {
      const [id, name, dept, position, pw, subject, office, phone, mobile, email] = line.split(',').map(s => (s || '').trim());
      try {
        this.addUser({ id, name, dept, position, pw: pw || '1234', admin: false, subject, office, phone, mobile, email });
        ok++;
      } catch (e) { errors.push(line + ' → ' + e.message); }
    }
    return { ok, errors };
  }

  _broadcastUsers() {
    this._broadcast({ type: 'users', users: this.db.users.map(u => this._publicUser(u)) });
    this._statusChanged();
  }
}

module.exports = { MessengerServer };
