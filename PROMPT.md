# 🏫 학교메신저(School Messenger) 재현 프롬프트

> 이 문서를 AI 코딩 도구(또는 개발자)에게 그대로 전달하면 동일한 프로그램을 만들 수 있도록 작성한 전체 요구사항 명세입니다.
> 결과물: **Windows용 서버 설치파일 + Windows용 클라이언트 설치파일** (NSIS .exe)

---

## 1. 프로그램 개요

쿨메신저처럼 **학교 교내망(LAN) 전용**으로 동작하는 사내 메신저를 만들어줘.
외부 인터넷 없이 학교 내부 네트워크만으로 동작해야 하고, 결과물은 두 개의 Windows 설치파일이야.

- **서버**: 교내에서 항상 켜져 있는 PC 1대에 설치. 메시지 서버 + 관리자 화면(계정/부서/로그/업데이트 관리)
- **클라이언트**: 교직원 각자 PC에 설치. 로그인해서 쪽지·대화·채팅방·공지를 사용

## 2. 기술 스택 · 프로젝트 구조

- Electron (서버 관리 UI, 클라이언트 모두) + Node.js
- 서버 내부: Express(HTTP) + ws(WebSocket), 데이터는 **JSON 파일 저장** (별도 DB 설치 불필요)
- 서버 코어(`server.js`)는 Electron에 의존하지 않게 분리해 단독 node로 테스트 가능하게 할 것
- 빌드: electron-builder → NSIS 설치파일 (`oneClick:false`, 설치 경로 변경 허용, 바탕화면 바로가기)
- 폴더 구조:

```
schoolmessenger/
├─ server/   # 서버 앱
│   ├─ main.js, preload.js     # 윈도우 관리 프로그램 (Electron)
│   ├─ server.js               # 서버 코어 (Electron 비의존)
│   ├─ headless.js             # 리눅스용 실행 파일 (node headless.js) + web-admin.js (웹 관리 화면 /admin)
│   ├─ updater.js              # GitHub 릴리스 확인·내려받기 (크기·SHA-256 검증)
│   ├─ update-manager.js       # 자동 업데이트 정책 (6시간 확인, 클라이언트 자동 배포, 접속자 0명일 때 서버 설치)
│   ├─ admin-core.js           # CSV 내보내기/가져오기·백업 공용 (윈도우·리눅스 공용)
│   ├─ linux/                  # install.sh, uninstall.sh, 리눅스설치안내.txt
│   ├─ scripts/build-linux.js  # 리눅스 꾸러미(tar.gz) 만들기 (npm run dist:linux)
│   └─ ui/                     # index.html·style.css·app.js + web-api.js(브라우저용 window.api) + fonts/
└─ client/   # 클라이언트 앱 (main.js, preload.js, ui/index.html·style.css·app.js + fonts/, icon)
```

- **화면 디자인: Google Material 3** (서버·클라이언트 모두) — 색은 CSS 변수(`--primary:#0b57d0`, `--primary-container:#d3e3fd`,
  `--secondary-container:#c2e7ff`, `--bg:#f8fafd`, `--surface-1:#f0f4f9` …)로만 쓰고 다크 모드는 `body.dark` 에서 변수만 바꾼다.
  알약 모양 버튼(filled/tonal/outlined/text), 둥근 판(16~28px), 세그먼트 버튼·필터 칩·스위치, Gmail 처럼 흰 판 콘텐츠·줄 단위 목록,
  아이콘은 **Material Symbols Outlined 글꼴을 프로그램에 포함**(`ui/fonts/material-symbols-outlined.woff2`, Apache-2.0) — 교내망은 인터넷이 없어도 보여야 함.
  `<span class="msi">아이콘이름</span>` (ligature). 글꼴 순서 `"Google Sans", Roboto, "Segoe UI", "Malgun Gothic"`

- 버전: **0.2.0** (양쪽 동일). 설치파일명: `SchoolMessenger-Server-Setup-{버전}.exe`, `SchoolMessenger-Client-Setup-{버전}.exe`,
  리눅스 `SchoolMessenger-Server-Linux-{버전}.tar.gz` (자동 업데이트가 이 이름 규칙으로 GitHub 릴리스 자산을 찾으므로 바꾸지 말 것)
- 클라이언트 제품 표시 이름(productName)은 **"학교메신저"**(한글), 실행파일명(executableName)은 `SchoolMessenger`로 분리
  (Windows 알림 상단에 한글 이름이 나오게 `app.setAppUserModelId(appId)` 설정)
- 클라이언트 아이콘: 파란 그라데이션 둥근 사각형에 흰색 **"sm"** 텍스트. 서버 아이콘: 초록 배경 "서버" 텍스트
- 저작권 표기: **ⓒ jiseok. All rights reserved.** (정보 모달, 로그인 화면 하단)

## 3. 서버 코어 (server.js)

### 저장소
- 데이터 폴더(`userData/serverdata/`)에 `data.json`(쪽지·채팅을 뺀 DB: 계정·공지·채팅방·설정…, `storeVersion: 2`),
  **날짜별 파일** `messages/YYYY-MM-DD.json`·`roommsgs/YYYY-MM-DD.json`(그날 `time` 의 쪽지·채팅 배열, 서버 PC 현지 날짜),
  `uploads/`(첨부), `update/`(클라이언트 업데이트 파일), `activity.log`(활동 로그). 비밀번호는 `sha256(salt + ':' + pw)` 해시
- **저장 성능이 핵심** (메모리 4GB 서버에서 실제로 문제가 됨): 예전처럼 전체 DB 를 한 파일로 `JSON.stringify(…, null, 1)` + `writeFileSync` + `fsync` + `.bak` 복사를
  매번 동기로 하면, 한 학기 분량(쪽지 4만·채팅 2만, 약 67MB)에서 저장 한 번에 이벤트 루프가 **약 2초** 멈춰 채팅·로그인이 끊긴다. 그래서
  - `_saveSoon(...what)`: 인자 없음 = data.json, 쪽지/채팅 객체 = 그 날짜 파일(roomId 가 있으면 채팅), `'all'` = 전부 다시 확인. 300ms 모아서 저장.
    쪽지·채팅을 바꾸는 곳(보내기·읽음·삭제·회수·채팅·수정·설문 투표/마감·채팅방 안내·방 삭제)은 반드시 그 객체를 넘긴다. 보관 기간 정리는 `'all'`
  - 비동기 저장(`_saveAsync`, 한 번에 하나): 바뀐 날짜만 묶어 압축 JSON 으로 만들고, 마지막으로 쓴 내용의 SHA-1 과 같으면 건너뜀.
    파일마다 `fs.promises` 로 임시 파일(`.tmp-N`)에 쓰고 `sync` → (동기) 본 파일을 `.bak` 으로 rename → 임시 파일을 본 파일로 rename. 파일 하나마다 `setImmediate` 로 양보.
    비게 된 날짜는 파일 삭제. data.json 은 마지막에
  - `saveNow()`(종료·백업·복원 직전, 동기): 전부 확인해 바뀐 파일만 씀. `_saveGen` 을 올려 진행 중인 비동기 저장은 rename 하지 않고 버리게 한다(옛 내용으로 덮어쓰기 방지)
  - `stop()`: 저장 예약 금지(`_stopped`) → 진행 중 비동기 저장을 기다림 → `saveNow()`. 10분마다 `'all'` 확인(빠뜨린 표시 대비, 바뀐 파일만 씀)
  - 불러오기: 각 날짜 파일(안 되면 `.bak`, 손상 파일은 `.corrupt-시각` 으로 보관하고 관리자 안내), 남은 `.tmp-*` 삭제.
    data.json 에 `messages`/`roomMsgs` 배열이 있으면(1.0.0 이하 형식, 또는 이전 버전으로 되돌렸다가 쓴 경우) 같은 id 는 날짜 파일 쪽을 쓰고 나머지를 합친 뒤
    그 날짜들을 저장 대상으로 표시 → 백그라운드로 옮김. 처음 옮길 때 원본을 `data.json.before-1.0.1` 로 복사해 둔다
  - 백업은 data.json + 날짜별 폴더(본 파일만) + uploads, 복원은 지금 날짜별 폴더를 지운 뒤 복사(섞임 방지)
