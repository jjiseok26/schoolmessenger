'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// alert/confirm(네이티브 대화상자) 후 입력창 포커스가 깨지는 Electron 버그 우회:
// 대화상자가 닫힌 뒤 창 포커스를 재설정한다
{
  const _alert = window.alert.bind(window);
  const _confirm = window.confirm.bind(window);
  window.alert = (msg) => { const r = _alert(msg); window.native?.refocus(); return r; };
  window.confirm = (msg) => { const r = _confirm(msg); window.native?.refocus(); return r; };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 텍스트 속 URL을 클릭 가능한 링크로 변환 (기본 브라우저로 열림)
// http(s):// 뿐 아니라 www. 로 시작하는 주소도 인식
const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[^\s<>"']+)/g;
function linkifyRaw(text) {
  return text.replace(URL_RE, (u) => {
    const href = u.startsWith('www.') ? 'http://' + u : u;
    return `<a href="${href}" target="_blank" rel="noopener" class="ext-link">${u}</a>`;
  });
}
function linkify(s) {
  return linkifyRaw(esc(s));
}

// 이미 만들어진 HTML(서식 본문) 안의 텍스트 노드에서만 URL을 링크로 변환
function linkifyHtml(html) {
  const doc = new DOMParser().parseFromString('<div id="__lk">' + html + '</div>', 'text/html');
  const root = doc.getElementById('__lk');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!URL_RE.test(child.nodeValue)) continue;
        URL_RE.lastIndex = 0;
        const span = doc.createElement('span');
        span.innerHTML = linkifyRaw(esc(child.nodeValue));
        child.replaceWith(span);
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'A') {
        walk(child);
      }
    }
  };
  walk(root);
  return root.innerHTML;
}

// 이름 첫 글자 아바타 (아이디 기반 고정 색상)
const AV_COLORS = ['#1565c0', '#6a1b9a', '#2e7d32', '#ef6c00', '#c62828',
  '#00838f', '#4527a0', '#283593', '#00695c', '#8d6e63'];
function avColor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function avatarHtml(id, name, size) {
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px;background:${avColor(id)}">${esc((name || '?').charAt(0))}</span>`;
}

function fmtTime(t) {
  const d = new Date(t), now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

function fmtFull(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtSize(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + 'MB';
  if (n > 1024) return (n / 1024).toFixed(0) + 'KB';
  return n + 'B';
}

// ---------- 상태 ----------
const S = {
  server: '', serverList: [], serverIdx: 0, id: '', pw: '', token: '',
  initialTriesLeft: 0,
  me: null, users: [], messages: [], notices: [],
  rooms: [], roomMsgs: {}, currentRoom: null,
  scheduled: [], schedNotices: [], groups: [],
  sideTab: 'org', groupPick: new Set(), editingGroupId: null,
  adminEditId: null, openNoticeId: null, deptOrder: [],
  userOrder: {}, deptFlat: [], deptDisplayed: {},
  extraDepts: [], derivedDepts: new Set(),
  treeSel: new Set(), treeVisible: [],
  ws: null, loggedIn: false, intentionalClose: false,
  aesKey: null, recvChain: Promise.resolve(), sendChain: Promise.resolve(),
  tab: 'notice', chatPeer: null,
  recipients: new Set(), composeFileList: [], draftTimer: null,
  roomPick: new Set(), roomModalMode: 'create',
  chatFiles: [], roomFiles: [],   // 대화/채팅방에서 전송 대기 중인 첨부파일
  signups: [],                    // 관리자: 승인 대기 중인 회원가입 요청
  closedDepts: new Set(),
  reconnectTimer: null
};

const TABS = ['inbox', 'sent', 'chat', 'rooms', 'notice'];
const STATUS_LABEL = { online: '', away: '자리비움', class: '수업중', meeting: '회의중' };

// 알림음 (설정에서 켜고 끔)
const soundOn = () => localStorage.getItem('soundOff') !== '1';
function beep() {
  if (!soundOn()) return;
  try {
    const ctx = beep.ctx || (beep.ctx = new AudioContext());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.36);
  } catch (e) {}
}

const httpBase = () => 'http://' + S.server;
const userById = (id) => S.users.find(u => u.id === id);
const nameOf = (id) => { const u = userById(id); return u ? u.name : id; };
const noticeSeenKey = () => 'noticeSeen:' + S.server + ':' + S.id;
const roomSeenKey = (roomId) => 'roomSeen:' + S.server + ':' + S.id + ':' + roomId;
const roomById = (id) => S.rooms.find(r => r.id === id);

function roomUnread(roomId) {
  const seen = Number(localStorage.getItem(roomSeenKey(roomId)) || 0);
  return (S.roomMsgs[roomId] || []).filter(m => m.time > seen && m.from !== S.me.id && !m.system).length;
}

function markRoomSeen(roomId) {
  localStorage.setItem(roomSeenKey(roomId), String(Date.now()));
}

// 서버에서 지정한 부서 표시 순서 (미지정 부서는 뒤에 가나다순)
function deptSorter(a, b) {
  const ia = S.deptOrder.indexOf(a), ib = S.deptOrder.indexOf(b);
  const ra = ia < 0 ? 9999 : ia, rb = ib < 0 ? 9999 : ib;
  return ra - rb || a.localeCompare(b, 'ko');
}

// ---------- 메시지 암호화 (ECDH + AES-256-GCM, Web Crypto) ----------
const b64 = {
  enc: (u8) => btoa(String.fromCharCode(...u8)),
  dec: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
};
// 서버가 보낸 hello(공개키)로 세션 키를 확립하고, 내 공개키를 서버로 보냄
async function doKeyExchange(serverPubB64) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const myPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const serverKey = await crypto.subtle.importKey('raw', b64.dec(serverPubB64),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, kp.privateKey, 256);
  const keyBytes = await crypto.subtle.digest('SHA-256', bits); // 서버와 동일: SHA-256(공유비밀)
  S.aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  // 내 공개키 전송 (평문) → 이후 모든 메시지 암호화
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'key', pub: b64.enc(myPub) }));
}
async function encryptMsg(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.aesKey,
    new TextEncoder().encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12); // iv + ciphertext + tag
  return b64.enc(out);
}
async function decryptMsg(b64str) {
  const buf = b64.dec(b64str);
  const iv = buf.slice(0, 12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, S.aesKey, buf.slice(12));
  return new TextDecoder().decode(pt);
}

// ---------- 접속 ----------
function connect() {
  S.intentionalClose = false;
  S.aesKey = null;
  S.recvChain = Promise.resolve();
  S.sendChain = Promise.resolve();
  let url;
  try { url = new URL('ws://' + S.server + '/ws'); } catch (e) {
    return loginFail('서버 주소 형식이 올바르지 않습니다.');
  }
  const ws = new WebSocket(url);
  S.ws = ws;
  ws.onopen = () => {}; // 서버의 hello(키교환)를 기다린 뒤 login 전송
  ws.onmessage = (ev) => {
    // 수신은 순서 보장을 위해 체인으로 처리 (복호화가 비동기)
    S.recvChain = S.recvChain.then(async () => {
      if (ws !== S.ws) return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.e && S.aesKey) { try { m = JSON.parse(await decryptMsg(m.e)); } catch (e) { return; } }
      if (m.type === 'hello') {
        await doKeyExchange(m.pub);
        // 키 확립 후 로그인
        send({ type: 'login', id: S.id, pw: S.pw });
        return;
      }
      handleServer(m);
    }).catch(e => console.error('수신 처리 오류:', e));
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    S.ws = null;
    if (S.intentionalClose) return;
    if (S.loggedIn) {
      // 재접속: 저장된 서버 주소(유선/무선 등)를 번갈아 시도
      $('#connBanner').style.display = '';
      rotateServer();
      $('#connBanner').textContent = `서버 연결이 끊어졌습니다. 재접속 중… (${S.server})`;
      S.reconnectTimer = setTimeout(connect, 4000);
    } else if (S.initialTriesLeft > 1) {
      // 최초 접속 실패: 다음 주소로 즉시 재시도
      S.initialTriesLeft--;
      rotateServer();
      $('#loginError').textContent = `연결 실패 — 다른 주소로 시도 중… (${S.server})`;
      connect();
    } else {
      loginFail('서버에 연결할 수 없습니다. 주소와 서버 실행 여부를 확인하세요.');
    }
  };
}

// 여러 서버 주소(유선/무선)를 순환
function rotateServer() {
  if (S.serverList.length > 1) {
    S.serverIdx = (S.serverIdx + 1) % S.serverList.length;
    S.server = S.serverList[S.serverIdx];
  }
}

function disconnect() {
  S.intentionalClose = true;
  if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
  if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
}

function send(obj) {
  if (!(S.ws && S.ws.readyState === 1)) return;
  const json = JSON.stringify(obj);
  if (!S.aesKey) { S.ws.send(json); return; }
  // 암호화는 비동기(Web Crypto) → 순서 보장을 위해 체인으로 전송
  const ws = S.ws;
  S.sendChain = S.sendChain.then(async () => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ e: await encryptMsg(json) }));
  }).catch(e => console.error('전송 암호화 오류:', e));
}

function loginFail(msg) {
  S.loggedIn = false;
  $('#loginError').textContent = msg;
  $('#loginBtn').disabled = false;
}

function handleServer(m) {
  switch (m.type) {
    case 'login_ok': {
      const wasReconnect = S.loggedIn;
      S.token = m.token; S.me = m.user; S.users = m.users;
      S.messages = m.messages; S.notices = m.notices;
      S.rooms = m.rooms || []; S.roomMsgs = m.roomMsgs || {};
      S.scheduled = m.scheduled || [];
      S.groups = m.groups || [];
      S.schedNotices = m.scheduledNotices || [];
      S.deptOrder = m.deptOrder || [];
      S.userOrder = m.userOrder || {};
      S.extraDepts = m.extraDepts || [];
      S.signups = m.signups || [];
      if (S.currentRoom && !roomById(S.currentRoom)) S.currentRoom = null;
      S.loggedIn = true;
      $('#connBanner').style.display = 'none';
      $('#statusSel').value = 'online';
      checkClientUpdate(m.clientUpdate);
      // 학교 이름 표시 (제목표시줄 + 헤더)
      document.title = m.schoolName ? m.schoolName + ' 메신저' : '학교메신저';
      $('.brand') && ($('.brand').textContent = '🏫 ' + (m.schoolName || '학교메신저'));
      S.initialTriesLeft = 0;
      if (!wasReconnect) {
        if ($('#loginSave').checked) saveCurrentConn(); // 접속 성공 시 접속 정보 자동 저장
        $('#loginView').style.display = 'none';
        $('#mainView').style.display = '';
        $('#myInfo').textContent = `${S.me.name} (${S.me.dept}${S.me.position ? ' · ' + S.me.position : ''})`;
        // 공지·설문 모두 누구나 작성 가능
        $('#noticeWriteBtn').style.display = '';
        $('#pollWriteBtn').style.display = '';
        $('#orgManageBtn').style.display = S.me.admin ? '' : 'none';
        if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
      }
      renderAll();
      // 첫 로그인 화면: 공지사항 탭이 먼저 보이도록
      if (!wasReconnect) showTab('notice');
      break;
    }
    case 'login_fail':
      S.loggedIn = false;
      disconnect();
      loginFail(m.error || '로그인 실패');
      break;
    case 'kicked':
      S.loggedIn = false;
      disconnect();
      backToLogin(m.reason || '연결이 종료되었습니다.');
      break;
    case 'new_message': {
      S.messages.push(m.message);
      const from = nameOf(m.message.from);
      notifyUser('📩 ' + from + ' 님의 쪽지',
        m.message.text.slice(0, 80) || '(첨부파일)',
        () => { showTab('inbox'); openDetail(m.message, 'inbox'); });
      // 대화 탭에서 해당 상대와 대화 중이면 바로 읽음 처리
      if (S.tab === 'chat' && S.chatPeer === m.message.from && document.hasFocus()) {
        send({ type: 'read', messageId: m.message.id });
        m.message.readBy.push(S.me.id);
      }
      renderAll();
      break;
    }
    case 'message_sent':
      S.messages.push(m.message);
      renderAll();
      break;
    case 'read_receipt': {
      const msg = S.messages.find(x => x.id === m.messageId);
      if (msg && !msg.readBy.includes(m.readerId)) msg.readBy.push(m.readerId);
      renderAll();
      break;
    }
    case 'presence': {
      const u = userById(m.id);
      if (u) { u.online = m.online; u.status = m.status || null; }
      renderTree(); renderChatHead();
      if (S.sideTab === 'groups') renderGroups();
      break;
    }
    case 'recall_result':
      if (!m.ok) alert(m.error || '회수하지 못했습니다.');
      break;
    case 'scheduled_added':
      S.scheduled.push(m.item);
      renderSent();
      break;
    case 'scheduled_sent':
      S.scheduled = S.scheduled.filter(s => s.id !== m.scheduledId);
      S.messages.push(m.message);
      renderSent(); renderChat();
      break;
    case 'scheduled_cancelled':
      S.scheduled = S.scheduled.filter(s => s.id !== m.id);
      renderSent();
      break;
    case 'message_recalled':
    case 'message_deleted':
      S.messages = S.messages.filter(x => x.id !== m.messageId);
      renderAll();
      break;
    case 'users':
      S.users = m.users;
      renderAll();
      renderAdminTable();
      break;
    case 'room_created': {
      if (!roomById(m.room.id)) S.rooms.push(m.room);
      if (!S.roomMsgs[m.room.id]) S.roomMsgs[m.room.id] = m.history || [];
      if (m.room.creator !== S.me.id) notifyUser('👥 채팅방 초대', `'${m.room.name}' 채팅방에 초대되었습니다.`);
      renderRooms(); updateBadges();
      break;
    }
    case 'room_message': {
      const msg = m.message;
      if (!S.roomMsgs[msg.roomId]) S.roomMsgs[msg.roomId] = [];
      S.roomMsgs[msg.roomId].push(msg);
      const viewing = S.tab === 'rooms' && S.currentRoom === msg.roomId && document.hasFocus();
      if (viewing) markRoomSeen(msg.roomId);
      else if (msg.from && msg.from !== S.me.id) {
        const room = roomById(msg.roomId);
        notifyUser(`👥 ${room ? room.name : '채팅방'} - ${nameOf(msg.from)}`,
          msg.text.slice(0, 80) || '(첨부파일)',
          () => { showTab('rooms'); openRoom(msg.roomId); });
      }
      renderRooms(); updateBadges();
      break;
    }
    case 'room_message_updated': {
      // 채팅방 설문 투표 결과 갱신
      const msg = m.message;
      const list = S.roomMsgs[msg.roomId] || [];
      const i = list.findIndex(x => x.id === msg.id);
      if (i >= 0) list[i] = msg;
      if (S.currentRoom === msg.roomId) renderRoomChat();
      break;
    }
    case 'room_updated': {
      const idx = S.rooms.findIndex(r => r.id === m.room.id);
      if (idx >= 0) S.rooms[idx] = m.room; else S.rooms.push(m.room);
      renderRooms();
      break;
    }
    case 'room_removed':
      S.rooms = S.rooms.filter(r => r.id !== m.roomId);
      delete S.roomMsgs[m.roomId];
      if (S.currentRoom === m.roomId) S.currentRoom = null;
      renderRooms(); updateBadges();
      break;
    case 'notice':
      S.notices.push(m.notice);
      S.schedNotices = S.schedNotices.filter(x => x.id !== m.notice.id); // 예약 공지가 발행된 경우
      if (m.notice.authorId !== S.me.id) {
        notifyUser('📢 공지: ' + m.notice.title, m.notice.body.slice(0, 80),
          () => { showTab('notice'); openNoticeDetail(m.notice); });
      }
      renderNotices(); updateBadges();
      break;
    case 'notice_deleted':
      S.notices = S.notices.filter(n => n.id !== m.noticeId);
      renderNotices(); updateBadges();
      break;
    case 'notice_updated': {
      const i = S.notices.findIndex(n => n.id === m.notice.id);
      if (i >= 0) S.notices[i] = m.notice;
      renderNotices();
      if (S.openNoticeId === m.notice.id) openNoticeDetail(m.notice); // 열려 있으면 설문 결과 실시간 갱신
      break;
    }
    case 'notice_scheduled':
      S.schedNotices.push(m.item);
      renderNotices();
      break;
    case 'scheduled_notice_cancelled':
      S.schedNotices = S.schedNotices.filter(x => x.id !== m.id);
      renderNotices();
      break;
    case 'group_saved': {
      const i = S.groups.findIndex(g => g.id === m.group.id);
      if (i >= 0) S.groups[i] = m.group; else S.groups.push(m.group);
      renderGroups();
      break;
    }
    case 'group_deleted':
      S.groups = S.groups.filter(g => g.id !== m.id);
      renderGroups();
      break;
    case 'admin_result':
      if (!m.ok) {
        if ($('#adminModal').style.display !== 'none') $('#adminError').textContent = m.error || '실패했습니다.';
        else alert(m.error || '실패했습니다.');
      } else if ($('#adminModal').style.display !== 'none') {
        $('#adminError').textContent = '';
        resetAdminForm();
      }
      break;
    case 'change_pw_result':
      if (m.ok) { alert('저장되었습니다. (비밀번호 변경 완료)'); $('#profileModal').style.display = 'none'; }
      else $('#pwError').textContent = m.error || '비밀번호 변경 실패';
      break;
    case 'dept_order':
      S.deptOrder = m.order || [];
      renderTree();
      break;
    case 'user_order':
      S.userOrder = m.userOrder || {};
      renderTree();
      break;
    case 'extra_depts':
      S.extraDepts = m.list || [];
      renderTree();
      break;
    case 'signup_alert':
      // 관리자 권한 사용자에게만 서버가 보냄 — 알림을 누르면 승인 창이 바로 열림
      notifyUser('🔔 회원가입 요청', `${m.name}(${m.id}) — ${m.dept} ${m.position}\n클릭하면 승인 창이 열립니다.`,
        () => openSignupMgr());
      break;
    case 'signups':
      S.signups = m.list || [];
      renderSignups();
      break;
    case 'signup_handled':
      if (!m.ok) alert('처리하지 못했습니다.\n' + (m.error || ''));
      else if (m.action === 'approve') alert(`✔ ${m.name} 님의 가입을 승인했습니다.\n이제 아이디 "${m.id}"로 로그인할 수 있습니다.`);
      else alert(`${m.name} 님의 가입 요청을 거절했습니다.`);
      break;
    case 'error':
      console.warn('서버 오류:', m.error);
      break;
  }
}

