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

// 부서 문자열/배열 → 부서 배열 (쉼표/세미콜론으로 여러 부서 소속 가능)
function parseDepts(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,;]/);
  const out = [...new Set(arr.map(s => String(s).trim().slice(0, 60)).filter(Boolean))];
  return out.length ? out.slice(0, 10) : ['미지정'];
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
    this._saveTimer = null;
    this.onStatusChange = null; // 관리 UI 갱신 콜백
  }

  // ---------- DB ----------
  _loadDb() {
    try {
      const db = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
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
      return db;
    } catch (e) {
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
      fs.writeFileSync(this.dbFile, JSON.stringify(db, null, 1));
      return db;
    }
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.writeFileSync(this.dbFile, JSON.stringify(this.db, null, 1));
      } catch (e) { console.error('DB 저장 실패:', e); }
    }, 300);
  }

  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try { fs.writeFileSync(this.dbFile, JSON.stringify(this.db, null, 1)); } catch (e) {}
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

      app.get('/health', (req, res) => res.json({ ok: true, name: 'school-messenger' }));

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
      case 'add_room_members': return this._doAddRoomMembers(ws, msg);
      case 'leave_room': return this._doLeaveRoom(ws, msg);
      case 'post_notice': return this._doPostNotice(ws, msg);
      case 'edit_notice': return this._doEditNotice(ws, msg);
      case 'delete_notice': return this._doDeleteNotice(ws, msg);
      case 'vote_poll': return this._doVotePoll(ws, msg);
      case 'cancel_scheduled_notice': return this._doCancelScheduledNotice(ws, msg);
      case 'save_group': return this._doSaveGroup(ws, msg);
      case 'delete_group': return this._doDeleteGroup(ws, msg);
      case 'set_dept_order': return this._doSetDeptOrder(ws, msg);
      case 'set_user_order': return this._doSetUserOrder(ws, msg);
      case 'rename_dept': return this._doRenameDept(ws, msg);
      case 'add_dept': return this._doAddDept(ws, msg);
      case 'delete_dept': return this._doDeleteDept(ws, msg);
      case 'admin_add_user': return this._doAdminAddUser(ws, msg);
      case 'admin_update_user': return this._doAdminUpdateUser(ws, msg);
      case 'admin_delete_user': return this._doAdminDeleteUser(ws, msg);
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
      roomMsgs[r.id] = this.db.roomMsgs.filter(m => m.roomId === r.id).slice(-100);
    }
    this._send(ws, {
      type: 'login_ok',
      token,
      schoolName: this.schoolName || '',
      clientUpdate: this.clientUpdate ? this.clientUpdate.version : '',
      user: this._publicUser(user),
      users: this.db.users.map(u => this._publicUser(u)),
      messages: recent,
      notices: this.db.notices.slice(-100),
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

  _doRecallMessage(ws, msg) {
    const idx = this.db.messages.findIndex(x => x.id === msg.messageId);
    if (idx < 0 || this.db.messages[idx].from !== ws.userId) return;
    const m = this.db.messages[idx];
    if (m.readBy.length) {
      return this._send(ws, { type: 'recall_result', ok: false, error: '이미 읽은 사람이 있어 회수할 수 없습니다.' });
    }
    this.db.messages.splice(idx, 1);
    this._saveSoon();
    this._send(ws, { type: 'recall_result', ok: true });
    for (const uid of new Set([m.from, ...m.to])) {
      this._sendTo(uid, { type: 'message_recalled', messageId: m.id });
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
      readBy: []
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

  // ---------- 예약 발송 ----------
  _deliverDue() {
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
        this._broadcast({ type: 'notice', notice: n });
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
        attachments: s.attachments, time: Date.now(), readBy: [], scheduled: true
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
    for (const m of this.db.messages) collect(m.attachments);
    for (const m of this.db.roomMsgs) collect(m.attachments);
    for (const s of this.db.scheduled) collect(s.attachments);
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

  _roomHistory(roomId) {
    return this.db.roomMsgs.filter(m => m.roomId === roomId).slice(-100);
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
    for (const uid of room.members) this._sendTo(uid, { type: 'room_message', message: m });
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
      this._sendTo(uid, { type: 'room_created', room, history: this._roomHistory(room.id) });
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
    // 설문조사 (선택): 항목 2개 이상 + 미래의 마감 시각
    let poll = null;
    if (msg.poll && Array.isArray(msg.poll.options)) {
      const options = msg.poll.options.map(o => String(o).trim().slice(0, 100)).filter(Boolean).slice(0, 10);
      const deadline = Number(msg.poll.deadline) || 0;
      if (options.length < 2) return this._send(ws, { type: 'error', error: '설문 항목은 2개 이상이어야 합니다.' });
      if (deadline <= Date.now()) return this._send(ws, { type: 'error', error: '설문 마감 시각은 미래여야 합니다.' });
      poll = { options, deadline, votes: {} };
    }
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
    this._broadcast({ type: 'notice', notice: n });
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
    // 설문 마감 시각만 연장/변경 가능 (기존 투표 유지, 항목은 그대로)
    if (n.poll && msg.pollDeadline) {
      const dl = Number(msg.pollDeadline) || 0;
      if (dl > Date.now()) n.poll.deadline = dl;
    }
    this._saveSoon();
    this.log(`공지 수정: "${title}" — ${user.name}`);
    this._broadcast({ type: 'notice_updated', notice: n });
  }

  _doVotePoll(ws, msg) {
    const n = this.db.notices.find(x => x.id === msg.noticeId);
    if (!n || !n.poll) return;
    if (Date.now() > n.poll.deadline) {
      return this._send(ws, { type: 'error', error: '설문이 마감되었습니다.' });
    }
    const opt = Number(msg.option);
    if (!Number.isInteger(opt) || opt < 0 || opt >= n.poll.options.length) return;
    n.poll.votes[ws.userId] = opt;
    this._saveSoon();
    this._broadcast({ type: 'notice_updated', notice: n });
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
    u.office = String(msg.office || '').trim().slice(0, 50);
    u.subject = String(msg.subject || '').trim().slice(0, 50);
    u.phone = String(msg.phone || '').trim().slice(0, 30);
    u.mobile = String(msg.mobile || '').trim().slice(0, 30);
    u.email = String(msg.email || '').trim().slice(0, 60);
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
    // 접속 중인 관리자 권한 사용자들에게 알림
    for (const u of this.db.users) {
      if (u.admin && this.sockets.has(u.id)) {
        this._sendTo(u.id, { type: 'signup_alert', name: s.name, id: s.id, dept: s.dept, position: s.position });
      }
    }
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
    return s.id;
  }

  rejectSignup(reqId) {
    const idx = this.db.signups.findIndex(s => s.reqId === reqId);
    if (idx < 0) throw new Error('요청을 찾을 수 없습니다.');
    const s = this.db.signups.splice(idx, 1)[0];
    this._saveSoon();
    this.log(`회원가입 거절: ${s.name}(${s.id})`);
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

  addUser({ id, name, dept, position, pw, admin }) {
    id = String(id || '').trim();
    name = String(name || '').trim();
    if (!/^[a-zA-Z0-9가-힣_.-]{2,30}$/.test(id)) throw new Error('아이디는 한글/영문/숫자 2~30자여야 합니다: ' + id);
    if (!name) throw new Error('이름을 입력하세요.');
    if (this.db.users.some(u => u.id === id)) throw new Error('이미 존재하는 아이디입니다: ' + id);
    const salt = newId();
    const depts = parseDepts(dept);
    this.db.users.push({
      id, name,
      dept: depts[0], depts,
      position: String(position || '').trim(),
      admin: !!admin,
      salt, pw: hashPw(String(pw || '1234'), salt)
    });
    this._saveSoon();
    this.log(`계정 추가: ${name}(${id})`);
    this._broadcastUsers();
  }

  updateUser(id, { name, dept, position, admin }) {
    const u = this.db.users.find(x => x.id === id);
    if (!u) throw new Error('사용자가 없습니다.');
    if (name !== undefined) u.name = String(name).trim() || u.name;
    if (dept !== undefined) { u.depts = parseDepts(dept); u.dept = u.depts[0]; }
    if (position !== undefined) u.position = String(position).trim();
    if (admin !== undefined && !(u.id === 'admin' && !admin)) u.admin = !!admin;
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

  resetPw(id, newPw) {
    const u = this.db.users.find(x => x.id === id);
    if (!u) throw new Error('사용자가 없습니다.');
    u.salt = newId();
    u.pw = hashPw(String(newPw || '1234'), u.salt);
    this._saveSoon();
  }

  // "아이디,이름,부서,직위[,비밀번호]" 형식 여러 줄 일괄 등록
  bulkAdd(text) {
    const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let ok = 0; const errors = [];
    for (const line of lines) {
      const [id, name, dept, position, pw] = line.split(',').map(s => (s || '').trim());
      try {
        this.addUser({ id, name, dept, position, pw: pw || '1234', admin: false });
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