- 활동 로그는 `appendFileSync` 대신 `fs.promises.appendFile` 로 백그라운드 이어 쓰기(쓰는 동안 생긴 줄은 모아서 한 번에, 순서 유지).
  파일을 계속 열어 두면 메모장·.NET 등이 '다른 프로세스가 사용 중'으로 못 여니 쓰기마다 닫는다. 첨부 업로드(`/upload`)는 메모리에 모으지 않고
  `req.pipe(createWriteStream('<id>.part'))` → 다 받으면 rename (Content-Length 나 받은 양이 200MB 를 넘으면 413). 용량 집계 `getStorage()` 는 비동기
- 서버 관리 앱(Electron): 빌드 폴더(`win-unpacked`)에서 켠 것은 시작 프로그램에 등록하지 않음. 설치된 서버는 시작 때 레지스트리 Run 의
  `electron.app.<exe 이름>` 값을 읽어(Electron launchItems 는 경로가 다른 항목을 안 보여 줌, app.getName() 은 package.json name 이라 다름)
  빌드 폴더이거나 없어진 경로를 가리키면 `setLoginItemSettings({ openAtLogin: true, name })` 로 바로잡는다.
  서버 관리 앱(Electron): `app.disableHardwareAcceleration()`, 창을 닫으면 숨기지 않고 없앰(렌더러 메모리 반환, 트레이·두 번째 실행으로 다시 만듦),
  관리 화면의 주기적 새로고침은 `document.hidden` 이면 건너뛰고 다시 보일 때 한 번에 새로고침

### 데이터 모델 (data.json)
```
users:   { id, name, dept(대표 부서), depts[](다중 소속), position, office, subject, phone, mobile, email,
           admin(bool), salt, pw(hash), avatar? }
avatar:  { shape: circle|rounded|square|hexagon|flower, color: '#rrggbb'|'', kind: initial|text|icon, value }
         — 없으면(null) 원 + 아이디로 정한 색 + 이름 첫 글자. 서버 `cleanAvatar` 가 검사(모르는 모양→circle, 색 형식 아니면 '',
           text 는 Intl.Segmenter 로 2글자(이모지 1글자 취급), icon 은 [a-z0-9_]{1,40}, 기본과 같으면 null 저장)
messages:{ id, from, to[], text, attachments[{name,size,url}], time, readBy[], deletedBy[], scheduled? }
notices: { id, authorId, authorName, title, body, time, poll? }
poll:    { q, options[], deadline, multi(복수선택), anon(투표자 미공개), votes{ userId: [optIdx,...] } }
         — 예전 형식(votes{userId:optIdx})은 불러올 때 배열로 자동 변환
rooms:   { id, name, creator, members[], time } / roomMsgs: { id, roomId, from, text, attachments, time, system?, poll?, edited?, recalled? }
scheduled:        예약 쪽지 { id, from, to[], text, attachments, sendAt, created }
scheduledNotices: 예약 공지 { id, authorId, authorName, title, body, poll, publishAt }
userGroups: 개인 사용자 그룹 { id, owner, name, members[] }
signups:  회원가입 요청 { reqId, id, salt, pw(hash), name, dept, position, subject, phone, mobile, email, time }
settings: { retentionDays, deptOrder[], userOrder{dept:[ids]}, extraDepts[](빈 부서) }
```
- 기본 관리자 계정: `admin / admin1234` (id가 정확히 'admin'인 계정만 `system:true`로 표시해 클라이언트에서 숨김)
- 아이디 규칙: 한글/영문/숫자/`_.-` 2~30자. 부서는 쉼표/세미콜론으로 여러 개 입력 → `depts[]` 배열 (첫 번째가 대표 `dept`)