// ---------- 클라이언트 자동 업데이트 ----------
function verNewer(a, b) { // a가 b보다 최신인가
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// 새 버전이 있으면 묻지 않고 백그라운드로 내려받고, 준비되면 상단 배너로 "재시작" 안내
async function checkClientUpdate(serverVer) {
  try {
    if (!serverVer || S.updatePrompted === serverVer) return;
    const mine = await window.native.getVersion();
    if (!verNewer(serverVer, mine)) return;
    S.updatePrompted = serverVer;
    const r = await window.native.downloadUpdate(httpBase() + '/client-update', serverVer);
    if (r && r.ready) showUpdateBanner(serverVer);
  } catch (e) {}
}

// 업데이트 준비 배너
function showUpdateBanner(version) {
  $('#updateVersion').textContent = 'v' + version;
  $('#updateBanner').style.display = '';
}
$('#updateRestartBtn').addEventListener('click', async () => {
  $('#updateRestartBtn').disabled = true;
  $('#updateRestartBtn').textContent = '설치 중… 잠시 후 자동으로 다시 시작됩니다';
  const ok = await window.native.installUpdate();
  if (!ok) {
    $('#updateRestartBtn').disabled = false;
    $('#updateRestartBtn').textContent = '🔄 지금 재시작하여 업데이트';
    alert('업데이트 파일을 찾을 수 없습니다. 다시 로그인하면 새로 내려받습니다.');
    S.updatePrompted = null;
    $('#updateBanner').style.display = 'none';
  }
});
$('#updateLaterBtn').addEventListener('click', () => {
  $('#updateBanner').style.display = 'none';
  // 배너를 닫아도 종료할 때 자동으로 설치되어 다음 실행 때 새 버전이 적용됨
});
window.native?.onUpdateReady?.((d) => showUpdateBanner(d.version));
window.native?.onUpdateFailed?.(() => { S.updatePrompted = null; }); // 다음 로그인 때 재시도

function backToLogin(msg) {
  disconnect();
  S.loggedIn = false;
  updateAppBadge(0);
  $('#mainView').style.display = 'none';
  $('#loginView').style.display = '';
  $('#loginBtn').disabled = false;
  if (msg) $('#loginError').textContent = msg;
}

function notifyUser(title, body, action) {
  window.native?.flash();
  beep();
  if (window.Notification && Notification.permission === 'granted') {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.native?.focusApp();
      if (action) try { action(); } catch (e) {}
    };
  }
}

// ---------- 렌더링 ----------
function renderAll() {
  renderTree();
  renderGroups();
  renderInbox();
  renderSent();
  renderChat();
  renderRooms();
  renderNotices();
  renderSignups();
  updateBadges();
}

function unreadInbox() {
  return S.messages.filter(m =>
    m.to.includes(S.me.id) && m.from !== S.me.id && !m.readBy.includes(S.me.id));
}

// 작업표시줄 아이콘 배지 + 트레이 아이콘 배지 (미확인 알림 개수)
const trayIconImg = new Image();
trayIconImg.src = '../icon.png';

function buildTrayBadgeUrl(count) {
  // 앱 아이콘 위에 빨간 숫자 배지를 합성한 트레이 아이콘
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  if (trayIconImg.complete && trayIconImg.naturalWidth) {
    g.drawImage(trayIconImg, 0, 0, 32, 32);
  } else {
    g.fillStyle = '#1565c0';
    g.fillRect(0, 0, 32, 32);
  }
  g.fillStyle = '#e53935';
  g.beginPath(); g.arc(21, 21, 11, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 13px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(count > 99 ? '99' : String(count), 21, 22);
  return c.toDataURL('image/png');
}

let lastBadgeCount = -1;
function updateAppBadge(count) {
  if (count === lastBadgeCount) return;
  lastBadgeCount = count;
  let dataUrl = null, trayUrl = null;
  if (count > 0) {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#e53935';
    g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 17px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(count > 99 ? '99' : String(count), 16, 18);
    dataUrl = c.toDataURL('image/png');
    trayUrl = buildTrayBadgeUrl(count);
  }
  window.native?.setBadge(count, dataUrl, trayUrl);
}

function updateBadges() {
  const n = unreadInbox().length;
  $('#inboxBadge').style.display = n ? '' : 'none';
  $('#inboxBadge').textContent = n;
  const seen = Number(localStorage.getItem(noticeSeenKey()) || 0);
  const nn = S.notices.filter(x => x.time > seen).length;
  $('#noticeBadge').style.display = nn ? '' : 'none';
  $('#noticeBadge').textContent = nn;
  const rn = S.rooms.reduce((sum, r) => sum + roomUnread(r.id), 0);
  $('#roomBadge').style.display = rn ? '' : 'none';
  $('#roomBadge').textContent = rn;
  updateAppBadge(n + rn);
}

// 부서 헤더에 드롭 처리 (관리자: 부서 순서 변경 / 사용자 부서 이동)
function handleDeptDrop(targetFull, e) {
  e.preventDefault();
  e.stopPropagation();
  const data = e.dataTransfer.getData('text/plain');
  if (!data || !S.me.admin) return;
  if (data.startsWith('D|')) {
    const dragged = data.slice(2).split('||').filter(Boolean);
    if (dragged.includes(targetFull)) return;
    // 과목으로 자동 생성되는 교과 조직은 순서 목록에서 제외 (항상 맨 뒤에 표시됨)
    const flat = S.deptFlat.filter(d => !dragged.includes(d) && !S.derivedDepts.has(d));
    let ti = flat.indexOf(targetFull);
    if (ti < 0) ti = flat.length;
    flat.splice(ti, 0, ...dragged.filter(d => !S.derivedDepts.has(d)));
    send({ type: 'set_dept_order', order: flat });
  } else if (data.startsWith('U|')) {
    const [, uid, fromDept] = data.split('|');
    if (fromDept === targetFull) return;
    if (S.derivedDepts.has(targetFull)) {
      return alert('교과 조직은 "내 정보"의 담당 과목으로 자동 구성됩니다.\n과목 정보를 수정해 주세요.');
    }
    const u = userById(uid);
    if (u && confirm(`'${u.name}' 님을 '${targetFull}' 부서로 이동할까요?`)) {
      const rest = (u.depts || [u.dept]).filter(d => d !== fromDept && !S.derivedDepts.has(d));
      send({ type: 'admin_update_user', id: uid, patch: { dept: [targetFull, ...rest].join(',') } });
    }
  }
}

function makeDraggable(el, payload, dropHandler) {
  if (!S.me.admin) return;
  el.draggable = true;
  el.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('text/plain', payload);
    ev.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer.types.includes('text/plain')) {
      ev.preventDefault();
      el.classList.add('drop-target');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (ev) => { el.classList.remove('drop-target'); dropHandler(ev); });
}

function buildDeptHeader(fullNames, label, users, level, collapseKey, q) {
  const online = users.filter(u => u.online).length;
  const others = users.filter(u => u.id !== S.me.id).map(u => u.id);
  const dv = document.createElement('div');
  dv.className = 'dept' + (level ? ' child' : '') + (S.closedDepts.has(collapseKey) && !q ? ' closed' : '');
  dv.innerHTML = `<span class="dept-name">${esc(label)} (${online}/${users.length})</span>`;
  dv.onclick = () => {
    S.closedDepts.has(collapseKey) ? S.closedDepts.delete(collapseKey) : S.closedDepts.add(collapseKey);
    renderTree();
  };
  if (others.length) {
    const dchk = document.createElement('input');
    dchk.type = 'checkbox';
    dchk.className = 'dept-chk';
    dchk.title = `'${label}' 전체 선택`;
    dchk.checked = others.every(id => S.treeSel.has(id));
    dchk.onclick = (e) => {
      e.stopPropagation();
      for (const id of others) dchk.checked ? S.treeSel.add(id) : S.treeSel.delete(id);
      renderTree();
    };
    dv.prepend(dchk);
    const mb = document.createElement('button');
    mb.className = 'dept-msg';
    mb.textContent = '✉';
    mb.title = `'${label}' 전체에게 쪽지 보내기 (${others.length}명)`;
    mb.onclick = (e) => { e.stopPropagation(); openCompose(others); };
    dv.appendChild(mb);
  }
  // 관리자: 드래그로 순서 변경, 우클릭으로 이름 변경
  makeDraggable(dv, 'D|' + fullNames.join('||'), (ev) => handleDeptDrop(fullNames[0], ev));
  if (S.me.admin) {
    if (fullNames.every(f => S.derivedDepts.has(f))) {
      dv.title = '교과 조직: 담당 과목 정보로 자동 구성됩니다';
    } else {
      dv.title = '드래그: 순서 변경 / 우클릭: 부서 관리(이름 변경·추가)';
      dv.oncontextmenu = (e) => { e.preventDefault(); openDeptRenameModal(fullNames.filter(f => !S.derivedDepts.has(f))); };
    }
  }
  return dv;
}

function buildUserRow(u, dept, level) {
  const row = document.createElement('div');
  row.className = 'user-row' + (u.id === S.me.id ? ' me-row' : '') + (level > 1 ? ' lv2' : '');
  const dotCls = !u.online ? 'off' : (u.status && u.status !== 'online' ? u.status : 'on');
  const stLabel = u.online && STATUS_LABEL[u.status] ? `<span class="ustatus">${STATUS_LABEL[u.status]}</span>` : '';
  const chkHtml = u.id === S.me.id ? '' :
    `<input type="checkbox" class="t-chk" ${S.treeSel.has(u.id) ? 'checked' : ''}>`;
  row.innerHTML = `${chkHtml}<span class="avatar-wrap">${avatarHtml(u.id, u.name, 26)}<span class="presence-dot dot ${dotCls}"></span></span>
    <span class="uname">${esc(u.name)}${u.id === S.me.id ? ' (나)' : ''}</span>
    <span class="upos">${esc(u.position || '')}</span>${stLabel}`;
  const tchk = row.querySelector('.t-chk');
  if (tchk) {
    tchk.onclick = (e) => {
      e.stopPropagation();
      tchk.checked ? S.treeSel.add(u.id) : S.treeSel.delete(u.id);
      renderTree();
    };
  }
  row.title = profileTooltip(u);
  row.oncontextmenu = (e) => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, u); };
  if (u.id !== S.me.id) {
    row.ondblclick = () => openChat(u.id);
    row.onclick = () => {
      if ($('#composeModal').style.display !== 'none') {
        S.recipients.add(u.id);
        renderRecipients();
      } else {
        S.treeSel.has(u.id) ? S.treeSel.delete(u.id) : S.treeSel.add(u.id);
        renderTree();
      }
    };
  }
  // 관리자: 드래그로 부서 내 순서 변경 / 다른 부서로 이동
  makeDraggable(row, 'U|' + u.id + '|' + dept, (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const data = ev.dataTransfer.getData('text/plain');
    if (!data) return;
    // 부서를 사용자 행에 놓으면 그 사용자가 속한 부서 위치로 이동 (헤더가 얇아 조준이 어려움)
    if (data.startsWith('D|')) return handleDeptDrop(dept, ev);
    if (!data.startsWith('U|')) return;
    const [, dragId, fromDept] = data.split('|');
    if (dragId === u.id) return;
    if (fromDept === dept) {
      // 같은 부서: 대상 위치 앞으로 순서 이동
      const ids = (S.deptDisplayed[dept] || []).filter(id => id !== dragId);
      let ti = ids.indexOf(u.id);
      if (ti < 0) ti = ids.length;
      ids.splice(ti, 0, dragId);
      send({ type: 'set_user_order', dept, order: ids });
    } else {
      const du = userById(dragId);
      if (du && confirm(`'${du.name}' 님을 '${dept}' 부서로 이동할까요?`)) {
        send({ type: 'admin_update_user', id: dragId, patch: { dept } });
      }
    }
  });
  return row;
}

function renderTree() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const tree = $('#orgTree');
  tree.innerHTML = '';
  const depts = new Map();
  S.derivedDepts = new Set(); // 과목으로 자동 생성된 '교과-*' 조직
  const addTo = (dept, u) => {
    if (!depts.has(dept)) depts.set(dept, []);
    if (!depts.get(dept).some(x => x.id === u.id)) depts.get(dept).push(u);
  };
  for (const u of S.users) {
    if (u.system && S.me.id !== u.id) continue; // 시스템 기본 계정(admin)만 숨김 — 관리자 권한 사용자는 항상 표시
    const uDepts = u.depts || [u.dept];
    if (q && !(u.name.toLowerCase().includes(q) || uDepts.join(' ').toLowerCase().includes(q) ||
               (u.subject || '').toLowerCase().includes(q) ||
               (u.position || '').toLowerCase().includes(q))) continue;
    for (const d of uDepts) addTo(d, u); // 여러 부서 소속 지원
    // 과목 입력 시 '교과-과목' 조직 자동 소속
    if (u.subject) {
      const derived = '교과-' + u.subject;
      if (!uDepts.includes(derived)) {
        addTo(derived, u);
        S.derivedDepts.add(derived);
      }
    }
  }
  // 빈 부서(관리자가 추가)도 표시 — 드래그로 인원 배치 가능
  if (!q) {
    for (const d of (S.extraDepts || [])) if (!depts.has(d)) depts.set(d, []);
  }
  S.treeVisible = [];
  S.deptDisplayed = {};
  // 정렬: 부서 순서 → 부서 내 사용자 지정 순서 → 이름순 ('교과' 조직은 항상 마지막)
  const flatEntries = [...depts.entries()].sort((a, b) => {
    const ga = a[0] === '교과' || a[0].startsWith('교과-') ? 1 : 0;
    const gb = b[0] === '교과' || b[0].startsWith('교과-') ? 1 : 0;
    return ga - gb || deptSorter(a[0], b[0]);
  });
  S.deptFlat = flatEntries.map(e => e[0]);
  for (const [dept, users] of flatEntries) {
    const uo = (S.userOrder || {})[dept] || [];
    users.sort((a, b) => {
      const ia = uo.indexOf(a.id), ib = uo.indexOf(b.id);
      const ra = ia < 0 ? 9999 : ia, rb = ib < 0 ? 9999 : ib;
      return ra - rb || a.name.localeCompare(b.name, 'ko');
    });
    S.deptDisplayed[dept] = users.map(u => u.id);
    for (const u of users) {
      if (u.id !== S.me.id && !S.treeVisible.includes(u.id)) S.treeVisible.push(u.id);
    }
  }
  // 계층 구조: '교과-국어' → 상위 '교과' 아래 하위 '국어'
  const roots = [];
  const rootIdx = new Map();
  for (const [full, users] of flatEntries) {
    const di = full.indexOf('-');
    const rootName = di > 0 ? full.slice(0, di).trim() : full;
    const childLabel = di > 0 ? (full.slice(di + 1).trim() || full) : null;
    let root = rootIdx.get(rootName);
    if (!root) { root = { name: rootName, items: [] }; rootIdx.set(rootName, root); roots.push(root); }
    root.items.push({ full, label: childLabel, users });
  }
  for (const root of roots) {
    const isGroup = root.items.some(i => i.label !== null);
    if (!isGroup) {
      // 일반(단일) 부서
      const it = root.items[0];
      tree.appendChild(buildDeptHeader([it.full], it.full, it.users, 0, it.full, q));
      if (!(S.closedDepts.has(it.full) && !q)) {
        for (const u of it.users) tree.appendChild(buildUserRow(u, it.full, 1));
      }
      continue;
    }
    // 상위 부서 + 하위 부서들
    const allUsers = root.items.flatMap(i => i.users);
    const allFulls = root.items.map(i => i.full);
    const pKey = 'P:' + root.name;
    tree.appendChild(buildDeptHeader(allFulls, root.name, allUsers, 0, pKey, q));
    if (S.closedDepts.has(pKey) && !q) continue;
    for (const it of root.items) {
      if (it.label === null) {
        // 상위 부서 직속 인원
        for (const u of it.users) tree.appendChild(buildUserRow(u, it.full, 1));
        continue;
      }
      tree.appendChild(buildDeptHeader([it.full], it.label, it.users, 1, it.full, q));
      if (!(S.closedDepts.has(it.full) && !q)) {
        for (const u of it.users) tree.appendChild(buildUserRow(u, it.full, 2));
      }
    }
  }
  if (!tree.children.length) tree.innerHTML = '<div class="empty">검색 결과가 없습니다</div>';
  syncTreeSelBar();
}

// ---------- 부서 이름 변경 (관리자) ----------
function openDeptRenameModal(preFulls) {
  if (!S.me.admin) return;
  const box = $('#drList');
  box.innerHTML = '';
  for (const d of S.deptFlat.filter(x => !S.derivedDepts.has(x))) {
    const row = document.createElement('label');
    row.className = 'pk-user';
    const empty = !(S.deptDisplayed[d] || []).length;
    row.innerHTML = `<input type="checkbox" value="${esc(d)}" ${preFulls.includes(d) ? 'checked' : ''}>
      <span style="flex:1">${esc(d)}${empty ? ' <span style="color:#99a;font-size:11px">(비어 있음)</span>' : ''}</span>
      ${empty ? '<span class="att-del" title="빈 부서 삭제">✕</span>' : ''}`;
    const del = row.querySelector('.att-del');
    if (del) del.onclick = (e) => {
      e.preventDefault();
      if (confirm(`빈 부서 '${d}'을(를) 삭제할까요?`)) {
        send({ type: 'delete_dept', name: d });
        $('#deptRenameModal').style.display = 'none';
      }
    };
    box.appendChild(row);
  }
  $('#drAddName').value = '';
  $('#drNewName').value = preFulls.length === 1 ? preFulls[0] : '';
  $('#drError').textContent = '';
  $('#deptRenameModal').style.display = 'flex';
  $('#drNewName').focus();
}

$('#drAddBtn').addEventListener('click', () => {
  const name = $('#drAddName').value.trim();
  if (!name) return $('#drError').textContent = '추가할 부서 이름을 입력하세요.';
  send({ type: 'add_dept', name });
  $('#deptRenameModal').style.display = 'none';
});

$('#drCancel').addEventListener('click', () => { $('#deptRenameModal').style.display = 'none'; });
$('#drSave').addEventListener('click', () => {
  const from = [...$('#drList').querySelectorAll('input:checked')].map(c => c.value);
  const to = $('#drNewName').value.trim();
  if (!from.length) return $('#drError').textContent = '변경할 부서를 선택하세요.';
  if (!to) return $('#drError').textContent = '새 부서 이름을 입력하세요.';
  if (from.length > 1 && !confirm(`선택한 ${from.length}개 부서가 모두 '${to}'(으)로 합쳐집니다. 계속할까요?`)) return;
  send({ type: 'rename_dept', from, to });
  $('#deptRenameModal').style.display = 'none';
});

// ---------- 조직도 다중 선택 ----------
function syncTreeSelBar() {
  const n = S.treeSel.size;
  $('#treeSelCount').textContent = n ? n + '명 선택' : '';
  for (const s of ['#treeSelMsg', '#treeSelGroup', '#treeSelClear'])
    $(s).style.display = n ? '' : 'none';
  $('#treeSelAll').checked = S.treeVisible.length > 0 && S.treeVisible.every(id => S.treeSel.has(id));
}

$('#treeSelAll').addEventListener('change', (e) => {
  if (e.target.checked) for (const id of S.treeVisible) S.treeSel.add(id);
  else S.treeSel.clear();
  renderTree();
});
$('#treeSelClear').addEventListener('click', () => { S.treeSel.clear(); renderTree(); });
$('#treeSelMsg').addEventListener('click', () => {
  if (S.treeSel.size) openCompose([...S.treeSel]);
});
$('#treeSelGroup').addEventListener('click', () => {
  if (S.treeSel.size) openGroupModal(null, [...S.treeSel]);
});

// 답장: 본문 아래에 원본 쪽지를 인용해서 넣음
function replyToMessage(m) {
  const head = `보낸 사람: ${nameOf(m.from)} · ${fmtFull(m.time)}`;
  const bodyHtml = m.html
    ? sanitizeHtmlKeepRelative(m.html)
    : esc(m.text || '(내용 없음)').replace(/\n/g, '<br>');
  const quoted =
    '<br><br><div class="quoted-msg">' +
    `<div class="quoted-head">─── 원본 쪽지 ───<br>${esc(head)}</div>` +
    bodyHtml +
    '</div>';
  // 커서가 맨 위(답장 작성 위치)에 오도록 빈 줄을 앞에 둠
  openCompose([m.from], '', [], '<div><br></div>' + quoted);
  focusEditorStart();
}

// 쪽지 본문 맨 앞(인용문 위 빈 줄)에 커서 놓기 — 모달 표시/선택기 렌더 뒤 포커스가 옮겨져도 다시 본문으로
function focusEditorStart() {
  const place = () => {
    const ed = $('#composeText');
    if (!ed || $('#composeModal').style.display === 'none') return;
    ed.focus();
    try {
      const range = document.createRange();
      const first = ed.firstChild;
      if (first && first.nodeType === Node.ELEMENT_NODE) range.setStart(first, 0);
      else range.setStart(ed, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
    ed.scrollTop = 0;
  };
  place();
  setTimeout(place, 80);
  setTimeout(place, 300);
}

// 쪽지 전달 (서식/첨부 유지)
function forwardMessage(m) {
  const header = `─── 전달된 쪽지 ───\n보낸 사람: ${nameOf(m.from)}\n시각: ${fmtFull(m.time)}\n──────────────\n`;
  if (m.html) {
    openCompose([], '', m.attachments,
      esc(header).replace(/\n/g, '<br>') + sanitizeHtmlKeepRelative(m.html));
  } else {
    openCompose([], header + (m.text || ''), m.attachments);
  }
}

function msgItem(m, mode) {
  const el = document.createElement('div');
  const unread = mode === 'inbox' && !m.readBy.includes(S.me.id) && m.from !== S.me.id;
  el.className = 'msg-item' + (unread ? ' unread' : '');
  const who = mode === 'inbox'
    ? nameOf(m.from)
    : m.to.map(nameOf).slice(0, 2).join(', ') + (m.to.length > 2 ? ` 외 ${m.to.length - 2}명` : '');
  const avId = mode === 'inbox' ? m.from : m.to[0];
  const clip = m.attachments.length ? '<span class="clip">📎</span> ' : '';
  const readInfo = mode === 'sent'
    ? `<span class="readmark">읽음 ${m.readBy.length}/${m.to.length}</span>` : '';
  el.innerHTML = `<span class="type-chip tc-msg">쪽지</span>${avatarHtml(avId, nameOf(avId), 34)}<span class="who">${esc(who)}</span>
    <span class="preview">${clip}${esc(m.text.slice(0, 100)) || '(첨부파일)'}</span>
    ${readInfo}<span class="when">${fmtTime(m.time)}</span>`;
  el.onclick = () => openDetail(m, mode);
  // 목록에서 내용을 열지 않고 바로 동작 (받은쪽지: 답장/전달/삭제, 보낸쪽지: 전달/삭제)
  const btns = document.createElement('span');
  btns.className = 'msg-actions';
  const peerId = mode === 'inbox' ? m.from : m.to.find(id => id !== S.me.id);
  btns.innerHTML = `
    ${mode === 'inbox' ? '<button data-a="reply" title="답장">↩ 답장</button>' : ''}
    ${peerId ? `<button data-a="chat" title="${esc(nameOf(peerId))} 님과 대화">💬</button>` : ''}
    <button data-a="fwd" title="전달">➦ 전달</button>
    <button data-a="del" class="danger-text" title="삭제">✕</button>`;
  btns.onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'reply') replyToMessage(m);
    if (b.dataset.a === 'chat') openChat(peerId);
    if (b.dataset.a === 'fwd') forwardMessage(m);
    if (b.dataset.a === 'del' && confirm('이 쪽지를 내 보관함에서 삭제할까요?\n(상대방 화면에는 그대로 남습니다)')) {
      send({ type: 'delete_message', messageId: m.id });
    }
  };
  el.appendChild(btns);
  return el;
}

function msgMatches(m, q) {
  if (!q) return true;
  return m.text.toLowerCase().includes(q) ||
    nameOf(m.from).toLowerCase().includes(q) ||
    m.to.some(id => nameOf(id).toLowerCase().includes(q)) ||
    m.attachments.some(a => a.name.toLowerCase().includes(q));
}

function renderInbox() {
  const list = $('#inboxList');
  const q = $('#inboxSearch').value.trim().toLowerCase();
  list.innerHTML = '';
  const items = S.messages
    .filter(m => m.to.includes(S.me.id) && m.from !== S.me.id && msgMatches(m, q)).reverse();
  if (!items.length) {
    list.innerHTML = `<div class="empty">${q ? '검색 결과가 없습니다' : '받은 쪽지가 없습니다'}</div>`;
    return;
  }
  for (const m of items) list.appendChild(msgItem(m, 'inbox'));
}

function renderSent() {
  const list = $('#sentList');
  const q = $('#sentSearch').value.trim().toLowerCase();
  list.innerHTML = '';
  // 예약 대기 중인 쪽지 (맨 위)
  for (const s of [...S.scheduled].sort((a, b) => a.sendAt - b.sendAt)) {
    if (q && !msgMatches({ ...s, readBy: [] }, q)) continue;
    const el = document.createElement('div');
    el.className = 'msg-item sched-item';
    const who = s.to.map(nameOf).slice(0, 2).join(', ') + (s.to.length > 2 ? ` 외 ${s.to.length - 2}명` : '');
    el.innerHTML = `<span class="who">⏰ ${esc(who)}</span>
      <span class="preview">${s.attachments.length ? '<span class="clip">📎</span> ' : ''}${esc(s.text.slice(0, 100)) || '(첨부파일)'}</span>
      <span class="readmark">예약: ${fmtFull(s.sendAt)}</span>
      <button class="mini-cancel" data-id="${esc(s.id)}">취소</button>`;
    el.querySelector('.mini-cancel').onclick = (e) => {
      e.stopPropagation();
      if (confirm('이 예약 쪽지를 취소할까요?')) send({ type: 'cancel_scheduled', id: s.id });
    };
    list.appendChild(el);
  }
  const items = S.messages.filter(m => m.from === S.me.id && msgMatches(m, q)).reverse();
  if (!items.length && !list.children.length) {
    list.innerHTML = `<div class="empty">${q ? '검색 결과가 없습니다' : '보낸 쪽지가 없습니다'}</div>`;
    return;
  }
  for (const m of items) list.appendChild(msgItem(m, 'sent'));
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|m4v|mov)$/i;   // 브라우저 재생 가능한 영상
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac)$/i;

// 미리보기용 URL (서버가 올바른 Content-Type + inline으로 응답 → 화면에 바로 표시됨)
const inlineUrl = (u) => httpBase() + u + (u.includes('?') ? '&' : '?') + 'inline=1';

function attachmentLinks(m) {
  const atts = m.attachments || [];
  if (!atts.length) return '';
  // 파일 하나당 한 줄씩 표시 (개수 파악이 쉬움) + 이미지·영상·오디오는 바로 재생/표시
  const lines = atts.map((a, i) => {
    const url = esc(httpBase() + a.url);       // 다운로드용
    const view = esc(inlineUrl(a.url));        // 화면 표시용
    let media = '';
    if (IMG_EXT.test(a.name)) {
      media = `<img class="att-img" src="${view}" alt="${esc(a.name)}">`;
    } else if (VIDEO_EXT.test(a.name)) {
      media = `<video class="att-video" src="${view}" controls preload="metadata"></video>`;
    } else if (AUDIO_EXT.test(a.name)) {
      media = `<audio class="att-audio" src="${view}" controls preload="metadata"></audio>`;
    }
    const icon = IMG_EXT.test(a.name) ? '🖼' : VIDEO_EXT.test(a.name) ? '🎬' : AUDIO_EXT.test(a.name) ? '🎵' : '📎';
    return `<div class="att-line">
      <a href="${url}">${icon} ${i + 1}. ${esc(a.name)} (${fmtSize(a.size)})</a>${media}</div>`;
  }).join('');
  // 첨부가 2개 이상이면 한 번에 모두 내려받기
  const all = atts.length > 1
    ? `<div class="att-all"><button class="att-all-btn" data-urls="${esc(atts.map(a => a.url).join('|'))}">
         ⬇ 첨부 ${atts.length}개 모두 저장</button></div>`
    : '';
  return all + lines;
}

// "모두 저장" 버튼 (본문 어디에 있든 동작)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.att-all-btn');
  if (!btn) return;
  e.preventDefault();
  const urls = (btn.dataset.urls || '').split('|').filter(Boolean);
  // 순차 다운로드 (동시에 시작하면 일부가 누락될 수 있음)
  urls.forEach((u, i) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = httpBase() + u;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, i * 400));
});

function renderChatHead() {
  if (!S.chatPeer) { $('#chatHead').textContent = '왼쪽 목록에서 대화 상대를 두 번 클릭하세요'; return; }
  const u = userById(S.chatPeer);
  $('#chatHead').innerHTML = u
    ? `<span class="dot ${u.online ? 'on' : 'off'}" style="display:inline-block"></span> ${esc(u.name)} (${esc(u.dept)}${u.position ? ' · ' + esc(u.position) : ''})`
    : esc(S.chatPeer);
}