### HTTP
- 포트 기본 7777 (0.0.0.0), **CORS 전체 허용 필수** (클라이언트가 file:// 페이지라 없으면 업로드 실패)
- `GET /health`(→ `{ ok, name, version }`), `POST /upload?token=&name=`(raw body, 200MB 제한, 로그인 토큰 검증),
  `GET /files/:fid/:name`(Content-Disposition attachment), `GET /client-update`(등록된 클라이언트 설치파일 다운로드)
- `server.httpHooks` 배열의 함수(`(app) => {}`)를 start() 때 붙인다 — 리눅스 웹 관리 화면(`/admin`)이 여기에 붙음
- 사용자 세부 정보 필드: `office`(50) `subject`(50) `phone`(30) `mobile`(30) `email`(60) — `addUser/updateUser` 가 받으며 넘어온 항목만 바꿈
  (`updateUser(id, { name, dept, position, admin, ...details })`). `bulkAdd` 줄 형식:
  `아이디,이름,부서,직위[,비밀번호,담당과목,사무실위치,사무실전화,핸드폰,이메일]`
- 사용자 그룹 순서: `reorder_groups { ids }` → 내 그룹만 그 순서로(목록에 없는 건 뒤, 남의 그룹 자리는 그대로) → `groups_reordered { ids }`.
  로그인 때 `groups` 는 저장 순서대로 보냄
- `login_ok` 에 `updateRepo`(서버가 아는 **공개** GitHub 저장소, 토큰을 쓰는 비공개면 빈 값) — 클라이언트가 직접 GitHub 확인할 때 사용

### WebSocket(/ws) 프로토콜 — JSON 메시지
- 로그인 전 허용: `login{id,pw}`, `signup_request{...}`
- `login_ok` 응답에 포함: token, schoolName, clientUpdate(버전), user, users[], messages(내 것 최근 500, deletedBy 제외),
  notices(최근 100), rooms+roomMsgs(방별 최근 100), scheduled(내 예약쪽지), groups(내 그룹),
  scheduledNotices(내 예약공지), deptOrder, userOrder, extraDepts, signups(관리자만 — 승인 대기 목록)
- 중복 로그인 시 기존 세션에 `kicked` 보내고 종료
- 쪽지: `send_message{to[],text,attachments,sendAt?}` (sendAt이 미래면 예약 → `scheduled_added`),
  `read`→`read_receipt`, `recall_message`(안 읽은 것만, 전체 삭제), `delete_message`(내 보관함만; 전원이 삭제하면 완전 제거),
  `cancel_scheduled`
- 상태: `set_status(online/away/class/meeting)` → presence 브로드캐스트(online, status)
- 채팅방: `create_room`, `room_message`, `add_room_members`, `leave_room` (+입장/퇴장 시스템 메시지),
  `room_poll{roomId, poll{q,options,deadline,multi,anon}}` → 방 참여자에게만 설문 메시지 전송(일부 인원 대상 설문),
  `vote_room_poll{roomId,msgId,options[]}` → `room_message_updated`(참여자에게만)
- 채팅방 글 수정·회수 (쓴 사람 본인만, 시스템 안내·이미 회수된 글 제외, 남의 글이면 error "내가 쓴 글만 수정하거나 회수할 수 있습니다."):
  `edit_room_message{roomId,msgId,text}` → 글자만 바꾸고 `edited=시각` (설문은 거부, 첨부가 없으면 빈 글 거부),
  `recall_room_message{roomId,msgId}` → `text='회수된 메시지입니다.'`(예전 클라이언트 호환), attachments=[], poll·edited 삭제, `recalled=시각`.
  둘 다 `room_message_updated` 로 방 참여자 모두에게 보내고 활동 로그에 남김
- 내 정보: `update_profile{dept?, office, subject, phone, mobile, email, avatar?}` — avatar 가 없으면(예전 클라이언트) 아이콘은 그대로 둠.
  `_publicUser` 에 `avatar` 포함 → `users` 브로드캐스트로 모두의 조직도에 반영
- 공지: `post_notice{title,body,poll?{options,deadline,multi,anon},publishAt?}`(누구나),
  `vote_poll{noticeId, options[]}`(마감 전 변경 가능, 빈 배열이면 투표 취소, `notice_updated`), `delete_notice`, `cancel_scheduled_notice`
- **설문 전송 규칙**: 서버는 저장된 votes를 그대로 보내지 않고 보는 사람별로 가공해서 보냄 —
  `{q, options, deadline, multi, anon, closed, total, mine[], counts[], voters[][]}`.
  **마감 전(`now < deadline`)에는 `counts`·`voters`를 아예 보내지 않음** → 결과는 마감 후에만 공개(진행 중엔 참여 인원 `total`과 내 선택 `mine`만).
  `anon:true`면 마감 후에도 `voters`와 원본 votes를 **아예 보내지 않음**(개발자 도구로도 볼 수 없게). 공개 설문은 항목별 투표자 id 배열 포함.
  그래서 공지/채팅방 설문 브로드캐스트는 사용자별 개별 전송(`_broadcastNotice`, `_sendRoomMsg`)
- **설문 마감·결과 공개**: 10초 주기 타이머(`_deliverDue` → `_announceClosedPolls`)가 마감 시각이 지난 설문을 찾아
  `notice_updated` / `room_message_updated` 로 결과를 **한 번만** 다시 보낸다(`poll.resultSent` 표시, 불러올 때 이미 마감된 설문은 보낸 것으로 간주,
  공지 수정으로 마감을 미루면 `resultSent=false` 로 되돌려 결과를 다시 가림).
  `close_poll{noticeId}` / `close_poll{roomId,msgId}` = 지금 마감(deadline=now). 공지 설문은 작성자·관리자, 채팅방 설문은 만든 사람·관리자(방 참여자)만.
  마감 판정은 `now >= deadline` 으로 통일(지금 마감 직후 같은 밀리초에도 마감으로 보이도록)
- **설문 결과 엑셀**: HTTP `GET /poll-export?token=&noticeId=` 또는 `?token=&roomId=&msgId=` → `.xlsx`(서버의 SheetJS `xlsx` 사용).
  마감 전 403("설문이 끝난 뒤에…"), 토큰 없음 401, 채팅방 설문은 방 참여자만(아니면 403), 없으면 404.
  `Content-Disposition: attachment; filename*=UTF-8''설문결과_{제목}_{YYYY-MM-DD}.xlsx` + `Access-Control-Expose-Headers: Content-Disposition`
  (file:// 렌더러가 파일 이름을 읽어야 하므로). 시트: **결과**(설문·구분·만든 사람·마감·선택 방식·투표자 공개 여부·참여 N명/대상 M명·
  항목별 표 수·비율(참여 인원 기준, 소수 1자리)·공개 설문은 투표한 사람, 복수 선택이면 "비율 합이 100%를 넘을 수 있음" 안내),
  공개 설문만 **응답자별**(이름·아이디·부서·직위·선택한 항목)·**미참여**(대상 중 투표 안 한 사람; 공지 설문 대상=시스템 계정 제외 전체,
  채팅방 설문 대상=방 참여자). 익명 설문은 결과 시트만(미참여 명단도 넣지 않음 — 참여자를 역으로 알 수 있으므로). 활동 로그에 기록
- 그룹: `save_group{id?,name,members}`, `delete_group` (소유자만)
- 프로필: `update_profile{office,subject,phone,mobile,email}`, `change_pw{oldPw,newPw}`
- 관리자 전용: `admin_add_user/admin_update_user/admin_delete_user`(→`admin_result`),
  `set_dept_order`, `set_user_order{dept,order}`, `rename_dept{from[],to}`(여러 부서 병합 가능, deptOrder/userOrder/extraDepts 동기화),
  `add_dept`/`delete_dept`(빈 부서, extraDepts)
- 회원가입: `signup_request` 필수 항목 = 아이디/비밀번호/이름/부서/직위/사무실전화 (과목·핸드폰·이메일 선택).
  접수 시 **접속 중인 관리자 권한 사용자 전원에게 `signup_alert` + `signups{list}`** 전송.
  관리자는 메신저에서 바로 처리: `list_signups` → `signups{list}`, `approve_signup{reqId}` / `reject_signup{reqId}` → `signup_handled{ok,action,name,id}`
  (관리자 권한 검사 필수). 서버 관리 화면에서 처리해도 접속 중인 관리자에게 `signups`를 다시 보내 목록이 즉시 갱신됨.
  승인 시 요청 때 해시된 비밀번호 그대로 계정 생성
- 타이머(10초): 예약 쪽지 발송, 예약 공지 게시 (서버 재시작 시 밀린 것 즉시 처리). 6시간마다 보관함 자동 정리

### 활동 로그
- `log(text)` → 메모리 최근 1000건 + `activity.log` 파일 append (`[YYYY-MM-DD HH:MM:SS] 내용`)
- 기록: 서버 시작, 로그인/실패/접속종료, 쪽지 발송(받는 사람·첨부 수), 예약 등록, 파일 업로드, 공지 등록,
  계정 추가/수정/삭제, 부서 추가/삭제/이름변경/순서변경, 회원가입 요청/승인/거절, 보관함 정리

## 4. 서버 관리 앱 (Electron)

- 트레이 상주: 창을 닫아도 서버 유지, 트레이 메뉴(관리 화면 열기/서버 종료)
- 첫 실행 시 **학교 이름** 입력 모달 → 제목표시줄 "○○학교 메신저 서버" + 클라이언트에도 전달
- **왼쪽 메뉴 트리**(고정 내비게이션, Material 내비게이션 드로어 — 알약 모양 선택 표시): 서버 상태 / 사용자 관리 / 회원가입 요청(대기 수 배지) / 부서 표시 순서 / 데이터 관리 / 활동 로그 / 프로그램 업데이트(받아 둔 업데이트가 있으면 빨간 점) — 클릭 시 해당 카드로 부드럽게 스크롤, 스크롤하면 보고 있는 카드의 메뉴가 강조됨
- 카드 구성:
  1. **서버 상태**: 접속 주소(LAN IP:포트), 포트 변경, 등록/접속 사용자 수, 학교 이름, Windows 시작 시 자동 실행 체크
  2. **사용자 관리**: **[계정 추가] / 줄의 ✏(연필, 또는 줄 두 번 클릭)** → 같은 모달(2열): 아이디*(수정 때는 읽기 전용)·초기/새 비밀번호·이름*·부서(datalist)·직위·
     **담당 과목·사무실 위치·사무실 전화·핸드폰·이메일**(전화는 치는 동안 자동 하이픈)·관리자 권한 스위치(기본 admin 계정은 끌 수 없음).
     표 열: 상태·아이디·이름·부서·직위·담당 과목·사무실 전화·권한(칩)·[✏][🗑], 검색은 세부 정보까지.
     (예전 추가 폼 순서: 아이디→비밀번호→이름→부서→직위 + 관리자 체크)
     `아이디,이름,부서,직위,비밀번호` 일괄 등록, **엑셀(xlsx 첫 시트)/CSV 가져오기**(CP949 자동 감지, 머리글 무시, 부서 다중은 `;`),
     **엑셀용 CSV 내보내기**(UTF-8 BOM, 머리글 `아이디,이름,부서,직위,비밀번호,담당과목,사무실위치,사무실전화,핸드폰,이메일`, 비밀번호 칸은 비움, admin 제외), 삭제
     ※ Electron은 `window.prompt()` 미지원 — 반드시 자체 모달 사용
  3. **회원가입 요청**: 요청자 정보 + 승인/거절 버튼, 5초 자동 갱신
  4. **부서 표시 순서**: 끌어 놓기 또는 ↑↓ 버튼으로 순서 지정 → 모든 클라이언트 실시간 반영.
     사용자들의 담당 과목에서 **`교과-{과목}`(과목 자동) 줄도 함께 보여 순서를 정할 수 있게** 한다(초록 [과목 자동] 표시, 순서 없는 교과는 맨 뒤)
  5. **데이터 관리**: 쪽지/채팅/첨부 용량 현황, 보관 기간(일, 0=무제한) 설정, "지금 정리"(기간 경과 데이터 + 참조 없는 첨부파일 삭제, 업로드 1시간 유예)
  6. **활동 로그**: 콘솔 스타일 최근 300건, 새로고침, 로그 파일 열기
  7. **프로그램 업데이트 (GitHub)**: 서버 현재/GitHub 최신/클라이언트 배포 버전/마지막 확인 타일, [지금 확인], 진행률 막대,
     받아 둔 서버 업데이트가 있으면 노란 줄 + [서버 업데이트 설치](확인창), 스위치 [GitHub 자동 업데이트](기본 켬)·[서버 자동 설치](기본 켬),
     저장소(`소유자/이름`, GitHub 주소를 넣어도 정리) + 토큰(비공개 저장소용, 화면에는 '저장됨'만 표시·[토큰 지우기]),
     맨 아래 **클라이언트 설치파일 직접 등록**(인터넷이 막힌 학교용, 파일명에서 버전 추출)
     - `UpdateManager`(update-manager.js, 윈도우·리눅스 공용): 시작 20초 뒤 + 6시간마다 `GET /repos/{repo}/releases/latest` →
       클라이언트 자산이 등록본보다 새로우면 `updateDir/client-setup-X.exe.download` 로 받아 `server.adoptClientUpdate()` 로 바로 배포,
       서버 자산(윈도우 `serverWin` / 리눅스 `serverLinux`)이 지금보다 새로우면 받아 두고 `pending`. 1분마다 **접속자 0명 + 자동 설치 켬**이면 설치.
       윈도우 설치 = NSIS `/S --updated --force-run` 분리 실행 후 서버 종료(설치 후 다시 실행), 개발 실행(`!app.isPackaged`)에서는 거부.
     - `GithubUpdater`(updater.js): 비공개 저장소는 `Authorization: Bearer 토큰` + 자산 API 주소(`Accept: application/octet-stream`, `redirect:'manual'`)
       → 넘겨 준 실제 파일 주소에는 **토큰을 보내지 않음**. 받는 중 1분 멈추면 중단, `.part` 로 받고 크기·`digest`(sha256) 검증 뒤 이름 바꿈.
       오류 문구: 연결 불가(교내망 차단)·404(비공개면 토큰 안내)·401(토큰 만료)·403/429(요청 한도)
     - 토큰은 settings.json 에만, `get-settings` 등 화면으로는 보내지 않음. 토큰이 없으면 `server.updateRepoPublic = repo`
- 헤더에 ℹ 정보 버튼(버전 + ⓒ jiseok), [서버 상태]에 서버 버전 타일

## 4-2. 리눅스 서버 (headless.js + 웹 관리 화면)

- `node headless.js [--home 폴더] [--port] [--data-dir]` — 홈 기본값: root 면 `/var/lib/school-messenger-server`, 아니면 `~/.school-messenger-server`
  (`SM_HOME` 환경변수 우선). 홈에 `settings.json`(port·schoolName·dataDir·update, 권한 600)과 `serverdata/`, `backups/`, `update/`
- `web-admin.js`: `/admin/` 에 서버 관리 화면(ui/)을 그대로 제공. `/admin` → `/admin/` 로 넘김(라우터가 끝 `/` 를 구분하지 않으므로 originalUrl 로 판단).
  `POST /admin/api/login {id,pw}`(관리자 권한 계정만, IP 당 10회 실패 시 10분 차단, 타이밍 안전 비교) → 토큰(12시간),
  `POST /admin/api/call {fn,args}` + `X-Admin-Token` → window.api 와 같은 이름의 기능, `GET /admin/api/download/users.csv|activity.log`,
  `POST /admin/api/upload/users|client-update?name=`(raw)
- `ui/web-api.js`: `window.api` 가 없을 때만(=브라우저) 로그인 창(불투명 배경)을 띄우고 HTTP 로 연결. 파일 대화상자 기능은 브라우저식으로
  (내보내기·로그 = 내려받기, 가져오기·클라이언트 등록 = 파일 선택 후 올리기, 백업 = 서버 `backups/` 에 저장·복원은 번호로 고름,
  데이터 위치 변경 = settings.json 안내, 포트 변경 = 저장 후 재시작하고 새 주소로 이동), onStatus 등은 3~5초 폴링
- 화면 문구는 `getPlatform()==='linux'` 이면 '부팅 시 서버 자동 실행'(스위치 비활성)·'로그 파일 내려받기'로 바꿈, 웹이면 오른쪽 위 로그아웃 아이콘
- 리눅스 업데이트 설치: tar.gz 를 `update/unpack-*` 에 풀어 `package.json` 버전 확인 → 프로그램 폴더에 덮어쓰기 → 종료(0) → systemd `Restart=always` 가 다시 띄움
- `linux/install.sh`(sudo): Node 18+ 확인, 서비스 계정 `schoolmsg`, `/opt/school-messenger-server` 복사·소유권(자동 업데이트가 쓸 수 있게),
  systemd 서비스 `school-messenger-server`(Environment=SM_HOME, Restart=always) 등록·시작, ufw/firewalld 켜져 있으면 7777 허용, 접속 주소 안내.
  `uninstall.sh [--purge]`. `.gitattributes` 로 `*.sh` 는 LF 유지(빌드 스크립트도 CRLF→LF 변환)
- `scripts/build-linux.js`: 운영 파일 + ui/ + `npm ls --omit=dev --parseable` 의 라이브러리만 복사(모두 순수 JS) → 윈도우 기본 tar(`System32\tar.exe`)로
  `school-messenger-server/` 최상위 폴더의 tar.gz (Git 의 GNU tar 는 `C:` 를 원격 주소로 읽으므로 경로 지정)

## 5. 클라이언트 앱 (Electron)

### 로그인 화면
- 서버주소(IP:포트, 포트 생략 시 7777, 예시 placeholder `예: 10.112.120.40:7777`)/아이디/비밀번호 + 접속 정보 저장, 하단 ⓒ jiseok
- **서버 주소는 하나만**: `normServer()` 가 http:// 와 끝의 / 를 떼고 포트를 붙이며, 공백·쉼표·세미콜론이 있으면 거부("서버 주소는 하나만 입력하세요").
  저장도 하나(localStorage `savedServer`, 새 주소로 로그인하면 덮어씀). 계정은 `savedConns: [{id, pw(base64)}]` 여러 개를 **저장된 계정** 선택으로 고름(마지막 계정이 맨 위).
  0.9.x 의 계정별 `servers[]` 는 처음 실행 때 맨 앞 주소 하나만 `savedServer` 로 옮기고 지운다. 재접속은 같은 주소로만 4초 간격
- **회원가입 요청** 버튼 → 모달(아이디*/비밀번호*+확인/이름*/부서*(쉼표 다중)/직위*(예: 교사, 부장)/사무실전화*(예: 062-000-0000)/담당과목(선택)/핸드폰/이메일) → 임시 WebSocket으로 전송
- 연결 끊기면 "재접속 중" 배너 + 4초 간격 자동 재접속

### 메인 화면 구성
- 쪽지·공지·채팅방 목록 줄(`.msg-item`)은 `content-visibility: auto; contain-intrinsic-size: auto 56px` (마우스를 올리면 visible — 그림자 잘림 방지).
  쪽지 500개 목록의 배치 계산이 0.35초 → 0.01초로 줄어 로그인·탭 전환이 빨라진다
- 헤더: 학교 이름, 내 정보 요약, 상태 선택(🟢온라인/🟡자리비움/🔴수업중/🟠회의중), 설정/내 정보/정보/로그아웃(확인창)
- **왼쪽 사이드바** — [조직도 | 사용자 그룹] 탭:
  - 조직도: 검색, 전체 선택 바(N명 선택 시 ✉쪽지/👥그룹 만들기/✕해제), 부서 접기/펼치기,
    부서 체크박스(부서 전체 선택), 부서 ✉버튼(부서 전체 쪽지), 사용자 행(아바타 30px+**접속상태점 13px**(배경색 2.5px 테두리, 미접속은 회색+진한 테두리)+이름+직위+상태라벨, 체크박스).
    행에 마우스를 올리면 첫 줄에 `● 접속 중/자리비움/수업중/회의중/미접속`.
    `avatarHtml(id, name, size, av?)` — av 를 안 주면 `userById(id).avatar`. 모양은 `.av-{shape}` 클래스(rounded 30%, square 10%,
    hexagon·flower 는 `clip-path: polygon(...)` 퍼센트 좌표라 크기와 무관), 그림은 Material Symbols 글자(`--av-fs`), 글자 2자면 글씨를 작게
  - **접속 상태 필터**: 검색창 아래 `[전체 N] [● 접속 N] [● 미접속 N]` 세그먼트(인원 수는 시스템 계정 제외). 고르면 그 상태의 사람만 보이고
    (검색처럼 접힌 부서도 펼치고 빈 부서는 숨김), presence 가 바뀌면 바로 다시 그린다. 필터를 바꿀 때 화면에서 사라진 사람은
    선택(`treeSel`)에서도 빼서 안 보이는 사람에게 쪽지가 가지 않게 한다. "전체 선택"은 보이는 사람만 대상
  - **다중 부서**: 사용자는 여러 부서에 동시에 표시. **트리형 부서**: 이름에 `-`가 있으면 상위-하위로 표시(예: 교과-국어)
  - **교과 자동 조직**: 담당 과목 입력 시 "교과" 상위조직 밑에 "교과-{과목}"으로 자동 소속(파생 조직은 이름변경·사람 이동 불가).
    정렬은 `deptOrder` 에 있으면 그 자리, 없으면 일반 부서 뒤(10000) → 교과(20000) 순. **관리자는 교과 상위/하위 제목도 끌어 놓아 순서를 정할 수 있음**
    (`set_dept_order` 에 `교과-*` 이름도 포함해서 보냄)
  - 관리자: 부서/사용자 **드래그앤드롭**(부서 순서, 부서 내 사용자 순서, 다른 부서로 이동), 부서 우클릭 → **부서 관리 모달**(새 부서 추가, 여러 부서 선택해 이름 변경=병합, 빈 부서 삭제)
  - 우클릭 메뉴: 쪽지 보내기/대화하기/사용자 그룹에 추가▸(내 그룹 목록+새 그룹)/내 정보 수정(본인), 프로필 정보(🏢📚☎📱✉) 표시, 다중 선택 시 선택 전체에 적용
  - 사용자 그룹 탭: 내가 만든 그룹들(서버 저장), 구성원 개별 체크→선택 쪽지, 전체 쪽지, 채팅방 만들기, 수정/삭제.
    **순서 바꾸기**: 그룹 제목줄의 손잡이·↑↓ 버튼(맨 위/아래는 비활성), 그룹 카드를 다른 카드 위로 끌어 놓기(`G|id`) → 바로 다시 그리고 `reorder_groups`
  - 관리자는 하단 "⚙ 조직/사용자 관리" 버튼 → 계정 추가/수정/삭제 모달(검색 포함)
- **오른쪽 탭** (순서 중요): **📢공지사항(첫 탭, 로그인 시 기본)** / ✉받은쪽지 / 보낸쪽지 / 대화 / 채팅방 + "쪽지 보내기" 버튼
  - 목록 항목에 **[공지](주황)/[쪽지](파랑) 라벨** + 아바타 + 미리보기 + 안읽음 강조/배지
  - **안 읽은 쪽지**: 라벨이 빨간 **[NEW]**(깜빡임)로 바뀌고 행 배경(연한 빨강 그라데이션)·왼쪽 굵은 선(6px)·보낸 사람/시각 빨간 글씨로 강조.
    탭을 누르면 해당 목록을 다시 그리고 `scrollTop = 0`으로 맨 위(최신)부터 보이게 한다(쪽지 누락 방지).
    검색 중에는 목록 위에 "'검색어' 검색 중 — 전체 N건 중 M건 표시 [전체 보기]" 안내줄을 띄운다
  - **검색 범위**: 받은쪽지함은 보낸 사람 이름만, 보낸쪽지함은 받는 사람 이름만 검색(공통: 본문·첨부 이름).
    받은쪽지함에서 받는 사람까지 검색하면 함께 받은 사람 이름으로 엉뚱한 쪽지가 걸린다
  - **검색창 ✕ 버튼**: 조직도·받은쪽지·보낸쪽지·공지 검색창은 `.search-wrap` 으로 감싸고 입력이 있을 때만 ✕ 버튼 표시 → 누르면 지우고 `input` 이벤트를 다시 발생시켜 전체 목록 복귀
  - 쪽지: 다중 수신자(부서 단위 선택 가능), 첨부 여러 번 누적 추가+개별 삭제+드래그앤드롭, 예약 발송(취소 가능),
    읽음 확인(누가 읽었는지), 답장/전달(첨부 포함)/회수/삭제(내 보관함만), 검색
  - **회수**: 보낸 사람 본인이면 **상대가 이미 읽었어도 회수 가능**. 누를 때 이미 읽은 사람 이름을 보여 주고 확인받는다.
    서버는 보낸 사람에게 `recall_result{ok,messageId,readCount}`(본인 목록에서 제거 + 안내), 나머지 수신자에게는
    `message_recalled{messageId,from,wasRead}` 를 보낸다. 받는 쪽이 그 쪽지를 열어 보고 있었다면(`S.openMsgId`)
    쪽지 창을 닫고 "회수했습니다" 안내를 띄운다
  - **나에게 보내기**: 받는 사람 옆 [👤 나에게 보내기] 토글 버튼(켜지면 primary + "나 (이름)" 초록 칩).
    받는사람 선택기도 나 자신을 포함(`buildPicker(..., allowSelf)`). 서버는 `to`에 보낸 사람이 있으면 `readBy`에 미리 넣어
    안 읽음으로 쌓이지 않게 하고, `new_message`는 자기 자신에게 보내지 않는다(중복 방지).
    받은쪽지함 필터는 `m.to.includes(나)` 로 자기 쪽지도 포함하고, 보낸사람=받는사람이면 [메모] 라벨·"나에게" 로 표시
  - 쪽지 작성 창 커서: 받는 사람이 비어 있으면 받는 사람 검색창, 이미 정해져 있으면(우클릭 쪽지·답장·전달) **본문 맨 앞**에 커서를 둔다
    (받는사람 검색창의 자동 포커스가 50ms 뒤에 실행되므로 본문 포커스는 그보다 늦게 건다)
  - 본문에 넣은 그림(붙여넣기·드롭)은 첨부 목록에서 썸네일 대신 "본문에 삽입됨"으로만 표시 — 본문에 이미 보이므로 두 번 보여 주지 않는다.
    📎로 직접 고른 그림 첨부는 지금처럼 썸네일을 보여 준다
  - 대화/채팅방 공통 첨부: 📎 버튼, **드래그앤드롭**, **그림 붙여넣기(Ctrl+V)** 로 입력창 위 "첨부 N개" 줄에 쌓아 두고 [전송]으로 함께 발송(그림은 작은 썸네일 표시), 칩의 ✕로 개별 취소,
    상대/방을 바꾸면 대기 첨부는 비움. (드롭 중에는 브라우저가 `confirm()`을 무시하므로 확인창을 쓰면 안 됨 — 바로 첨부한다)
  - 채팅방: 그룹 채팅, 초대/나가기, 안읽음 수, 시스템 메시지, **📊 설문 버튼**(방 참여자만 대상, 대화 흐름에 설문 카드로 표시)
  - **채팅방 글 수정·회수**: 내 글 왼쪽에 마우스를 올리면 `.b-acts`([연필 수정] [되돌리기 회수], 내 설문은 회수만).
    수정은 그 자리의 입력 상자(`S.roomEdit = {id, roomId, draft}`) — Enter 저장(IME 조합 중 제외)·Shift+Enter 줄바꿈·Esc 취소, 새 글이 와서 다시 그려도
    draft 와 포커스 유지, 빈 입력칸에서 ↑ = 마지막 내 글 수정, 방을 바꾸면 수정 취소. 수정된 글은 시간 옆 `수정됨`(마우스 올리면 수정 시각).
    회수는 확인창 후 전송, 회수된 글은 `.recalled`(점선 느낌 테두리·기울임 "회수된 메시지입니다")로 모두에게 표시하고 버튼 없음.
    `room_message_updated` 를 받으면 보고 있는 방은 다시 그리고 아니면 방 목록 미리보기만 갱신
  - 공지: 누구나 작성(설문조사: 항목+마감시각+선택방식+공개여부, 실시간 막대그래프 결과, 마감 후 투표 불가 / 예약 공지: 시각 지정, 목록 상단에 취소 가능 표시)
  - 설문 카드(공지·채팅방 공용): 제목 옆에 `여러 개 선택/하나만 선택`·`투표자 공개/익명 투표`(마감되면 `마감`) 라벨,
    복수 선택이면 체크박스·아니면 라디오.
    **진행 중**: 항목만 고를 수 있고 결과 자리에 노란 안내 "🔒 결과는 설문이 끝나면 공개됩니다 (마감: …)", 참여 인원 표시,
    투표하기/투표 변경/투표 취소 + (만든 사람·관리자) `⏹ 지금 마감`(확인창). 보고 있는 동안 마감 시각이 지나면 "결과 집계 중"으로 바뀌고 서버가 곧 결과를 보냄.
    **마감 후**: 항목별 막대그래프+표수+비율(가장 많이 받은 항목 강조), 공개 설문은 항목 아래 투표자 이름(없으면 "없음").
    막대(`.poll-bar`)는 span 이므로 `display:block` 이어야 width 가 적용된다(빠뜨리면 막대가 안 보임).
    선택 방식·공개 여부는 만들 때만 정할 수 있고 이후 수정 불가.
    **마감 후 `📥 결과 엑셀로 저장`**: 렌더러가 `/poll-export` 를 fetch → `res.ok` 아니면 서버 문구로 알림 → 파일 이름을 Content-Disposition 에서 읽고
    바이트를 IPC `save-file(name, Uint8Array)` 로 메인에 넘겨 첨부 저장 폴더에 저장(같은 이름이면 숫자, .xlsx 만 허용, 50MB 제한).
    저장 후 버튼은 `📂 저장한 엑셀 열기`, 아래에 "✅ 저장했습니다: 경로 [폴더 열기]"
  - **쪽지·공지 창 (여러 개 동시에)**: 받은쪽지·보낸쪽지·**공지사항**은 모달 하나가 아니라 항목마다 떠 있는 창(`.msg-win`)을 만든다
    (`#msgWinLayer` = `position:fixed; inset:0; pointer-events:none; z-index:30`, 창만 `pointer-events:auto`). 예전 `#detailModal` 은 없앴다.
    `S.msgWins: Map<창 키 → {key, el, refresh}>` — 키는 쪽지 id, 공지는 `'notice:' + 공지 id`(쪽지 id 와 겹치지 않게).
    공통 함수: `createMsgWin(key, cls)`(제목줄·본문·버튼 틀 + 닫기/접기/앞으로/끌기 연결) → 내용 채우기 → `showMsgWin(key, el, refresh)`,
    `raiseMsgWin(key)`(이미 열려 있으면 펴고 앞으로 + 깜빡임), `closeMsgWin(key)`, `closeAllMsgWins()`, `addWinBtn()`.
    겹침 순서: 쪽지 쓰기 모달 10 < 창 층 30 < 다른 모달 40(그룹 만들기·공지 수정 등) < 우클릭 메뉴 50 < 다운로드 패널 60(창·모달이 있으면 왼쪽 아래).
    창 종류별 제목줄 색: 받은 쪽지 파랑, 보낸 쪽지(`mw-sent`) 초록, 공지(`mw-notice`) 주황.
    쪽지 창: 제목줄(종류 아이콘·보낸/받는 사람·시각·[—] 접기·[✕]) + 본문(메타·내용·첨부) + 버튼(대화·그룹 만들기·인쇄·삭제·회수(보낸쪽지)·전달·답장(받은쪽지)·닫기).
    공지 창: "📢 공지 — 제목", 작성자·시각(수정됨), 본문(링크화)·첨부·설문(`renderPoll` — 투표·지금 마감·결과 엑셀 저장 `noticeId=`),
    버튼 인쇄·(작성자/관리자) ✏ 수정(공지 수정 모달이 창 위에 뜸)·공지 삭제·닫기. `notice_updated` 가 오면 열린 창의 `refresh(notice)` 로 제자리 갱신,
    `notice_deleted` 면 그 창을 닫는다.
    제목줄 끌어 옮기기(화면 밖으로 사라지지 않게 제한), 두 번 클릭/[—] 접기, CSS `resize: both` 로 크기 조절, 누르면 맨 앞(`S.winZ`).
    **크기**: 쪽지 쓰기 창만큼 크게 — 너비 = clamp(360, 화면너비−60, 1100), 높이 = clamp(240, 화면높이−top−20, 720), 본문 최소 높이 180px.
    새 창은 화면 가운데 기준 왼쪽 위에서 시작해 30px씩 오른쪽·아래로 비켜 쌓는다(열린 창 수 % 6, 화면 안으로 제한).
    답장·전달·대화·그룹 만들기는 창을 닫지 않는다(보면서 쓰기).
    쪽지 쓰기 모달이 열려 있고 창이 1개 이상이면 `body.compose-split` → 쓰기 창은 왼쪽에 너비 `--cw` = clamp(480, 화면너비×0.52, 940),
    모든 창은 오른쪽(`right:12px`)에 너비 `--sw` = max(320, 화면너비 − cw − 44) 로 CSS `!important` 로 붙여 서로 겹치지 않게 하고(창 크기·위치는 건드리지 않음),
    쓰기 창을 닫으면 원래 자리·크기로 돌아온다(모달 열림/닫힘은 MutationObserver, 화면 크기 변경은 resize 로 다시 계산).
    쓰는 중에 창의 [답장]/[전달] 을 누르면 쓰던 내용이 있을 때 확인을 받는다.
    읽음 수신 시 열린 보낸쪽지 창의 "읽은 사람" 갱신, 회수·삭제 시 해당 창 닫기(남이 회수하면 안내), Esc = 맨 앞 창 닫기(모달이 없을 때),
    창 2개 이상이면 아래 가운데 "📨 열린 창 N개 [접기] [모두 닫기]", 로그아웃하면 모두 닫기.
  - **설문이 마감된 공지 수정**: 공지 수정 창을 열 때 원래 마감 시각 값을 기억해 두고(`S.editPollDeadlineOrig`), 마감 시각을 바꾸지 않았으면
    "최소 1분 이후" 검사를 건너뛴다(이미 마감된 설문이 있는 공지도 본문을 고칠 수 있어야 함, 마감 상태는 그대로)
  - **쪽지 → 사용자 그룹**: 쪽지를 주고받은 사람(보낸 사람+받는 사람, 나 제외)이 2명 이상이면 쪽지 창에 `👥 N명으로 그룹 만들기`, 목록 행에 `👥`.
    그룹 만들기 창을 그 사람들(칩)과 이름(3명 이하면 이름 나열, 넘으면 "A, B 외 N명", 선택된 상태)으로 미리 채워 연다.
    같은 구성원의 그룹이 이미 있으면 "그래도 새로 만들까요?"(취소=사용자 그룹 탭 보여 주기). 저장되면 왼쪽 [사용자 그룹] 탭으로 바꾸고 새 그룹을 잠시 강조.
    1:1 쪽지는 `💬 대화` 버튼으로 충분하므로 그룹 버튼을 띄우지 않는다
  - 왼쪽 [사용자 그룹] 탭에서는 조직도용 검색창(`.search-wrap`)·접속 필터·전체 선택 바를 함께 숨긴다
- 본문 URL 자동 링크화(기본 브라우저로 열기, `/files/` 다운로드는 예외 처리)
- 알림: 데스크톱 알림+작업표시줄 깜빡임+알림음(끄기 가능), 클릭 시 창 복원.
  관리자에게 회원가입 알림 → 알림을 누르면 승인 창이 열림. 헤더에 **[🔔 가입요청]** 버튼(대기 건수 배지)과 승인/거절 모달(요청자 정보 표시)
- 다운로드: 저장 대화상자 없이 다운로드 폴더에 저장, **같은 이름이면 `이름 (1).ext` 자동 번호**, 우하단 **진행률 패널**(%, 용량, 완료 시 "폴더에서 보기")
- **첨부파일 줄의 [📂 열기] [📁 폴더] 버튼**: 쪽지 창(모달)을 열어 둔 채로 첨부를 실행하거나 저장 폴더를 연다.
  메인에 `save-attachment(url)`(invoke) 를 두고 `downloadURL` → `will-download` 의 `done`에서 저장 경로로 resolve 한다
  (주소→대기 요청 Map 사용). 받은 경로는 렌더러가 `S.savedAtt[url]` 로 기억해 두 번째부터는 다시 받지 않고 바로 열고,
  `file-exists(path)` 로 파일이 지워졌는지 확인해 없으면 다시 받는다. 진행률 패널의 `download-progress` 에도 `url`을 실어
  링크로 받은 파일의 경로까지 기억한다.
  진행률 패널은 평소 우하단(z-index 9, 모달 아래)이지만 모달이 열리면 `body.modal-open` 이 붙어 좌하단·모달 위로 옮겨져
  쪽지 창 버튼을 가리지 않으면서 진행 상황이 보인다 (모달 `.modal-bg` 의 style 변화를 MutationObserver 로 감지)
- 이미지 첨부는 대화/쪽지에서 미리보기
- **전화번호 자동 하이픈 (치는 동안)**: `fmtPhoneNumber` — 0 으로 시작하면 지역번호 자릿수(02=2, 0505 등=4, 나머지 3) 뒤에 가운데 3자리(다 차면 4자리)·끝 4자리로
  나눠 바로 `-` 를 넣고, 15~19 로 시작하면 1588-1234. 0/15~19 로 시작하지 않는 숫자(교내 내선)·문구가 섞인 값·자릿수가 넘치면 그대로.
  `input` 때마다 정리하고 커서는 "같은 숫자 개수 뒤"로 되돌리며, 하이픈 바로 뒤에서 ← 지우기(`beforeinput`)는 하이픈 앞 숫자를 지운다.
  내 정보·회원가입 요청·서버 계정 수정 창 모두 같은 규칙
- 설정: Windows 시작 시 자동 실행, 알림음, 다크 모드(전체 화면 대응, localStorage 저장)
- 내 정보 수정(넓은 모달, 2열 입력): **조직도 아이콘 꾸미기**(왼쪽 64px 미리보기+내 상태 점+[기본으로], 모양 5개 버튼은 지금 고른 색·글자로 그린 미리보기,
  색 `자동`+16색, 안에 넣기 [이름 첫 글자|글자 직접 입력(2글자 제한)|그림(28개 격자)]) + 부서/사무실 위치/담당 과목/사무실 전화/핸드폰/이메일 + 비밀번호 변경(같은 모달)
- 트레이 상주(닫아도 알림 수신), 자동 업데이트(로그인 시 서버 등록 버전과 비교 → 묻지 않고 백그라운드 다운로드(진행률은 오른쪽 아래 패널) → 헤더 아래 전체 너비 노란 배너 "새 버전 vX이(가) 준비되었습니다 [지금 재시작하여 업데이트] [나중에]" → 버튼 클릭 시 NSIS 설치파일을 `/S --updated --force-run`으로 분리 실행하고 앱 종료 → 무음 설치 후 새 버전 자동 실행. 배너를 닫고 그냥 종료하면 `before-quit`에서 `/S --updated`로 무음 설치만 하여 다음 실행 때 새 버전 적용. 같은 버전 중복 다운로드 방지, 다운로드 실패 시 다음 로그인 때 재시도)

### Electron 함정 (반드시 처리)
1. `window.prompt()` 미지원 → 자체 모달
2. `alert()/confirm()` 후 입력창 포커스 깨짐 → 호출 후 IPC로 `win.blur(); win.focus()` 재설정 (양쪽 앱 모두)
2-1. 기본 우클릭 메뉴가 없음 → 렌더러의 `contextmenu`에서 그림/입력창일 때만 IPC로 넘기고 메인에서 `Menu.popup()`
   (그림: 저장=`webContents.downloadURL`(미리보기용 `?inline=1` 제거), 복사=`copyImageAt(x,y)` / 입력창: 복사·잘라내기·붙여넣기·모두 선택).
   조직도 사용자 우클릭은 기존 자체 메뉴가 담당하므로 제외한다.
   `contextBridge`로 노출한 `window.native`는 고정(freeze)되어 테스트에서 가로챌 수 없으니, IPC를 `handle`로 만들어 만든 메뉴 항목 수를 돌려주면 검증하기 쉽다
3. file:// 렌더러의 fetch는 CORS 적용 → 서버에 `Access-Control-Allow-Origin: *` 필수
4. electron-builder의 winCodeSign 압축 해제가 심볼릭 링크 권한으로 실패할 수 있음 → 캐시에 수동 압축 해제로 우회
5. 알림 앱 이름: `app.setAppUserModelId(appId)` + 한글 productName

### 클라이언트 업데이트 (v0.9.11~)
- 로그인 때 `S.serverClientVer`(서버 등록본)가 내 버전보다 새로우면 서버 `/client-update` 에서, 아니면 `S.updateRepo` 가 있을 때
  메인 프로세스 `check-github-update(repo)`(공개 API, 10초 제한)로 GitHub 최신 클라이언트 자산을 찾아 `browser_download_url` 로 받음.
  GitHub 직접 확인은 **6시간에 한 번**(localStorage `ghCheckAt`, 학교는 인터넷 주소 하나를 같이 써서 요청 한도에 걸림), [정보] → [업데이트 확인]은 즉시.
- `download-update` 허용 주소: `http(s)://서버/client-update` 또는 `https://github.com/{o}/{r}/releases/download/{tag}/SchoolMessenger-Client-Setup-x.y.z.exe`
  (시험용 `SM_GITHUB_API` 지정 시 그 주소). GitHub 는 실제 파일로 넘겨 주므로 `will-download` 에서 `item.getURLChain()` 까지 비교
- 정보 창: 버전, [업데이트 확인] + 결과 문구, [GitHub 에서 직접 받기](릴리스 페이지를 기본 브라우저로)

## 6. 검증 (필수)

- **성능 시험**: 쪽지 4만·채팅 2만·첨부 3천 개(교직원 100명 한 학기)의 큰 데이터를 만들어 저장 1회 이벤트 루프 멈춤, 로그인 응답, 채팅 왕복(저장이 겹칠 때),
  1.0.0 형식 자동 옮기기 동안의 멈춤을 잰다 (목표: 멈춤 100ms 미만). 저장 방식은 옮기기·다시 시작·바뀐 날짜만 쓰기·손상 파일 .bak 복구·
  저장 중 동기 저장 끼어들기·백업/복원(예전 형식 백업 포함)·업로드 흘려 쓰기(401/413)까지 자동 시험
- 서버 코어를 단독 node로 띄워 WebSocket 자동 테스트 작성: 로그인/거부/kick, 쪽지 송수신/읽음/회수(읽은 뒤 회수·남의 쪽지 차단)/
  나에게 보내기(읽음 처리·중복 전달 없음)/삭제, 예약 쪽지·공지,
  설문 투표/마감/복수선택/투표취소/익명 설문의 투표자 비노출/예전 형식 마이그레이션, 채팅방 설문(비멤버 차단),
  채팅방 생성/초대/나가기/비멤버 차단, 그룹 CRUD/타인 수정 차단, 관리자 권한 검사(부서 순서/이름변경/계정 CRUD),
  회원가입(필수 누락/중복/승인/거절/관리자 알림/일반 사용자의 승인 시도 차단), 다중 부서, CORS 헤더,
  파일 업로드/다운로드/무인증 거부, 활동 로그, DB 저장,
  채팅방 글 수정·회수(남의 글·시스템 안내·방을 나간 사람 차단, 빈 글 거부, 첨부 글은 글자 없이 수정, 설문은 수정 거부·회수 가능, 회수 후 수정 불가),
  조직도 아이콘(잘못된 모양·색·그림 이름 정리, 2글자 제한, 예전 클라이언트 저장 시 유지, 기본값이면 null, 다시 로그인해도 유지)
- 클라이언트 UI는 `electron.exe . --remote-debugging-port=<포트>`로 띄우고 CDP(`Runtime.evaluate`)로 실제 화면을 조작해 검증
  (로그인 → 설문 만들기/투표/투표자 표시, 드래그앤드롭 첨부, 가입 승인까지). `confirm/alert`은 테스트 중 임시 대체
- 빌드 후 패키징된 exe를 실제 실행해 /health, 로그인, 클라이언트 창 표시 확인
- 자동 업데이트는 **가짜 GitHub API**(http 서버: releases/latest + 자산 302 넘김 + digest)로 검증: 공개/비공개(토큰, 실제 파일 주소에 토큰 미전송)/
  SHA-256 불일치 거부/연결 실패 문구/이미 최신/접속자 있으면 설치 안 함·0명이면 설치/자동 설치 끔. 리눅스는 프로그램 폴더 **복사본**에서
  headless.js 를 띄워 웹 관리 API 전체 + 업데이트 설치(파일 교체 후 종료, 데이터 유지)까지
- 리눅스 꾸러미는 풀어서 `node headless.js` 로 실제 실행해 `/health`·`/admin/` 확인