function renderChat() {
  renderChatHead();
  const log = $('#chatLog');
  $('#chatInputRow').style.display = S.chatPeer ? '' : 'none';
  renderPending('chat');
  log.innerHTML = '';
  if (!S.chatPeer) return;
  const items = S.messages.filter(m =>
    (m.from === S.me.id && m.to.includes(S.chatPeer)) ||
    (m.from === S.chatPeer && m.to.includes(S.me.id)));
  for (const m of items) {
    const mine = m.from === S.me.id;
    const row = document.createElement('div');
    row.className = 'bubble-row' + (mine ? ' mine' : '');
    const bodyHtml = m.html ? linkifyHtml(sanitizeHtml(m.html)) : `<span style="${msgStyleCss(m)}">${linkify(m.text)}</span>`;
    row.innerHTML = `<div class="bubble">${bodyHtml}${m.attachments.length ? attachmentLinks(m) : ''}
      <span class="btime">${fmtTime(m.time)}${mine ? (m.readBy.length ? ' · 읽음' : ' · 안읽음') : ''}</span></div>`;
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
  // 표시된 상대 쪽지 읽음 처리
  if (S.tab === 'chat') {
    for (const m of items) {
      if (m.from === S.chatPeer && !m.readBy.includes(S.me.id)) {
        send({ type: 'read', messageId: m.id });
        m.readBy.push(S.me.id);
      }
    }
    updateBadges(); renderInbox();
  }
}

// ---------- 채팅방 ----------
function renderRooms() {
  if (S.currentRoom && roomById(S.currentRoom)) {
    $('#roomListView').style.display = 'none';
    $('#roomChatView').style.display = 'flex';
    renderRoomChat();
  } else {
    S.currentRoom = null;
    $('#roomListView').style.display = '';
    $('#roomChatView').style.display = 'none';
    renderRoomList();
  }
}

function renderRoomList() {
  const list = $('#roomList');
  list.innerHTML = '';
  const rooms = [...S.rooms].sort((a, b) => {
    const la = (S.roomMsgs[a.id] || []).at(-1)?.time || a.time;
    const lb = (S.roomMsgs[b.id] || []).at(-1)?.time || b.time;
    return lb - la;
  });
  if (!rooms.length) {
    list.innerHTML = '<div class="empty">참여 중인 채팅방이 없습니다.<br>[+ 채팅방 만들기]로 시작해 보세요.</div>';
    return;
  }
  for (const r of rooms) {
    const last = (S.roomMsgs[r.id] || []).at(-1);
    const unread = roomUnread(r.id);
    const el = document.createElement('div');
    el.className = 'msg-item';
    el.innerHTML = `<span class="who">👥 ${esc(r.name)}</span>
      <span class="preview">${last ? (last.from ? esc(nameOf(last.from)) + ': ' : '') + esc(last.text.slice(0, 60)) : '대화 없음'}</span>
      ${unread ? `<span class="room-unread">${unread}</span>` : ''}
      <span class="when">${esc(r.members.length)}명 · ${last ? fmtTime(last.time) : fmtTime(r.time)}</span>`;
    el.onclick = () => openRoom(r.id);
    list.appendChild(el);
  }
}

function openRoom(roomId) {
  // 다른 방으로 옮기면 이전 방에 붙여 두었던 첨부는 비움 (엉뚱한 방으로 전송 방지)
  if (S.currentRoom !== roomId) S.roomFiles = [];
  S.currentRoom = roomId;
  markRoomSeen(roomId);
  renderRooms(); updateBadges();
  $('#roomText').focus();
}

function renderRoomChat() {
  const room = roomById(S.currentRoom);
  if (!room) return;
  $('#roomChatTitle').textContent = `${room.name} (${room.members.map(nameOf).join(', ')})`;
  const log = $('#roomLog');
  // 투표 등으로 다시 그릴 때 보던 위치를 유지 (맨 아래를 보고 있었으면 계속 맨 아래)
  const prevTop = log.scrollTop;
  const wasAtBottom = log.scrollHeight - prevTop - log.clientHeight < 40;
  log.innerHTML = '';
  for (const m of S.roomMsgs[room.id] || []) {
    const row = document.createElement('div');
    if (m.system) {
      row.className = 'bubble-row system';
      row.innerHTML = `<div class="bubble">${esc(m.text)}</div>`;
    } else if (m.poll) {
      // 채팅방 설문: 이 방 사람들만 참여하는 설문 카드
      row.className = 'bubble-row poll-row';
      const bubble = document.createElement('div');
      bubble.className = 'bubble poll-bubble';
      bubble.innerHTML = `<span class="bwho">${esc(nameOf(m.from))} 님의 설문</span>`;
      const box = document.createElement('div');
      bubble.appendChild(box);
      renderPoll(box, m.poll, (options) =>
        send({ type: 'vote_room_poll', roomId: m.roomId, msgId: m.id, options }));
      const t = document.createElement('span');
      t.className = 'btime';
      t.textContent = fmtTime(m.time);
      bubble.appendChild(t);
      row.appendChild(bubble);
    } else {
      const mine = m.from === S.me.id;
      row.className = 'bubble-row' + (mine ? ' mine' : '');
      row.innerHTML = `<div class="bubble">${mine ? '' : `<span class="bwho">${esc(nameOf(m.from))}</span>`}${linkify(m.text)}${m.attachments.length ? attachmentLinks(m) : ''}
        <span class="btime">${fmtTime(m.time)}</span></div>`;
    }
    log.appendChild(row);
  }
  log.scrollTop = wasAtBottom ? log.scrollHeight : prevTop;
  renderPending('room');
  markRoomSeen(room.id);
}

async function sendRoomMsg(extra) {
  const text = $('#roomText').value;
  const files = [...S.roomFiles, ...(extra || [])];
  if (!S.currentRoom || (!text.trim() && !files.length)) return;
  $('#roomSendBtn').disabled = true;
  try {
    const attachments = files.length ? await uploadFiles(files) : [];
    send({ type: 'room_message', roomId: S.currentRoom, text, attachments });
    $('#roomText').value = '';
    S.roomFiles = [];
    renderPending('room');
  } catch (e) { alert(e.message); }
  finally { $('#roomSendBtn').disabled = false; }
}

// ---------- 대화/채팅방 전송 대기 첨부 ----------
function pendingList(kind) { return kind === 'chat' ? S.chatFiles : S.roomFiles; }

function renderPending(kind) {
  const list = pendingList(kind);
  const box = kind === 'chat' ? $('#chatPending') : $('#roomPending');
  if (!box) return;
  box.innerHTML = '';
  box.style.display = list.length ? '' : 'none';
  if (!list.length) return;
  const head = document.createElement('span');
  head.className = 'pending-head';
  head.textContent = `첨부 ${list.length}개 — [전송]을 누르면 함께 보냅니다`;
  box.appendChild(head);
  list.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'pending-chip';
    chip.innerHTML = `${IMG_EXT.test(f.name) ? '🖼' : VIDEO_EXT.test(f.name) ? '🎬' : '📎'}
      <span class="att-name">${esc(f.name)}</span>
      <span class="att-size">${fmtSize(f.size)}</span><span class="att-del" title="첨부 제거">✕</span>`;
    chip.querySelector('.att-del').onclick = () => { list.splice(i, 1); renderPending(kind); };
    box.appendChild(chip);
  });
}

function addPendingFiles(kind, files) {
  const list = pendingList(kind);
  for (const f of files) {
    if (!list.some(x => x.name === f.name && x.size === f.size)) list.push(f);
  }
  renderPending(kind);
}

function openRoomModal(mode) {
  S.roomModalMode = mode;
  S.roomPick = new Set();
  $('#roomModalTitle').textContent = mode === 'create' ? '채팅방 만들기' : '채팅방에 초대';
  $('#roomModalOk').textContent = mode === 'create' ? '만들기' : '초대';
  $('#roomNameRow').style.display = mode === 'create' ? '' : 'none';
  $('#roomNameInput').value = '';
  $('#roomModalError').textContent = '';
  const exclude = mode === 'invite' && roomById(S.currentRoom) ? roomById(S.currentRoom).members : [];
  buildPicker($('#roomPicker'), $('#roomChips'), S.roomPick, exclude);
  $('#roomModal').style.display = 'flex';
  if (mode === 'create') $('#roomNameInput').focus();
}

$('#roomCreateBtn').addEventListener('click', () => openRoomModal('create'));
$('#roomInviteBtn').addEventListener('click', () => openRoomModal('invite'));
$('#roomModalCancel').addEventListener('click', () => { $('#roomModal').style.display = 'none'; });
$('#roomModalOk').addEventListener('click', () => {
  if (!S.roomPick.size) return $('#roomModalError').textContent = '대화 상대를 선택하세요.';
  if (S.roomModalMode === 'create') {
    const name = $('#roomNameInput').value.trim();
    if (!name) return $('#roomModalError').textContent = '채팅방 이름을 입력하세요.';
    send({ type: 'create_room', name, members: [...S.roomPick] });
  } else {
    send({ type: 'add_room_members', roomId: S.currentRoom, members: [...S.roomPick] });
  }
  $('#roomModal').style.display = 'none';
});
$('#roomBackBtn').addEventListener('click', () => { S.currentRoom = null; renderRooms(); });
$('#roomLeaveBtn').addEventListener('click', () => {
  const room = roomById(S.currentRoom);
  if (room && confirm(`'${room.name}' 채팅방에서 나갈까요?`)) {
    send({ type: 'leave_room', roomId: room.id });
  }
});
$('#roomSendBtn').addEventListener('click', () => sendRoomMsg([]));
$('#roomText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRoomMsg([]); }
});
$('#roomAttachBtn').addEventListener('click', () => $('#roomFileInput').click());
$('#roomFileInput').addEventListener('change', () => {
  addPendingFiles('room', [...$('#roomFileInput').files]);
  $('#roomFileInput').value = '';
  $('#roomText').focus();
});

// ---------- 채팅방 설문 (참여자만 대상) ----------
$('#roomPollBtn').addEventListener('click', () => {
  const room = roomById(S.currentRoom);
  if (!room) return;
  $('#rpTarget').textContent =
    `대상: ${room.name} — ${room.members.length}명 (${room.members.map(nameOf).join(', ')})`;
  $('#rpQuestion').value = '';
  $('#rpOptions').value = '';
  $('#rpDeadline').value = localDatetimeValue(86400000); // 기본 마감: 하루 뒤
  $('#rpMulti').checked = false;
  $('#rpAnon').checked = false;
  $('#rpError').textContent = '';
  $('#roomPollModal').style.display = 'flex';
  $('#rpQuestion').focus();
});
$('#rpCancel').addEventListener('click', () => { $('#roomPollModal').style.display = 'none'; });
$('#rpOk').addEventListener('click', () => {
  const room = roomById(S.currentRoom);
  if (!room) return $('#rpError').textContent = '채팅방을 먼저 여세요.';
  const q = $('#rpQuestion').value.trim();
  if (!q) return $('#rpError').textContent = '질문을 입력하세요.';
  const options = $('#rpOptions').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (options.length < 2) return $('#rpError').textContent = '설문 항목을 2개 이상 입력하세요.';
  const deadline = new Date($('#rpDeadline').value).getTime();
  if (!deadline || isNaN(deadline) || deadline < Date.now() + 60000) {
    return $('#rpError').textContent = '마감 시각은 최소 1분 이후여야 합니다.';
  }
  send({
    type: 'room_poll', roomId: room.id,
    poll: { q, options, deadline, multi: $('#rpMulti').checked, anon: $('#rpAnon').checked }
  });
  $('#roomPollModal').style.display = 'none';
});

function renderNotices() {
  const list = $('#noticeList');
  list.innerHTML = '';
  // 내가 등록한 예약 공지 (맨 위)
  for (const s of [...S.schedNotices].sort((a, b) => a.publishAt - b.publishAt)) {
    const el = document.createElement('div');
    el.className = 'msg-item sched-item';
    el.innerHTML = `<span class="who">⏰ 예약 공지</span>
      <span class="preview"><b>${esc(s.title)}</b>${s.poll ? ' 📊' : ''} — ${esc(s.body.slice(0, 60))}</span>
      <span class="readmark">게시: ${fmtFull(s.publishAt)}</span>
      <button class="mini-cancel">취소</button>`;
    el.querySelector('.mini-cancel').onclick = (e) => {
      e.stopPropagation();
      if (confirm('이 예약 공지를 취소할까요?')) send({ type: 'cancel_scheduled_notice', id: s.id });
    };
    list.appendChild(el);
  }
  const nq = ($('#noticeSearch').value || '').trim().toLowerCase();
  const items = [...S.notices].reverse().filter(n => !nq ||
    n.title.toLowerCase().includes(nq) ||
    (n.body || '').toLowerCase().includes(nq) ||
    (n.authorName || '').toLowerCase().includes(nq));
  if (!items.length && !list.children.length) {
    list.innerHTML = `<div class="empty">${nq ? '검색 결과가 없습니다' : '등록된 공지가 없습니다'}</div>`;
    return;
  }
  for (const n of items) {
    const el = document.createElement('div');
    el.className = 'msg-item';
    const pollBadge = n.poll
      ? (Date.now() > n.poll.deadline ? ' <span style="color:#c62828">📊마감</span>' : ' <span style="color:#1565c0">📊설문</span>')
      : '';
    const clipBadge = (n.attachments || []).length ? ' <span class="clip">📎</span>' : '';
    el.innerHTML = `<span class="type-chip tc-notice">공지</span><span class="who">📢 ${esc(n.authorName)}</span>
      <span class="preview"><b>${esc(n.title)}</b>${pollBadge}${clipBadge} — ${esc(n.body.slice(0, 80)) || '(내용 없음)'}</span>
      <span class="when">${fmtTime(n.time)}</span>`;
    el.onclick = () => openNoticeDetail(n);
    // 관리자거나 본인이 작성한 공지는 목록에서 바로 삭제
    if (S.me.admin || n.authorId === S.me.id) {
      const btns = document.createElement('span');
      btns.className = 'msg-actions';
      btns.innerHTML = `<button data-a="del" class="danger-text" title="삭제">✕</button>`;
      btns.onclick = (e) => {
        e.stopPropagation();
        if (e.target.closest('button') && confirm('이 공지를 삭제할까요?')) {
          send({ type: 'delete_notice', noticeId: n.id });
        }
      };
      el.appendChild(btns);
    }
    list.appendChild(el);
  }
}

// ---------- 사이드바 탭 (조직도 / 사용자 그룹) ----------
$$('.side-tab').forEach(t => t.addEventListener('click', () => {
  S.sideTab = t.dataset.side;
  $$('.side-tab').forEach(x => x.classList.toggle('active', x === t));
  $('#orgTree').style.display = S.sideTab === 'org' ? '' : 'none';
  $('#groupPane').style.display = S.sideTab === 'groups' ? '' : 'none';
  $('#searchInput').style.display = S.sideTab === 'org' ? '' : 'none';
  if (S.sideTab === 'groups') renderGroups();
}));

// ---------- 사용자 그룹 ----------
function renderGroups() {
  const box = $('#groupList');
  if (!box) return;
  box.innerHTML = '';
  if (!S.groups.length) {
    box.innerHTML = '<div class="empty">만든 그룹이 없습니다.<br>자주 쪽지를 보내는 사람들을<br>그룹으로 묶어 보세요.</div>';
    return;
  }
  S.closedGroups = S.closedGroups || new Set();
  for (const g of S.groups) {
    const closed = S.closedGroups.has(g.id);
    const el = document.createElement('div');
    el.className = 'group-item';
    el.innerHTML = `
      <div class="g-head" title="클릭하면 접기/펼치기">${closed ? '▸' : '▾'} 👥 ${esc(g.name)} <span style="color:#99a;font-weight:normal">(${g.members.length}명)</span></div>
      <div class="g-member-list"></div>
      <div class="g-btns">
        <button data-act="msg">✉ 전체 쪽지</button>
        <button data-act="msg-sel" disabled>✉ 선택 쪽지</button>
        <button data-act="room">💬 채팅방</button>
        <button data-act="edit">✎</button>
        <button data-act="del" class="danger-text">✕</button>
      </div>`;
    // 구성원 개별 표시: 체크박스로 선택, 두 번 클릭 = 대화, 우클릭 = 메뉴
    // 선택 상태는 S.groupChecked에 보존 (새 쪽지 도착 등 재렌더링에도 유지)
    S.groupChecked = S.groupChecked || {};
    const sel = S.groupChecked[g.id] = S.groupChecked[g.id] || new Set();
    for (const chosen of [...sel]) if (!g.members.includes(chosen)) sel.delete(chosen);
    const memberBox = el.querySelector('.g-member-list');
    const selBtn = el.querySelector('[data-act=msg-sel]');
    const syncSelBtn = () => {
      selBtn.disabled = !sel.size;
      selBtn.textContent = sel.size ? `✉ 선택 쪽지(${sel.size})` : '✉ 선택 쪽지';
    };
    for (const mid of g.members) {
      const u = userById(mid);
      if (!u) continue;
      const dotCls = !u.online ? 'off' : (u.status && u.status !== 'online' ? u.status : 'on');
      const row = document.createElement('div');
      row.className = 'user-row g-member';
      row.innerHTML = `<input type="checkbox" class="g-chk" data-id="${esc(u.id)}" ${sel.has(u.id) ? 'checked' : ''}>
        <span class="avatar-wrap">${avatarHtml(u.id, u.name, 22)}<span class="presence-dot dot ${dotCls}"></span></span>
        <span class="uname">${esc(u.name)}</span><span class="upos">${esc(u.position || '')}</span>`;
      const chk = row.querySelector('input');
      const toggle = (on) => { on ? sel.add(u.id) : sel.delete(u.id); chk.checked = on; syncSelBtn(); };
      chk.onclick = (e) => { e.stopPropagation(); toggle(chk.checked); };
      row.onclick = (e) => { if (e.target !== chk) toggle(!sel.has(u.id)); };
      row.ondblclick = () => openChat(u.id);
      row.oncontextmenu = (e) => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, u); };
      memberBox.appendChild(row);
    }
    syncSelBtn();
    // 그룹 접기/펼치기
    el.querySelector('.g-head').style.cursor = 'pointer';
    el.querySelector('.g-head').onclick = () => {
      closed ? S.closedGroups.delete(g.id) : S.closedGroups.add(g.id);
      renderGroups();
    };
    if (closed) {
      memberBox.style.display = 'none';
      el.querySelector('.g-btns').style.display = 'none';
    }
    el.querySelector('[data-act=msg]').onclick = () => openCompose(g.members);
    selBtn.onclick = () => { if (sel.size) openCompose([...sel]); };
    el.querySelector('[data-act=room]').onclick = () => {
      if (confirm(`'${g.name}' 구성원 ${g.members.length}명과 채팅방을 만들까요?`)) {
        send({ type: 'create_room', name: g.name, members: g.members });
        showTab('rooms');
      }
    };
    el.querySelector('[data-act=edit]').onclick = () => openGroupModal(g);
    el.querySelector('[data-act=del]').onclick = () => {
      if (confirm(`'${g.name}' 그룹을 삭제할까요?`)) send({ type: 'delete_group', id: g.id });
    };
    box.appendChild(el);
  }
}

function openGroupModal(g, presetIds) {
  S.editingGroupId = g ? g.id : null;
  S.groupPick = new Set(g ? g.members : (presetIds || []).filter(id => id !== S.me.id));
  $('#groupModalTitle').textContent = g ? '그룹 수정' : '그룹 만들기';
  $('#groupNameInput').value = g ? g.name : '';
  $('#groupModalError').textContent = '';
  buildPicker($('#groupPicker'), $('#groupChips'), S.groupPick);
  $('#groupModal').style.display = 'flex';
  $('#groupNameInput').focus();
}

$('#groupAddBtn').addEventListener('click', () => openGroupModal(null));
$('#groupModalCancel').addEventListener('click', () => { $('#groupModal').style.display = 'none'; });
$('#groupModalOk').addEventListener('click', () => {
  const name = $('#groupNameInput').value.trim();
  if (!name) return $('#groupModalError').textContent = '그룹 이름을 입력하세요.';
  if (!S.groupPick.size) return $('#groupModalError').textContent = '구성원을 1명 이상 선택하세요.';
  send({ type: 'save_group', id: S.editingGroupId || undefined, name, members: [...S.groupPick] });
  $('#groupModal').style.display = 'none';
});

// ---------- 조직/사용자 관리 (관리자 권한 사용자) ----------
function resetAdminForm() {
  S.adminEditId = null;
  for (const s of ['#aId', '#aName', '#aDept', '#aPos', '#aPw']) $(s).value = '';
  $('#aAdmin').checked = false;
  $('#aId').disabled = false;
  $('#aSaveBtn').textContent = '추가';
  $('#aNewBtn').style.display = 'none';
  $('#aPw').placeholder = '비밀번호';
}

function renderAdminTable() {
  if ($('#adminModal').style.display === 'none') return;
  // 이미 등록된 부서/학년 목록을 선택할 수 있게 제공
  $('#deptList').innerHTML =
    [...new Set(S.users.filter(u => !u.system).flatMap(u => u.depts || [u.dept]))]
      .sort((a, b) => a.localeCompare(b, 'ko'))
      .map(d => `<option value="${esc(d)}">`).join('');
  const aq = ($('#aSearch').value || '').trim().toLowerCase();
  const tb = $('#adminTable tbody');
  tb.innerHTML = '';
  for (const u of S.users) {
    const deptsStr = (u.depts || [u.dept]).join(', ');
    if (aq && !(u.id.toLowerCase().includes(aq) || u.name.toLowerCase().includes(aq) ||
                deptsStr.toLowerCase().includes(aq) || (u.position || '').toLowerCase().includes(aq))) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(u.id)}</td><td>${esc(u.name)}</td><td>${esc(deptsStr)}</td>
      <td>${esc(u.position || '')}</td><td>${u.system ? '시스템' : (u.admin ? '관리자' : '일반')}</td>
      <td>
        ${u.system ? '' : `<button data-act="edit" data-id="${esc(u.id)}">수정</button>
        <button data-act="del" data-id="${esc(u.id)}" class="danger-text">삭제</button>`}
      </td>`;
    tb.appendChild(tr);
  }
}

$('#orgManageBtn').addEventListener('click', () => {
  resetAdminForm();
  $('#adminError').textContent = '';
  $('#adminModal').style.display = 'flex';
  renderAdminTable();
});
$('#adminClose').addEventListener('click', () => { $('#adminModal').style.display = 'none'; });

$('#adminTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const u = userById(btn.dataset.id);
  if (!u) return;
  if (btn.dataset.act === 'edit') {
    S.adminEditId = u.id;
    $('#aId').value = u.id;
    $('#aId').disabled = true;
    $('#aName').value = u.name;
    $('#aDept').value = (u.depts || [u.dept]).join(', ');
    $('#aPos').value = u.position || '';
    $('#aPw').value = '';
    $('#aPw').placeholder = '새 비밀번호(변경 시만)';
    $('#aAdmin').checked = !!u.admin;
    $('#aSaveBtn').textContent = '저장';
    $('#aNewBtn').style.display = '';
  } else if (btn.dataset.act === 'del') {
    if (confirm(`'${u.name}(${u.id})' 계정을 삭제할까요?\n해당 사용자는 즉시 접속이 끊깁니다.`)) {
      send({ type: 'admin_delete_user', id: u.id });
    }
  }
});

$('#aSearch').addEventListener('input', renderAdminTable);
$('#aNewBtn').addEventListener('click', resetAdminForm);
$('#aSaveBtn').addEventListener('click', () => {
  if (S.adminEditId) {
    send({
      type: 'admin_update_user', id: S.adminEditId,
      patch: { name: $('#aName').value, dept: $('#aDept').value, position: $('#aPos').value, admin: $('#aAdmin').checked },
      newPw: $('#aPw').value || undefined
    });
  } else {
    send({
      type: 'admin_add_user',
      user: {
        id: $('#aId').value, name: $('#aName').value, dept: $('#aDept').value,
        position: $('#aPos').value, pw: $('#aPw').value || '1234', admin: $('#aAdmin').checked
      }
    });
  }
});

// ---------- 조직도 우클릭 메뉴 ----------
let ctxUserId = null;

function profileInfoLines(u) {
  const lines = [];
  if (u.office) lines.push('🏢 ' + u.office);
  if (u.subject) lines.push('📚 ' + u.subject);
  if (u.phone) lines.push('☎ ' + u.phone);
  if (u.mobile) lines.push('📱 ' + u.mobile);
  if (u.email) lines.push('✉ ' + u.email);
  return lines;
}

function profileTooltip(u) {
  const base = u.id === S.me.id
    ? '우클릭: 내 정보 수정'
    : '두 번 클릭: 대화 / 우클릭: 메뉴';
  const info = profileInfoLines(u);
  return info.length ? info.join('\n') + '\n' + base : base;
}

// 우클릭 대상: 선택된 사용자들 중 하나를 우클릭했으면 선택 전체에 적용
function ctxTargets() {
  if (S.treeSel.size && S.treeSel.has(ctxUserId)) return [...S.treeSel];
  return [ctxUserId];
}

function showCtxMenu(x, y, u) {
  ctxUserId = u.id;
  const isMe = u.id === S.me.id;
  const menu = $('#ctxMenu');
  const targets = S.treeSel.size && S.treeSel.has(u.id) ? S.treeSel.size : 1;
  $('#ctxName').textContent = targets > 1
    ? `${u.name} 외 ${targets - 1}명 선택됨`
    : `${u.name}${u.position ? ' · ' + u.position : ''}${isMe ? ' (나)' : ''}`;
  const info = targets > 1 ? [] : profileInfoLines(u);
  $('#ctxInfo').innerHTML = info.map(esc).join('<br>');
  $('#ctxInfo').style.display = info.length ? '' : 'none';
  $('#ctxMain').style.display = '';
  $('#ctxGroups').style.display = 'none';
  menu.querySelector('[data-act=msg]').style.display = isMe ? 'none' : '';
  menu.querySelector('[data-act=chat]').style.display = (isMe || targets > 1) ? 'none' : '';
  menu.querySelector('[data-act=group]').style.display = isMe ? 'none' : '';
  menu.querySelector('[data-act=profile]').style.display = isMe ? '' : 'none';
  menu.style.display = '';
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

function hideCtxMenu() { $('#ctxMenu').style.display = 'none'; }

// 그룹에 추가 하위 메뉴
function showCtxGroupMenu() {
  const box = $('#ctxGroups');
  box.innerHTML = '';
  const back = document.createElement('div');
  back.className = 'ctx-item';
  back.textContent = '◀ 뒤로';
  back.onclick = (e) => {
    e.stopPropagation();
    $('#ctxMain').style.display = '';
    box.style.display = 'none';
  };
  box.appendChild(back);
  for (const g of S.groups) {
    const it = document.createElement('div');
    it.className = 'ctx-item';
    it.textContent = `👥 ${g.name} (${g.members.length}명)`;
    it.onclick = () => {
      const merged = [...new Set([...g.members, ...ctxTargets()])].filter(id => id !== S.me.id);
      send({ type: 'save_group', id: g.id, name: g.name, members: merged });
      hideCtxMenu();
      alert(`'${g.name}' 그룹에 추가했습니다.`);
    };
    box.appendChild(it);
  }
  const nw = document.createElement('div');
  nw.className = 'ctx-item';
  nw.textContent = '➕ 새 그룹 만들기';
  nw.onclick = () => {
    const targets = ctxTargets();
    hideCtxMenu();
    openGroupModal(null, targets);
  };
  box.appendChild(nw);
  $('#ctxMain').style.display = 'none';
  box.style.display = '';
}

$('#ctxMenu').addEventListener('click', (e) => {
  const item = e.target.closest('#ctxMain .ctx-item');
  if (!item || !ctxUserId) return;
  if (item.dataset.act === 'group') {
    e.stopPropagation();
    showCtxGroupMenu();
    return; // 메뉴 유지
  }
  if (item.dataset.act === 'msg') openCompose(ctxTargets());
  if (item.dataset.act === 'chat') openChat(ctxUserId);
  if (item.dataset.act === 'profile') openProfileModal();
  hideCtxMenu();
});
document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', (e) => {
  // 조직도 사용자 행이 아닌 곳에서 우클릭하면 메뉴 닫기
  if (!e.target.closest('.user-row')) hideCtxMenu();
});
window.addEventListener('blur', hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

// ---------- 탭 ----------
function showTab(tab) {
  S.tab = tab;
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  for (const name of TABS)
    $('#tab-' + name).style.display = name === tab ? '' : 'none';
  if (tab === 'notice') {
    localStorage.setItem(noticeSeenKey(), String(Date.now()));
    updateBadges();
  }
  if (tab === 'chat') renderChat();
  if (tab === 'rooms') renderRooms();
}

$$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

function openChat(peerId) {
  // 대화 상대가 바뀌면 붙여 두었던 첨부는 비움 (엉뚱한 사람에게 전송 방지)
  if (S.chatPeer !== peerId) { S.chatFiles = []; renderPending('chat'); }
  S.chatPeer = peerId;
  showTab('chat');
  $('#chatText').focus();
}

// ---------- 쪽지 상세 ----------
function openDetail(m, mode) {
  S.openNoticeId = null;
  if (mode === 'inbox' && !m.readBy.includes(S.me.id)) {
    send({ type: 'read', messageId: m.id });
    m.readBy.push(S.me.id);
    renderInbox(); updateBadges();
  }
  $('#detailTitle').textContent = mode === 'inbox' ? '받은 쪽지' : '보낸 쪽지';
  const toNames = m.to.map(nameOf).join(', ');
  let meta = `보낸 사람: ${esc(nameOf(m.from))}<br>받는 사람: ${esc(toNames)}<br>시각: ${fmtFull(m.time)}`;
  if (mode === 'sent') {
    const readers = m.readBy.map(nameOf).join(', ') || '없음';
    meta += `<br>읽은 사람 (${m.readBy.length}/${m.to.length}): ${esc(readers)}`;
  }
  $('#detailMeta').innerHTML = meta;
  $('#detailBody').innerHTML = m.html
    ? linkifyHtml(sanitizeHtml(m.html))
    : (m.text ? `<span style="${msgStyleCss(m)}">${linkify(m.text)}</span>` : '(내용 없음)');
  $('#detailFiles').innerHTML = attachmentLinks(m);
  $('#detailPoll').innerHTML = ''; // 앞서 본 공지의 설문이 남지 않도록
  // 인쇄
  $('#detailPrint').style.display = '';
  $('#detailPrint').onclick = () => printMessage({
    title: mode === 'inbox' ? '받은 쪽지' : '보낸 쪽지',
    metaHtml: meta,
    bodyHtml: $('#detailBody').innerHTML,
    files: m.attachments.map(a => `${a.name} (${fmtSize(a.size)})`)
  });
  $('#detailReply').style.display = mode === 'inbox' ? '' : 'none';
  $('#detailReply').onclick = () => {
    $('#detailModal').style.display = 'none';
    replyToMessage(m);
  };
  // 1:1 대화창으로 이동 (받은쪽지는 보낸이, 보낸쪽지는 첫 수신자)
  const peer = mode === 'inbox' ? m.from : m.to.find(id => id !== S.me.id);
  $('#detailChat').style.display = peer ? '' : 'none';
  if (peer) {
    $('#detailChat').textContent = `💬 ${nameOf(peer)} 님과 대화`;
    $('#detailChat').onclick = () => {
      $('#detailModal').style.display = 'none';
      openChat(peer);
    };
  }
  // 전달
  $('#detailForward').style.display = '';
  $('#detailForward').textContent = '전달';
  $('#detailForward').onclick = () => {
    $('#detailModal').style.display = 'none';
    forwardMessage(m);
  };
  // 회수 (보낸 쪽지 중 아무도 읽지 않은 것만)
  const canRecall = mode === 'sent' && m.readBy.length === 0;
  $('#detailRecall').style.display = canRecall ? '' : 'none';
  $('#detailRecall').onclick = () => {
    if (confirm('이 쪽지를 회수할까요? 받는 사람에게서 삭제됩니다.')) {
      send({ type: 'recall_message', messageId: m.id });
      $('#detailModal').style.display = 'none';
    }
  };
  // 삭제 (내 보관함에서만 삭제, 상대방에게는 유지)
  $('#detailDelete').style.display = '';
  $('#detailDelete').onclick = () => {
    if (confirm('이 쪽지를 내 보관함에서 삭제할까요?\n(상대방 화면에는 그대로 남습니다)')) {
      send({ type: 'delete_message', messageId: m.id });
      $('#detailModal').style.display = 'none';
    }
  };
  $('#detailModal').style.display = 'flex';
}

// ---------- 설문조사 (공지 / 채팅방 공용) ----------
// p는 서버가 보내 주는 보기용 설문 객체:
//   { q, options[], deadline, multi, anon, counts[], total, mine[], voters[][] (공개 설문일 때만) }
let pollSeq = 0;

function pollHtml(p, name) {
  const closed = Date.now() > p.deadline;
  const mine = p.mine || [];
  const type = p.multi ? 'checkbox' : 'radio';
  let html = `<div class="poll-box"><div class="poll-title"><b>📊 ${p.q ? esc(p.q) : '설문조사'}</b>
    <span class="poll-tag">${p.multi ? '여러 개 선택' : '하나만 선택'}</span>
    <span class="poll-tag">${p.anon ? '익명 투표' : '투표자 공개'}</span></div>`;
  p.options.forEach((opt, i) => {
    const cnt = (p.counts || [])[i] || 0;
    const pct = p.total ? Math.round(cnt / p.total * 100) : 0;
    const voted = mine.includes(i);
    html += `<div class="poll-opt">
      <label class="poll-pick"><input type="${type}" name="${name}" value="${i}" ${voted ? 'checked' : ''} ${closed ? 'disabled' : ''}>
      <span>${esc(opt)}${voted ? ' ✔' : ''}</span></label>
      <span class="poll-bar-wrap"><span class="poll-bar" style="width:${pct}%"></span></span>
      <span class="poll-cnt">${cnt}표 (${pct}%)</span>
    </div>`;
    if (p.voters) {
      const names = (p.voters[i] || []).map(uid => nameOf(uid));
      html += `<div class="poll-voters">${names.length ? '└ ' + esc(names.join(', ')) : '└ 아직 없음'}</div>`;
    }
  });
  html += `<div class="poll-meta">참여 ${p.total || 0}명 · 마감: ${fmtFull(p.deadline)} `;
  html += closed ? '<span class="poll-closed">(마감됨)</span>' : '';
  html += '</div>';
  if (!closed) {
    html += `<div class="poll-btns"><button class="primary poll-vote-btn">${mine.length ? '투표 변경' : '투표하기'}</button>`;
    if (mine.length) html += '<button class="poll-cancel-btn">투표 취소</button>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// 설문을 container에 그리고 투표 버튼을 연결 (onVote: 선택한 항목 번호 배열)
function renderPoll(container, poll, onVote) {
  const name = 'pollVote' + (++pollSeq);
  container.innerHTML = pollHtml(poll, name);
  const btn = container.querySelector('.poll-vote-btn');
  if (btn) btn.onclick = () => {
    const sel = [...container.querySelectorAll(`input[name="${name}"]:checked`)].map(el => Number(el.value));
    if (!sel.length) return alert('항목을 선택하세요.');
    onVote(sel);
  };
  const cancel = container.querySelector('.poll-cancel-btn');
  if (cancel) cancel.onclick = () => { if (confirm('투표를 취소할까요?')) onVote([]); };
}

// 쪽지/공지 인쇄: 인쇄 영역에 내용을 채우고 시스템 인쇄 대화상자 호출
function printMessage({ title, metaHtml, bodyHtml, files }) {
  $('#printArea').innerHTML = `
    <h2>${esc(document.title)} — ${esc(title)}</h2>
    <div class="pr-meta">${metaHtml}</div>
    <hr>
    <div class="pr-body">${bodyHtml}</div>
    ${files && files.length ? `<hr><div class="pr-files">첨부파일: ${files.map(esc).join(', ')}</div>` : ''}`;
  window.print();
}

function openNoticeDetail(n) {
  S.openNoticeId = n.id;
  $('#detailTitle').textContent = '📢 ' + n.title;
  let meta = `작성자: ${esc(n.authorName)}<br>시각: ${fmtFull(n.time)}`;
  if (n.edited) meta += `<br><span style="color:#e67e22">✏ 수정됨: ${fmtFull(n.edited)}${n.editedBy ? ' (' + esc(n.editedBy) + ')' : ''}</span>`;
  $('#detailMeta').innerHTML = meta;
  $('#detailPrint').style.display = '';
  $('#detailPrint').onclick = () => printMessage({
    title: '공지사항 — ' + n.title,
    metaHtml: meta,
    bodyHtml: n.body ? linkify(n.body) : '(내용 없음)',
    files: (n.attachments || []).map(a => `${a.name} (${fmtSize(a.size)})`)
  });
  $('#detailBody').innerHTML = n.body ? linkify(n.body) : '(내용 없음)';
  // 첨부파일 + 설문
  $('#detailFiles').innerHTML =
    (n.attachments || []).length ? attachmentLinks({ attachments: n.attachments }) : '';
  const pollBox = $('#detailPoll');
  pollBox.innerHTML = '';
  if (n.poll) {
    renderPoll(pollBox, n.poll, (options) => send({ type: 'vote_poll', noticeId: n.id, options }));
  }
  $('#detailRecall').style.display = 'none';
  $('#detailDelete').style.display = 'none';
  $('#detailChat').style.display = 'none';
  // 작성자 본인 또는 관리자는 수정·삭제 가능
  const canEdit = S.me.admin || n.authorId === S.me.id;
  $('#detailForward').style.display = canEdit ? '' : 'none';
  $('#detailForward').textContent = '✏ 수정';
  $('#detailForward').onclick = () => {
    $('#detailModal').style.display = 'none';
    openNoticeModal(false, n);
  };
  $('#detailReply').style.display = canEdit ? '' : 'none';
  $('#detailReply').textContent = canEdit ? '공지 삭제' : '답장';
  $('#detailReply').onclick = () => {
    if (confirm('이 공지를 삭제할까요?')) {
      send({ type: 'delete_notice', noticeId: n.id });
      $('#detailModal').style.display = 'none';
    }
  };
  $('#detailModal').style.display = 'flex';
}

$('#detailClose').addEventListener('click', () => {
  $('#detailModal').style.display = 'none';
  $('#detailReply').textContent = '답장';
  S.openNoticeId = null;
});

// ---------- 쪽지 작성 ----------
// ---- 쪽지 리치 편집기 (글꼴/크기/굵게/밑줄/색/정렬/이미지) ----
const RT_ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'FONT',
  'SPAN', 'DIV', 'P', 'BR', 'UL', 'OL', 'LI', 'IMG', 'BLOCKQUOTE']);
const RT_ALLOWED_STYLES = new Set(['color', 'font-size', 'font-family', 'text-align',
  'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'background-color']);

function filterStyle(s) {
  const ok = [];
  for (const part of String(s || '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (RT_ALLOWED_STYLES.has(k) && !/url|expression|javascript|@import/i.test(v)) ok.push(k + ':' + v);
  }
  return ok.join(';');
}

// 수신한 서식 HTML을 안전한 태그/속성만 남기고 정화 (XSS 방지)
function sanitizeHtml(html, keepRelative) {
  const doc = new DOMParser().parseFromString('<div id="__rt">' + String(html || '') + '</div>', 'text/html');
  const root = doc.getElementById('__rt');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }
      const tag = child.tagName;
      if (!RT_ALLOWED_TAGS.has(tag)) {
        // 허용하지 않는 태그는 내용만 남기고 벗겨냄
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const n = attr.name.toLowerCase();
        if (tag === 'FONT' && ['color', 'size', 'face'].includes(n)) continue;
        if (tag === 'IMG' && n === 'src') continue;
        if (n === 'style') { child.setAttribute('style', filterStyle(attr.value)); continue; }
        if (n === 'align') continue;
        // 인용 블록 스타일 유지 (허용된 클래스만)
        if (n === 'class' && /^(quoted-msg|quoted-head)$/.test(attr.value)) continue;
        child.removeAttribute(attr.name);
      }
      if (tag === 'IMG') {
        const src = String(child.getAttribute('src') || '');
        if (src.startsWith('/files/')) {
          // 화면 표시용 inline URL로 변환 (전달 시에는 상대 경로 유지)
          if (!keepRelative) child.setAttribute('src', inlineUrl(src));
          child.setAttribute('style', 'max-width:100%;border-radius:6px;');
        } else child.remove();
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

// 전달용: 이미지 경로를 서버 상대 경로 그대로 유지한 채 정화
const sanitizeHtmlKeepRelative = (h) => sanitizeHtml(h, true);

// 편집기 도구 막대
$$('#rtBar .rt-btn').forEach(btn => {
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // 선택 영역 유지
  btn.addEventListener('click', () => {
    $('#composeText').focus();
    document.execCommand(btn.dataset.cmd, false, null);
  });
});
$('#rtFont').addEventListener('change', (e) => {
  if (!e.target.value) return;
  $('#composeText').focus();
  document.execCommand('fontName', false, e.target.value);
  e.target.value = '';
});
$('#rtSize').addEventListener('change', (e) => {
  if (!e.target.value) return;
  $('#composeText').focus();
  document.execCommand('fontSize', false, e.target.value);
  e.target.value = '';
});
$('#rtColor').addEventListener('input', (e) => {
  $('#composeText').focus();
  document.execCommand('foreColor', false, e.target.value);
});

// 이미지 파일을 첨부 + 본문(커서 위치)에 삽입
function insertImageToEditor(f) {
  if (!f._previewUrl) f._previewUrl = URL.createObjectURL(f);
  $('#composeText').focus();
  document.execCommand('insertImage', false, f._previewUrl);
}

// 발송용 HTML: 본문 속 미리보기 이미지(blob:)를 업로드된 서버 경로로 치환
function composeHtmlForSend(uploaded) {
  const clone = $('#composeText').cloneNode(true);
  clone.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('/files/')) return; // 전달된 쪽지의 기존 이미지
    const f = S.composeFileList.find(x => x._previewUrl === src);
    const att = f && uploaded.find(a => a.name === f.name && a.size === f.size);
    if (att) img.setAttribute('src', att.url);
    else img.remove();
  });
  return clone.innerHTML.slice(0, 200000);
}

// 붙여넣기·드롭으로 들어온 data:/blob: 이미지를 첨부파일로 올려 본문에 남긴다.
// (이 처리가 없으면 전송할 때 본문 이미지가 사라짐)
async function materializeEditorImages() {
  const imgs = [...$('#composeText').querySelectorAll('img')];
  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('/files/')) continue;                       // 이미 서버에 있는 이미지
    if (S.composeFileList.some(x => x._previewUrl === src)) continue; // 이미 첨부 목록에 있음
    try {
      const blob = await (await fetch(src)).blob();
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const file = new File([blob], `붙여넣기-${Date.now()}.${ext}`, { type: blob.type });
      file._previewUrl = src;
      S.composeFileList.push(file);
    } catch (e) {
      img.remove(); // 되살릴 수 없는 이미지는 제거
    }
  }
  renderComposeFiles();
}

// 메시지에 저장된 서식 → 인라인 스타일 (구버전 쪽지 호환)
function msgStyleCss(m) {
  if (!m.style) return '';
  let s = '';
  if (m.style.size) s += `font-size:${Number(m.style.size)}px;`;
  if (m.style.color && /^#[0-9a-fA-F]{6}$/.test(m.style.color)) s += `color:${m.style.color};`;
  return s;
}

// 첨부파일 누적 목록 (파일 선택을 여러 번 해도 기존 파일 유지, 이미지는 미리보기)
function renderComposeFiles() {
  const box = $('#composeFileList');
  box.innerHTML = '';
  S.composeFileList.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'att-row';
    let thumb = '';
    if (IMG_EXT.test(f.name)) {
      if (!f._previewUrl) f._previewUrl = URL.createObjectURL(f);
      thumb = `<img class="att-thumb" src="${f._previewUrl}" alt="">`;
    } else if (VIDEO_EXT.test(f.name)) {
      if (!f._previewUrl) f._previewUrl = URL.createObjectURL(f);
      thumb = `<video class="att-thumb" src="${f._previewUrl}" controls preload="metadata"></video>`;
    }
    const icon = IMG_EXT.test(f.name) ? '🖼' : VIDEO_EXT.test(f.name) ? '🎬' : AUDIO_EXT.test(f.name) ? '🎵' : '📎';
    row.innerHTML = `<span>${icon}</span><span class="att-name">${esc(f.name)}</span>
      <span class="att-size">${fmtSize(f.size)}</span><span class="att-del" title="첨부 제거">✕</span>${thumb}`;
    row.querySelector('.att-del').onclick = () => {
      if (f._previewUrl) { try { URL.revokeObjectURL(f._previewUrl); } catch (e) {} }
      S.composeFileList.splice(i, 1);
      renderComposeFiles();
    };
    box.appendChild(row);
  });
}

function addComposeFiles(files) {
  for (const f of files) {
    // 같은 이름+크기의 중복 첨부 방지
    if (!S.composeFileList.some(x => x.name === f.name && x.size === f.size)) {
      S.composeFileList.push(f);
    }
  }
  renderComposeFiles();
}

// ---- 쪽지 임시저장 (받는사람·본문·예약 시각을 자동 보관, 첨부파일은 제외) ----
const draftKey = () => 'compose-draft:' + S.server + ':' + S.id;

function saveDraft() {
  if ($('#composeModal').style.display === 'none') return;
  const html = $('#composeText').innerHTML;
  const to = [...S.recipients];
  // 내용도 받는사람도 없으면 저장하지 않음
  if (!$('#composeText').innerText.trim() && !to.length && !$('#composeText').querySelector('img')) {
    return localStorage.removeItem(draftKey());
  }
  localStorage.setItem(draftKey(), JSON.stringify({
    to, html,
    schedOn: $('#schedChk').checked, schedTime: $('#schedTime').value,
    time: Date.now()
  }));
  $('#draftInfo').textContent = '💾 임시저장됨 ' + fmtTime(Date.now());
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey())); } catch (e) { return null; }
}
function clearDraft() {
  localStorage.removeItem(draftKey());
  $('#draftInfo').textContent = '';
}

function openCompose(preset, prefillText, carryAttachments, prefillHtml) {
  S.recipients = new Set(preset || []);
  S.composeCarry = carryAttachments || [];
  S.composeFileList = [];
  renderComposeFiles();
  if (prefillHtml) $('#composeText').innerHTML = prefillHtml;
  else $('#composeText').innerHTML = prefillText ? esc(prefillText).replace(/\n/g, '<br>') : '';
  $('#composeFiles').value = '';
  $('#composeError').textContent = '';
  $('#schedChk').checked = false;
  $('#schedTime').style.display = 'none';
  $('#schedTime').value = '';
  $('#composeCarry').innerHTML = S.composeCarry.length
    ? '전달할 첨부: ' + S.composeCarry.map(a => `📎 ${esc(a.name)}`).join(', ')
    : '';
  renderRecipients();
  renderPicker();
  $('#composeModal').style.display = 'flex';
  $('#draftInfo').textContent = '';

  // 새 쪽지(전달/답장이 아닌 경우)에 임시저장이 있으면 복원 여부 확인
  const d = loadDraft();
  const isNew = !preset && !prefillText && !prefillHtml && !(carryAttachments || []).length;
  if (isNew && d && (d.html || (d.to || []).length)) {
    if (confirm(`작성 중이던 쪽지가 있습니다. (${fmtFull(d.time)})\n이어서 작성할까요?`)) {
      S.recipients = new Set((d.to || []).filter(id => userById(id)));
      $('#composeText').innerHTML = d.html || '';
      if (d.schedOn) {
        $('#schedChk').checked = true;
        $('#schedTime').style.display = '';
        $('#schedTime').value = d.schedTime || '';
      }
      renderRecipients();
      renderPicker();
      $('#draftInfo').textContent = '💾 임시저장 내용을 불러왔습니다';
    } else clearDraft();
  }

  // 자동 임시저장 (10초 간격 + 입력 시)
  clearInterval(S.draftTimer);
  S.draftTimer = setInterval(saveDraft, 10000);
  $('#composeText').focus();
}

// ---- 사용자 선택기 (쪽지/채팅방 공용) ----
function syncPicker(pickerBox, set) {
  pickerBox.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = set.has(cb.dataset.id); });
}

function buildChips(chipBox, pickerBox, set) {
  chipBox.innerHTML = '';
  if (!set.size) chipBox.innerHTML = '<span style="color:#9aa;font-size:12px;padding:4px">아래 목록에서 선택하세요</span>';
  for (const id of set) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = nameOf(id);
    c.onclick = () => { set.delete(id); buildChips(chipBox, pickerBox, set); syncPicker(pickerBox, set); };
    chipBox.appendChild(c);
  }
}

function buildPicker(pickerBox, chipBox, set, exclude) {
  pickerBox.innerHTML = '';
  const excludeSet = new Set([S.me.id, ...(exclude || [])]);
  const refresh = () => { buildChips(chipBox, pickerBox, set); syncPicker(pickerBox, set); };
  // 검색 우선: 목록을 바로 보여주지 않고 검색어로 찾은 대상만 표시
  const input = document.createElement('input');
  input.className = 'pk-search';
  input.placeholder = '🔍 이름/부서/직위로 검색해서 선택하세요';
  const results = document.createElement('div');
  results.className = 'pk-results';
  const renderResults = () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q) {
      results.innerHTML = '<div class="pk-hint">검색어를 입력하면 대상이 표시됩니다.<br>왼쪽 조직도에서 이름을 클릭해도 추가됩니다.</div>';
      return;
    }
    const matches = S.users.filter(u => !excludeSet.has(u.id) && !u.system &&
      (u.name.toLowerCase().includes(q) ||
       (u.depts || [u.dept]).join(' ').toLowerCase().includes(q) ||
       (u.position || '').toLowerCase().includes(q)));
    if (!matches.length) {
      results.innerHTML = '<div class="pk-hint">검색 결과가 없습니다.</div>';
      return;
    }
    // 부서명이 검색어와 일치하면 부서 전체 선택 제공
    const deptHits = [...new Set(matches.flatMap(u => u.depts || [u.dept]))]
      .filter(d => d.toLowerCase().includes(q)).sort((a, b) => deptSorter(a, b));
    for (const d of deptHits) {
      const members = S.users.filter(u => !excludeSet.has(u.id) && !u.system && (u.depts || [u.dept]).includes(d));
      const dv = document.createElement('div');
      dv.className = 'pk-dept';
      dv.textContent = `👥 '${d}' 전체 선택/해제 (${members.length}명)`;
      dv.onclick = () => {
        const all = members.every(u => set.has(u.id));
        for (const u of members) all ? set.delete(u.id) : set.add(u.id);
        refresh();
      };
      results.appendChild(dv);
    }
    for (const u of matches.sort((a, b) => a.name.localeCompare(b.name, 'ko')).slice(0, 60)) {
      const row = document.createElement('label');
      row.className = 'pk-user';
      row.innerHTML = `<input type="checkbox" data-id="${esc(u.id)}" ${set.has(u.id) ? 'checked' : ''}>
        ${esc(u.name)} <span style="color:#9aa;font-size:11px">${esc((u.depts || [u.dept]).join(', '))}${u.position ? ' · ' + esc(u.position) : ''}</span>`;
      row.querySelector('input').onchange = (e) => {
        e.target.checked ? set.add(u.id) : set.delete(u.id);
        refresh();
      };
      results.appendChild(row);
    }
  };
  input.addEventListener('input', renderResults);
  pickerBox.appendChild(input);
  pickerBox.appendChild(results);
  renderResults();
  refresh();
  setTimeout(() => input.focus(), 50);
}

function renderRecipients() {
  buildChips($('#recipChips'), $('#recipPicker'), S.recipients);
  syncPicker($('#recipPicker'), S.recipients);
}

function renderPicker() {
  buildPicker($('#recipPicker'), $('#recipChips'), S.recipients);
}

async function uploadFiles(fileList) {
  const out = [];
  for (const f of fileList) {
    const res = await fetch(httpBase() + '/upload?token=' + encodeURIComponent(S.token) +
      '&name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    if (!res.ok) throw new Error('파일 업로드 실패: ' + f.name);
    out.push(await res.json());
  }
  return out;
}

$('#schedChk').addEventListener('change', (e) => {
  $('#schedTime').style.display = e.target.checked ? '' : 'none';
  if (e.target.checked && !$('#schedTime').value) {
    // 기본값: 1시간 뒤 (datetime-local은 로컬 시간 문자열 필요)
    const d = new Date(Date.now() + 3600000 - new Date().getTimezoneOffset() * 60000);
    $('#schedTime').value = d.toISOString().slice(0, 16);
  }
});

$('#composeBtn').addEventListener('click', () => openCompose());
function closeCompose() {
  saveDraft(); // 실수로 닫아도 내용이 남도록 저장
  clearInterval(S.draftTimer);
  $('#composeModal').style.display = 'none';
}
$('#composeCancel').addEventListener('click', closeCompose);
$('#composeClose').addEventListener('click', closeCompose);
// ESC로도 닫기 (작성 중 내용은 임시저장됨)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#composeModal').style.display !== 'none') closeCompose();
});
// 지금 임시저장하고 닫기
$('#draftSaveBtn').addEventListener('click', () => {
  saveDraft();
  clearInterval(S.draftTimer);
  $('#composeModal').style.display = 'none';
  alert('작성 중인 쪽지를 임시저장했습니다.\n다시 [쪽지 보내기]를 열면 이어서 작성할 수 있습니다.');
});
// 이미지 붙여넣기(Ctrl+V): 첨부로 등록하고 본문에 삽입
$('#composeText').addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find(it => it.type && it.type.startsWith('image/'));
  if (!imgItem) return; // 일반 텍스트 붙여넣기는 그대로
  const blob = imgItem.getAsFile();
  if (!blob) return;
  e.preventDefault();
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const file = new File([blob], `붙여넣기-${Date.now()}.${ext}`, { type: blob.type });
  addComposeFiles([file]);
  const added = S.composeFileList.find(x => x.name === file.name && x.size === file.size);
  if (added) insertImageToEditor(added);
});

// 입력이 멈추면 자동 저장
let draftDebounce = null;
$('#composeText').addEventListener('input', () => {
  clearTimeout(draftDebounce);
  draftDebounce = setTimeout(saveDraft, 1500);
});
$('#composeAddFile').addEventListener('click', () => $('#composeFiles').click());
$('#composeFiles').addEventListener('change', () => {
  addComposeFiles([...$('#composeFiles').files]);
  $('#composeFiles').value = ''; // 다음 선택 때 기존 목록이 지워지지 않도록 초기화
});
$('#composeSend').addEventListener('click', async () => {
  const editor = $('#composeText');
  const text = editor.innerText;
  const files = S.composeFileList || [];
  const carry = S.composeCarry || [];
  if (!S.recipients.size) return $('#composeError').textContent = '받는 사람을 선택하세요.';
  if (!text.trim() && !files.length && !carry.length && !editor.querySelector('img'))
    return $('#composeError').textContent = '내용 또는 첨부파일을 입력하세요.';
  let sendAt = 0;
  if ($('#schedChk').checked) {
    sendAt = new Date($('#schedTime').value).getTime();
    if (!sendAt || isNaN(sendAt)) return $('#composeError').textContent = '예약 시각을 선택하세요.';
    if (sendAt < Date.now() + 60000) return $('#composeError').textContent = '예약 시각은 최소 1분 이후여야 합니다.';
  }
  $('#composeSend').disabled = true;
  $('#composeError').textContent = files.length ? '파일 업로드 중…' : '';
  try {
    // 붙여넣은 이미지를 첨부로 변환 (본문 이미지가 사라지지 않도록)
    await materializeEditorImages();
    const files2 = S.composeFileList || [];
    const uploaded = files2.length ? await uploadFiles(files2) : [];
    const attachments = [...carry, ...uploaded];
    // 서식(태그)이 있으면 HTML 본문도 함께 전송
    const html = editor.querySelector('*') ? composeHtmlForSend(uploaded) : undefined;
    send({
      type: 'send_message', to: [...S.recipients], text, attachments,
      sendAt: sendAt || undefined,
      html
    });
    clearDraft(); // 발송 완료 → 임시저장 삭제
    clearInterval(S.draftTimer);
    $('#composeModal').style.display = 'none';
  } catch (e) {
    $('#composeError').textContent = e.message;
  } finally {
    $('#composeSend').disabled = false;
  }
});

// ---------- 대화 전송 ----------
async function sendChat(extra) {
  const text = $('#chatText').value;
  const files = [...S.chatFiles, ...(extra || [])];
  if (!S.chatPeer || (!text.trim() && !files.length)) return;
  $('#chatSendBtn').disabled = true;
  try {
    const attachments = files.length ? await uploadFiles(files) : [];
    send({ type: 'send_message', to: [S.chatPeer], text, attachments });
    $('#chatText').value = '';
    S.chatFiles = [];
    renderPending('chat');
  } catch (e) { alert(e.message); }
  finally { $('#chatSendBtn').disabled = false; }
}
$('#chatSendBtn').addEventListener('click', () => sendChat([]));
$('#chatText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat([]); }
});
$('#chatAttachBtn').addEventListener('click', () => $('#chatFileInput').click());
$('#chatFileInput').addEventListener('change', () => {
  addPendingFiles('chat', [...$('#chatFileInput').files]);
  $('#chatFileInput').value = '';
  $('#chatText').focus();
});

// ---------- 회원가입 요청 승인 (관리자) ----------
function renderSignups() {
  const admin = !!(S.me && S.me.admin);
  const list = S.signups || [];
  $('#signupMgrBtn').style.display = admin ? '' : 'none';
  const badge = $('#signupBadge');
  badge.style.display = admin && list.length ? '' : 'none';
  badge.textContent = list.length;
  const box = $('#signupMgrList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">대기 중인 가입 요청이 없습니다.</div>';
    return;
  }
  for (const s of list) {
    const el = document.createElement('div');
    el.className = 'signup-item';
    el.innerHTML = `<div class="su-line"><b>${esc(s.name)}</b>
        <span class="su-id">${esc(s.id)}</span><span class="spacer"></span>
        <span class="when">${fmtFull(s.time)}</span></div>
      <div class="su-detail">부서: ${esc(s.dept || '-')} · 직위: ${esc(s.position || '-')}${s.subject ? ' · 과목: ' + esc(s.subject) : ''}<br>
        사무실 전화: ${esc(s.phone || '-')}${s.mobile ? ' · 핸드폰: ' + esc(s.mobile) : ''}${s.email ? ' · ' + esc(s.email) : ''}</div>
      <div class="su-btns"><button class="primary su-ok">✔ 승인</button><button class="su-no danger-text">✕ 거절</button></div>`;
    el.querySelector('.su-ok').onclick = () => {
      if (confirm(`${s.name}(${s.id}) 님의 가입을 승인할까요?\n승인하면 바로 로그인할 수 있습니다.`)) {
        send({ type: 'approve_signup', reqId: s.reqId });
      }
    };
    el.querySelector('.su-no').onclick = () => {
      if (confirm(`${s.name}(${s.id}) 님의 가입 요청을 거절할까요?\n요청 내용이 삭제됩니다.`)) {
        send({ type: 'reject_signup', reqId: s.reqId });
      }
    };
    box.appendChild(el);
  }
}

function openSignupMgr() {
  if (!S.me || !S.me.admin) return;
  send({ type: 'list_signups' }); // 최신 목록으로 갱신
  renderSignups();
  $('#signupMgrModal').style.display = 'flex';
}
$('#signupMgrBtn').addEventListener('click', openSignupMgr);
$('#signupMgrClose').addEventListener('click', () => { $('#signupMgrModal').style.display = 'none'; });

// ---------- 공지 ----------
function localDatetimeValue(msFromNow) {
  const d = new Date(Date.now() + msFromNow - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// pollOnly=true면 설문 전용(일반 사용자용): 설문 강제, 예약/설문해제 숨김
// 공지 첨부파일 목록 (새로 고른 파일 + 수정 시 기존 첨부)
function renderNoticeFiles() {
  const box = $('#noticeFileList');
  box.innerHTML = '';
  // 기존(이미 업로드된) 첨부
  (S.noticeKeepAtts || []).forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'att-row';
    row.innerHTML = `<span>📎</span><span class="att-name">${esc(a.name)}</span>
      <span class="att-size">${fmtSize(a.size)}</span><span class="att-del" title="첨부 제거">✕</span>`;
    row.querySelector('.att-del').onclick = () => { S.noticeKeepAtts.splice(i, 1); renderNoticeFiles(); };
    box.appendChild(row);
  });
  // 새로 추가한 파일
  (S.noticeFileList || []).forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'att-row';
    const icon = IMG_EXT.test(f.name) ? '🖼' : VIDEO_EXT.test(f.name) ? '🎬' : '📎';
    row.innerHTML = `<span>${icon}</span><span class="att-name">${esc(f.name)}</span>
      <span class="att-size">${fmtSize(f.size)}</span><span class="att-del" title="첨부 제거">✕</span>`;
    row.querySelector('.att-del').onclick = () => { S.noticeFileList.splice(i, 1); renderNoticeFiles(); };
    box.appendChild(row);
  });
}

function addNoticeFiles(files) {
  S.noticeFileList = S.noticeFileList || [];
  for (const f of files) {
    if (!S.noticeFileList.some(x => x.name === f.name && x.size === f.size)) S.noticeFileList.push(f);
  }
  renderNoticeFiles();
}

// pollOnly=true면 설문 전용, editNotice가 있으면 수정 모드
function openNoticeModal(pollOnly, editNotice) {
  const n = editNotice || null;
  S.editingNoticeId = n ? n.id : null;
  S.noticeFileList = [];
  S.noticeKeepAtts = n ? [...(n.attachments || [])] : [];
  renderNoticeFiles();
  $('#noticeTitle').value = n ? n.title : '';
  $('#noticeBody').value = n ? n.body : '';
  $('#pollOptions').value = n && n.poll ? n.poll.options.join('\n') : '';
  $('#pollDeadline').value = '';
  $('#noticeSchedChk').checked = false;
  $('#noticeSchedTime').style.display = 'none';
  $('#noticeSchedTime').value = '';
  $('#noticeError').textContent = '';
  S.noticePollOnly = !!pollOnly;
  const hasPoll = n ? !!n.poll : !!pollOnly;
  $('#noticeModalTitle').textContent = n ? '✏ 공지 수정' : (pollOnly ? '📊 설문 만들기' : '공지 쓰기');
  $('#noticeTitle').placeholder = pollOnly ? '설문 제목' : '공지 제목';
  $('#noticePollChk').checked = hasPoll;
  // 수정 모드에서는 설문 포함 여부를 바꿀 수 없음 (기존 투표 보존)
  $('#noticePollChkRow').style.display = (pollOnly || n) ? 'none' : '';
  $('#noticePollBox').style.display = hasPoll ? '' : 'none';
  $('#pollOptions').disabled = !!n; // 수정 시 항목 변경 불가, 마감 시각만 조정
  // 선택 방식/공개 여부도 등록할 때만 정할 수 있음 (투표가 시작된 뒤에는 바뀌면 안 됨)
  $('#pollMulti').checked = n && n.poll ? !!n.poll.multi : false;
  $('#pollAnon').checked = n && n.poll ? !!n.poll.anon : false;
  $('#pollMulti').disabled = !!n;
  $('#pollAnon').disabled = !!n;
  if (n && n.poll) $('#pollDeadline').value = localDatetimeValue(n.poll.deadline - Date.now());
  else if (pollOnly) $('#pollDeadline').value = localDatetimeValue(7 * 86400000);
  $('#noticeSchedRow').style.display = (pollOnly || n) ? 'none' : ''; // 설문/수정은 예약 숨김
  $('#noticePost').textContent = n ? '수정 저장' : '등록';
  $('#noticeModal').style.display = 'flex';
  $('#noticeTitle').focus();
}
$('#noticeWriteBtn').addEventListener('click', () => openNoticeModal(false));
$('#pollWriteBtn').addEventListener('click', () => openNoticeModal(true));
// 목록 상단 고정 도구 모음
$('#noticeWriteBtn2').addEventListener('click', () => openNoticeModal(false));
$('#pollWriteBtn2').addEventListener('click', () => openNoticeModal(true));
$('#inboxComposeBtn').addEventListener('click', () => openCompose());
$('#sentComposeBtn').addEventListener('click', () => openCompose());
$('#noticeSearch').addEventListener('input', () => renderNotices());
$('#noticePollChk').addEventListener('change', (e) => {
  $('#noticePollBox').style.display = e.target.checked ? '' : 'none';
  if (e.target.checked && !$('#pollDeadline').value) {
    $('#pollDeadline').value = localDatetimeValue(7 * 86400000); // 기본 마감: 일주일 뒤
  }
});
$('#noticeSchedChk').addEventListener('change', (e) => {
  $('#noticeSchedTime').style.display = e.target.checked ? '' : 'none';
  if (e.target.checked && !$('#noticeSchedTime').value) {
    $('#noticeSchedTime').value = localDatetimeValue(3600000); // 기본: 1시간 뒤
  }
});
$('#noticeCancel').addEventListener('click', () => { $('#noticeModal').style.display = 'none'; });
$('#noticeAddFile').addEventListener('click', () => $('#noticeFiles').click());
$('#noticeFiles').addEventListener('change', () => {
  addNoticeFiles([...$('#noticeFiles').files]);
  $('#noticeFiles').value = '';
});
setupDropZone(document.querySelector('#noticeModal .modal'), (files) => addNoticeFiles(files));

$('#noticePost').addEventListener('click', async () => {
  const title = $('#noticeTitle').value.trim();
  if (!title) return $('#noticeError').textContent = '제목을 입력하세요.';
  const editing = S.editingNoticeId;
  const payload = editing
    ? { type: 'edit_notice', noticeId: editing, title, body: $('#noticeBody').value }
    : { type: 'post_notice', title, body: $('#noticeBody').value };
  if ($('#noticePollChk').checked) {
    const deadline = new Date($('#pollDeadline').value).getTime();
    if (!deadline || isNaN(deadline) || deadline < Date.now() + 60000)
      return $('#noticeError').textContent = '설문 마감 시각은 최소 1분 이후여야 합니다.';
    if (editing) {
      payload.pollDeadline = deadline; // 수정 시 마감 시각만 조정
    } else {
      const options = $('#pollOptions').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (options.length < 2) return $('#noticeError').textContent = '설문 항목을 2개 이상 입력하세요.';
      // 공지는 제목이 곧 설문 제목이므로 q는 비워 둔다 (채팅방 설문만 별도 질문을 가짐)
      payload.poll = { options, deadline, multi: $('#pollMulti').checked, anon: $('#pollAnon').checked };
    }
  }
  if (!editing && $('#noticeSchedChk').checked) {
    const publishAt = new Date($('#noticeSchedTime').value).getTime();
    if (!publishAt || isNaN(publishAt) || publishAt < Date.now() + 60000)
      return $('#noticeError').textContent = '예약 시각은 최소 1분 이후여야 합니다.';
    payload.publishAt = publishAt;
  }
  // 첨부파일 업로드 후 전송
  $('#noticePost').disabled = true;
  try {
    const files = S.noticeFileList || [];
    if (files.length) $('#noticeError').textContent = '파일 업로드 중…';
    const uploaded = files.length ? await uploadFiles(files) : [];
    payload.attachments = [...(S.noticeKeepAtts || []), ...uploaded];
    send(payload);
    $('#noticeModal').style.display = 'none';
  } catch (e) {
    $('#noticeError').textContent = e.message;
  } finally {
    $('#noticePost').disabled = false;
  }
});

// ---------- 내 정보 수정 (프로필 + 비밀번호) ----------
// 전화번호 자동 하이픈 (숫자만 입력된 경우에만 적용, 내선 등 문구가 있으면 그대로 둠)
function fmtPhoneNumber(v) {
  if (!/^[\d\s-]+$/.test(v)) return v;
  const d = v.replace(/\D/g, '');
  if (d.length < 8 || d.length > 11) return v;
  if (d.startsWith('02')) {
    if (d.length <= 9) return d.slice(0, 2) + '-' + d.slice(2, d.length - 4) + '-' + d.slice(-4);
    return d.slice(0, 2) + '-' + d.slice(2, 6) + '-' + d.slice(6, 10);
  }
  if (d.length <= 10) return d.slice(0, 3) + '-' + d.slice(3, d.length - 4) + '-' + d.slice(-4);
  return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7, 11);
}
for (const s of ['#pfPhone', '#pfMobile']) {
  $(s).addEventListener('blur', (e) => { e.target.value = fmtPhoneNumber(e.target.value.trim()); });
}

function openProfileModal() {
  const me = userById(S.me.id) || S.me;
  $('#pfDept').value = (me.depts || [me.dept]).join(', ');
  $('#pfOffice').value = me.office || '';
  $('#pfSubject').value = me.subject || '';
  $('#pfPhone').value = me.phone || '';
  $('#pfMobile').value = me.mobile || '';
  $('#pfEmail').value = me.email || '';
  for (const s of ['#pwOld', '#pwNew', '#pwNew2']) $(s).value = '';
  $('#pwError').textContent = '';
  $('#profileModal').style.display = 'flex';
  $('#pfSubject').focus();
}

$('#profileBtn').addEventListener('click', openProfileModal);
$('#pwCancel').addEventListener('click', () => { $('#profileModal').style.display = 'none'; });
$('#pwSubmit').addEventListener('click', () => {
  // 프로필 정보는 항상 저장
  send({
    type: 'update_profile',
    dept: $('#pfDept').value.trim() || undefined,
    office: $('#pfOffice').value, subject: $('#pfSubject').value,
    phone: $('#pfPhone').value, mobile: $('#pfMobile').value, email: $('#pfEmail').value
  });
  // 비밀번호 칸을 채웠으면 함께 변경 (결과는 change_pw_result에서 처리)
  const wantPw = $('#pwOld').value || $('#pwNew').value || $('#pwNew2').value;
  if (wantPw) {
    if ($('#pwNew').value !== $('#pwNew2').value)
      return $('#pwError').textContent = '새 비밀번호가 서로 다릅니다.';
    send({ type: 'change_pw', oldPw: $('#pwOld').value, newPw: $('#pwNew').value });
  } else {
    $('#profileModal').style.display = 'none';
    alert('저장되었습니다.');
  }
});

// ---------- 회원가입 요청 ----------
// 로그인 전이므로 임시 WebSocket으로 요청만 보내고 닫는다 (암호화 핸드셰이크 포함)
function requestSignup(server, data, cb) {
  let done = false, key = null;
  const finish = (r) => { if (!done) { done = true; cb(r); } };
  let ws;
  try { ws = new WebSocket('ws://' + server + '/ws'); }
  catch (e) { return finish({ ok: false, error: '서버 주소 형식이 올바르지 않습니다.' }); }
  const t = setTimeout(() => { finish({ ok: false, error: '서버 응답이 없습니다. 주소를 확인하세요.' }); try { ws.close(); } catch (e) {} }, 8000);
  const sendEnc = async (obj) => {
    ws.send(key ? JSON.stringify({ e: await encryptMsg2(key, JSON.stringify(obj)) }) : JSON.stringify(obj));
  };
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.e && key) { try { m = JSON.parse(await decryptMsg2(key, m.e)); } catch (e) { return; } }
    if (m.type === 'hello') {
      try { key = await handshakeKey(m.pub, (pub) => ws.send(JSON.stringify({ type: 'key', pub }))); }
      catch (e) { key = null; }
      await sendEnc({ type: 'signup_request', ...data });
      return;
    }
    if (m.type === 'signup_result') { clearTimeout(t); finish(m); try { ws.close(); } catch (e) {} }
  };
  ws.onclose = () => { clearTimeout(t); finish({ ok: false, error: '서버에 연결할 수 없습니다. 주소와 서버 실행 여부를 확인하세요.' }); };
}

// 독립 세션 키(회원가입 임시 연결용) 핸드셰이크·암복호화 헬퍼
async function handshakeKey(serverPubB64, sendMyPub) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const myPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const serverKey = await crypto.subtle.importKey('raw', b64.dec(serverPubB64),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, kp.privateKey, 256);
  const keyBytes = await crypto.subtle.digest('SHA-256', bits);
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  sendMyPub(b64.enc(myPub));
  return aesKey;
}
async function encryptMsg2(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return b64.enc(out);
}
async function decryptMsg2(key, b64str) {
  const buf = b64.dec(b64str);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
  return new TextDecoder().decode(pt);
}

$('#signupBtn').addEventListener('click', () => {
  for (const s of ['#suId', '#suPw', '#suPw2', '#suName', '#suDept', '#suPos', '#suSubject', '#suPhone', '#suMobile', '#suEmail'])
    $(s).value = '';
  $('#signupError').textContent = '';
  $('#signupModal').style.display = 'flex';
  $('#suId').focus();
});
$('#signupCancel').addEventListener('click', () => { $('#signupModal').style.display = 'none'; });
// 전화번호 자동 하이픈
for (const s of ['#suPhone', '#suMobile']) {
  $(s).addEventListener('blur', (e) => { e.target.value = fmtPhoneNumber(e.target.value.trim()); });
}
$('#signupSubmit').addEventListener('click', () => {
  const err = (msg) => { $('#signupError').textContent = msg; };
  let server = $('#loginServer').value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!server) return err('위 로그인 화면의 서버 주소를 먼저 입력하세요.');
  if (!server.includes(':')) server += ':7777';
  const data = {
    id: $('#suId').value.trim(), pw: $('#suPw').value,
    name: $('#suName').value.trim(), dept: $('#suDept').value.trim(), position: $('#suPos').value.trim(),
    subject: $('#suSubject').value.trim(),
    phone: fmtPhoneNumber($('#suPhone').value.trim()),
    mobile: fmtPhoneNumber($('#suMobile').value.trim()), email: $('#suEmail').value.trim()
  };
  for (const [f, label] of [['id', '아이디'], ['pw', '비밀번호'], ['name', '이름'], ['dept', '부서/학년'],
    ['position', '직위'], ['phone', '사무실 전화']]) {
    if (!data[f]) return err(`필수 항목을 입력하세요: ${label}`);
  }
  if ($('#suPw').value !== $('#suPw2').value) return err('비밀번호가 서로 다릅니다.');
  if ($('#suPw').value.length < 4) return err('비밀번호는 4자 이상이어야 합니다.');
  $('#signupSubmit').disabled = true;
  err('요청을 보내는 중…');
  requestSignup(server, data, (r) => {
    $('#signupSubmit').disabled = false;
    if (r.ok) {
      $('#signupModal').style.display = 'none';
      alert('회원가입 요청이 접수되었습니다.\n관리자가 승인하면 로그인할 수 있습니다.');
    } else err(r.error || '요청에 실패했습니다.');
  });
});

// ---------- 프로그램 정보 ----------
$('#aboutBtn').addEventListener('click', async () => {
  $('#aboutVersion').textContent = 'v' + await window.native.getVersion();
  $('#aboutModal').style.display = 'flex';
});
$('#aboutClose').addEventListener('click', () => { $('#aboutModal').style.display = 'none'; });

// ---------- 로그인/로그아웃 ----------
// ---------- 저장된 접속 정보 (여러 개) ----------
function getSavedConns() {
  try { return JSON.parse(localStorage.getItem('savedConns')) || []; } catch (e) { return []; }
}
function setSavedConns(list) {
  localStorage.setItem('savedConns', JSON.stringify(list.slice(0, 20)));
  renderSavedConns();
}
function renderSavedConns() {
  const list = getSavedConns();
  $('#savedConnRow').style.display = list.length ? '' : 'none';
  const sel = $('#savedConnSel');
  sel.innerHTML = list.map((c, i) =>
    `<option value="${i}">${esc(c.id)} @ ${esc(c.servers.join(', '))}</option>`).join('');
}
function applySavedConn(i) {
  const c = getSavedConns()[i];
  if (!c) return;
  $('#loginServer').value = c.servers.join(', ');
  $('#loginId').value = c.id;
  try { $('#loginPw').value = c.pw ? decodeURIComponent(atob(c.pw)) : ''; } catch (e) { $('#loginPw').value = ''; }
}
$('#savedConnSel').addEventListener('change', (e) => applySavedConn(Number(e.target.value)));
$('#savedConnDel').addEventListener('click', () => {
  const i = Number($('#savedConnSel').value);
  const list = getSavedConns();
  if (Number.isInteger(i) && list[i] && confirm(`'${list[i].id} @ ${list[i].servers.join(', ')}' 접속 정보를 삭제할까요?`)) {
    list.splice(i, 1);
    setSavedConns(list);
  }
});

function saveCurrentConn() {
  const list = getSavedConns();
  const idx = list.findIndex(c => c.id === S.id);
  // 같은 아이디로 다른 주소에서 접속해도 기존 주소를 덮어쓰지 않고 누적 저장
  const prevServers = idx >= 0 ? (list[idx].servers || []) : [];
  const servers = [...new Set([...S.serverList, ...prevServers])].slice(0, 6);
  const entry = { id: S.id, servers, pw: btoa(encodeURIComponent(S.pw)) };
  if (idx >= 0) list[idx] = entry; else list.unshift(entry);
  setSavedConns(list);
  // 다음 재접속 순환에도 누적된 주소 전체 사용
  S.serverList = servers;
}

function doLogin() {
  // 서버 주소: 쉼표로 여러 개 입력 가능 (유선/무선 등) — 끊기면 번갈아 재시도
  const servers = $('#loginServer').value.split(',')
    .map(s => s.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map(s => (s.includes(':') ? s : s + ':7777'));
  const id = $('#loginId').value.trim();
  const pw = $('#loginPw').value;
  if (!servers.length || !id) return loginFail('서버 주소와 아이디를 입력하세요.');
  S.serverList = [...new Set(servers)];
  S.serverIdx = 0;
  S.server = S.serverList[0];
  S.initialTriesLeft = S.serverList.length;
  S.id = id; S.pw = pw;
  $('#loginError').textContent = '';
  $('#loginBtn').disabled = true;
  connect();
}
$('#loginBtn').addEventListener('click', doLogin);
$('#loginPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('#logoutBtn').addEventListener('click', () => {
  if (!confirm('로그아웃 할까요?')) return;
  S.chatPeer = null;
  S.currentRoom = null;
  backToLogin('');
});
$('#searchInput').addEventListener('input', () => renderTree());
$('#inboxSearch').addEventListener('input', () => renderInbox());
$('#sentSearch').addEventListener('input', () => renderSent());

// ---------- 설정 ----------
$('#settingsBtn').addEventListener('click', async () => {
  $('#autostartChk').checked = await window.native.getAutostart();
  $('#soundChk').checked = soundOn();
  $('#darkChk').checked = document.body.classList.contains('dark');
  $('#dlDirNow').textContent = await window.native.getDownloadDir();
  $('#settingsModal').style.display = 'flex';
});
// 첨부파일 저장 폴더
$('#dlDirChange').addEventListener('click', async () => {
  const d = await window.native.chooseDownloadDir();
  if (d) { $('#dlDirNow').textContent = d; alert('첨부파일 저장 폴더가 변경되었습니다.\n' + d); }
});
$('#dlDirReset').addEventListener('click', async () => {
  $('#dlDirNow').textContent = await window.native.resetDownloadDir();
});
$('#dlDirOpen').addEventListener('click', () => window.native.openDownloadDir());
$('#settingsClose').addEventListener('click', () => { $('#settingsModal').style.display = 'none'; });
$('#dlDirBtn').addEventListener('click', () => window.native.openDownloadDir()); // 헤더: 받은 파일 폴더 열기

// 모든 모달 오른쪽 위 닫기(X) 버튼 — 각 모달의 취소/닫기 버튼과 같은 동작 (쪽지 보내기는 전용 X 버튼 있음)
const MODAL_CLOSE_BTN = {
  detailModal: '#detailClose', noticeModal: '#noticeCancel', groupModal: '#groupModalCancel',
  adminModal: '#adminClose', roomModal: '#roomModalCancel', settingsModal: '#settingsClose',
  profileModal: '#pwCancel', deptRenameModal: '#drCancel', aboutModal: '#aboutClose', signupModal: '#signupCancel',
  roomPollModal: '#rpCancel', signupMgrModal: '#signupMgrClose'
};
for (const [modalId, closeSel] of Object.entries(MODAL_CLOSE_BTN)) {
  const modal = document.querySelector('#' + modalId + ' .modal');
  if (!modal || modal.querySelector('.modal-x')) continue;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'modal-x';
  x.title = '닫기';
  x.textContent = '✕';
  x.addEventListener('click', () => $(closeSel).click());
  modal.prepend(x);
}
$('#autostartChk').addEventListener('change', async (e) => {
  e.target.checked = await window.native.setAutostart(e.target.checked);
});
$('#soundChk').addEventListener('change', (e) => {
  localStorage.setItem('soundOff', e.target.checked ? '0' : '1');
  if (e.target.checked) beep();
});
$('#darkChk').addEventListener('change', (e) => {
  document.body.classList.toggle('dark', e.target.checked);
  localStorage.setItem('darkMode', e.target.checked ? '1' : '0');
});

// ---------- 내 상태 ----------
$('#statusSel').addEventListener('change', (e) => {
  send({ type: 'set_status', status: e.target.value });
});

// ---------- 드래그앤드롭 첨부 ----------
// 창의 아무 곳에 파일을 떨어뜨려도 페이지가 이동하지 않도록 차단
['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));

function setupDropZone(el, onFiles) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    if ([...e.dataTransfer.types].includes('Files')) el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (e.target === el || !el.contains(e.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const files = [...e.dataTransfer.files];
    if (files.length) onFiles(files);
  });
}

// 쪽지 작성 모달: 떨어뜨린 파일을 첨부 목록에 누적 추가 (이미지는 본문에도 삽입)
setupDropZone(document.querySelector('#composeModal .modal'), (files) => {
  addComposeFiles(files);
  for (const f of files) {
    const added = S.composeFileList.find(x => x.name === f.name && x.size === f.size);
    if (added && IMG_EXT.test(added.name)) insertImageToEditor(added);
  }
});

// 1:1 대화 / 채팅방: 떨어뜨린 파일을 입력창 위에 첨부해 두고 [전송]으로 보냄
// (드롭 중에는 브라우저가 확인창을 막기 때문에 확인 없이 바로 첨부한다)
setupDropZone($('#tab-chat'), (files) => {
  if (S.chatPeer) addPendingFiles('chat', files);
});
setupDropZone($('#tab-rooms'), (files) => {
  if (roomById(S.currentRoom)) addPendingFiles('room', files);
});

// ---------- 파일 다운로드 진행 표시 ----------
const dlItems = new Map();
window.native.onDownloadProgress((d) => {
  const panel = $('#dlPanel');
  let el = dlItems.get(d.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'dl-item';
    el.innerHTML = `<span class="dl-close" title="닫기">✕</span><div class="dl-name"></div>
      <div class="dl-bar-wrap"><div class="dl-bar"></div></div>
      <div class="dl-status"></div>`;
    el.querySelector('.dl-close').onclick = () => { el.remove(); dlItems.delete(d.id); };
    panel.appendChild(el);
    dlItems.set(d.id, el);
  }
  el.querySelector('.dl-name').textContent = '📥 ' + d.name;
  const bar = el.querySelector('.dl-bar');
  const st = el.querySelector('.dl-status');
  const pct = d.total ? Math.round(d.received / d.total * 100) : 0;
  const remove = (ms) => setTimeout(() => { el.remove(); dlItems.delete(d.id); }, ms);
  if (d.state === 'completed') {
    bar.style.width = '100%';
    if (d.isUpdate) {
      st.textContent = `✅ 준비 완료 (${fmtSize(d.received)}) — 상단의 [재시작] 버튼을 누르면 적용됩니다`;
      remove(12000);
      return;
    }
    st.innerHTML = `✅ 완료 (${fmtSize(d.received)})
      <a href="#" class="dl-run">파일 열기</a> · <a href="#" class="dl-open">폴더에서 보기</a>`;
    st.querySelector('.dl-run').onclick = (e) => {
      e.preventDefault();
      window.native.openFile(d.path);
    };
    st.querySelector('.dl-open').onclick = (e) => {
      e.preventDefault();
      window.native.showInFolder(d.path);
    };
    remove(20000);
  } else if (d.state === 'cancelled' || d.state === 'interrupted') {
    bar.style.width = '100%';
    bar.classList.add('dl-fail');
    st.textContent = '❌ 다운로드가 중단되었습니다';
    remove(8000);
  } else {
    bar.style.width = pct + '%';
    st.textContent = d.total
      ? `${pct}% (${fmtSize(d.received)} / ${fmtSize(d.total)})`
      : '다운로드 중… ' + fmtSize(d.received);
  }
});

// 다크 모드 복원
if (localStorage.getItem('darkMode') === '1') document.body.classList.add('dark');

// 저장된 로그인 정보 복원 (구버전 loginInfo → savedConns 마이그레이션 포함)
try {
  const legacy = JSON.parse(localStorage.getItem('loginInfo'));
  if (legacy && legacy.server && !getSavedConns().length) {
    setSavedConns([{ id: legacy.id || '', servers: [legacy.server], pw: legacy.pw || '' }]);
    localStorage.removeItem('loginInfo');
  }
} catch (e) {}
renderSavedConns();
if (getSavedConns().length) applySavedConn(0);
