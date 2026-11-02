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
├─ server/   # 서버 앱 (main.js, preload.js, server.js, ui/index.html·style.css·app.js, icon)
└─ client/   # 클라이언트 앱 (main.js, preload.js, ui/index.html·style.css·app.js, icon)
```

- 버전: **0.2.0** (양쪽 동일). 설치파일명: `SchoolMessenger-Server-Setup-{버전}.exe`, `SchoolMessenger-Client-Setup-{버전}.exe`
- 클라이언트 제품 표시 이름(productName)은 **"학교메신저"**(한글), 실행파일명(executableName)은 `SchoolMessenger`로 분리
  (Windows 알림 상단에 한글 이름이 나오게 `app.setAppUserModelId(appId)` 설정)
- 클라이언트 아이콘: 파란 그라데이션 둥근 사각형에 흰색 **"sm"** 텍스트. 서버 아이콘: 초록 배경 "서버" 텍스트
- 저작권 표기: **ⓒ jiseok. All rights reserved.** (정보 모달, 로그인 화면 하단)

## 3. 서버 코어 (server.js)

### 저장소
- 데이터 폴더(`userData/serverdata/`)에 `data.json`(전체 DB), `uploads/`(첨부), `update/`(클라이언트 업데이트 파일), `activity.log`(활동 로그)
- 저장은 300ms 디바운스 후 파일 쓰기. 비밀번호는 `sha256(salt + ':' + pw)` 해시로 저장

### 데이터 모델 (data.json)
```
users:   { id, name, dept(대표 부서), depts[](다중 소속), position, office, subject, phone, mobile, email,
           admin(bool), salt, pw(hash) }
messages:{ id, from, to[], text, attachments[{name,size,url}], time, readBy[], deletedBy[], scheduled? }
notices: { id, authorId, authorName, title, body, time, poll? }
poll:    { q, options[], deadline, multi(복수선택), anon(투표자 미공개), votes{ userId: [optIdx,...] } }
         — 예전 형식(votes{userId:optIdx})은 불러올 때 배열로 자동 변환
rooms:   { id, name, creator, members[], time } / roomMsgs: { id, roomId, from, text, attachments, time, system?, poll? }
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
- `GET /health`, `POST /upload?token=&name=`(raw body, 200MB 제한, 로그인 토큰 검증),
  `GET /files/:fid/:name`(Content-Disposition attachment), `GET /client-update`(등록된 클라이언트 설치파일 다운로드)

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
- **왼쪽 메뉴 트리**(고정 내비게이션): 서버 상태 / 사용자 관리 / 회원가입 요청(대기 수 배지) / 부서 표시 순서 / 데이터 관리 / 활동 로그 / 클라이언트 업데이트 — 클릭 시 해당 카드로 부드럽게 스크롤
- 카드 구성:
  1. **서버 상태**: 접속 주소(LAN IP:포트), 포트 변경, 등록/접속 사용자 수, 학교 이름, Windows 시작 시 자동 실행 체크
  2. **사용자 관리**: 추가 폼(순서: 아이디→비밀번호→이름→부서→직위 + 관리자 체크, 부서는 datalist로 기존 부서 선택),
     `아이디,이름,부서,직위,비밀번호` 일괄 등록, **엑셀(xlsx 첫 시트)/CSV 가져오기**(CP949 자동 감지, 머리글 무시, 부서 다중은 `;`),
     **엑셀용 CSV 내보내기**(UTF-8 BOM), **검색 입력**(아이디/이름/부서/직위 필터), 수정 모달(비밀번호 변경 포함), 삭제
     ※ Electron은 `window.prompt()` 미지원 — 반드시 자체 모달 사용
  3. **회원가입 요청**: 요청자 정보 + 승인/거절 버튼, 5초 자동 갱신
  4. **부서 표시 순서**: ▲▼ 버튼으로 순서 지정 → 모든 클라이언트 실시간 반영
  5. **데이터 관리**: 쪽지/채팅/첨부 용량 현황, 보관 기간(일, 0=무제한) 설정, "지금 정리"(기간 경과 데이터 + 참조 없는 첨부파일 삭제, 업로드 1시간 유예)
  6. **활동 로그**: 콘솔 스타일 최근 300건, 새로고침, 로그 파일 열기
  7. **클라이언트 자동 업데이트**: 새 클라이언트 설치파일(.exe) 등록(파일명에서 버전 추출) → 구버전 클라이언트 로그인 시 자동 다운로드 후 재시작 한 번으로 설치
- 헤더에 ℹ 정보 버튼(버전 + ⓒ jiseok)

## 5. 클라이언트 앱 (Electron)

### 로그인 화면
- 서버주소(IP:포트, 포트 생략 시 7777)/아이디/비밀번호 + 접속 정보 저장, 하단 ⓒ jiseok
- **회원가입 요청** 버튼 → 모달(아이디*/비밀번호*+확인/이름*/부서*(쉼표 다중)/직위*(예: 교사, 부장)/사무실전화*(예: 062-000-0000)/담당과목(선택)/핸드폰/이메일) → 임시 WebSocket으로 전송
- 연결 끊기면 "재접속 중" 배너 + 4초 간격 자동 재접속

### 메인 화면 구성
- 헤더: 학교 이름, 내 정보 요약, 상태 선택(🟢온라인/🟡자리비움/🔴수업중/🟠회의중), 설정/내 정보/정보/로그아웃(확인창)
- **왼쪽 사이드바** — [조직도 | 사용자 그룹] 탭:
  - 조직도: 검색, 전체 선택 바(N명 선택 시 ✉쪽지/👥그룹 만들기/✕해제), 부서 접기/펼치기,
    부서 체크박스(부서 전체 선택), 부서 ✉버튼(부서 전체 쪽지), 사용자 행(아바타+접속상태점+이름+직위+상태라벨, 체크박스)
  - **접속 상태 필터**: 검색창 아래 `[전체 N] [● 접속 N] [● 미접속 N]` 세그먼트(인원 수는 시스템 계정 제외). 고르면 그 상태의 사람만 보이고
    (검색처럼 접힌 부서도 펼치고 빈 부서는 숨김), presence 가 바뀌면 바로 다시 그린다. 필터를 바꿀 때 화면에서 사라진 사람은
    선택(`treeSel`)에서도 빼서 안 보이는 사람에게 쪽지가 가지 않게 한다. "전체 선택"은 보이는 사람만 대상
  - **다중 부서**: 사용자는 여러 부서에 동시에 표시. **트리형 부서**: 이름에 `-`가 있으면 상위-하위로 표시(예: 교과-국어)
  - **교과 자동 조직**: 담당 과목 입력 시 조직도 **맨 아래 "교과" 상위조직 밑에 "교과-{과목}"**으로 자동 소속(파생 조직은 이름변경/이동 불가)
  - 관리자: 부서/사용자 **드래그앤드롭**(부서 순서, 부서 내 사용자 순서, 다른 부서로 이동), 부서 우클릭 → **부서 관리 모달**(새 부서 추가, 여러 부서 선택해 이름 변경=병합, 빈 부서 삭제)
  - 우클릭 메뉴: 쪽지 보내기/대화하기/사용자 그룹에 추가▸(내 그룹 목록+새 그룹)/내 정보 수정(본인), 프로필 정보(🏢📚☎📱✉) 표시, 다중 선택 시 선택 전체에 적용
  - 사용자 그룹 탭: 내가 만든 그룹들(서버 저장), 구성원 개별 체크→선택 쪽지, 전체 쪽지, 채팅방 만들기, 수정/삭제
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
- 이미지 첨부는 대화/쪽지에서 미리보기, 전화번호 입력은 blur 시 자동 하이픈(02/지역번호/휴대폰 구분, 문구 섞이면 그대로)
- 설정: Windows 시작 시 자동 실행, 알림음, 다크 모드(전체 화면 대응, localStorage 저장)
- 내 정보 수정: 사무실 번호/담당 과목/사무실 전화/핸드폰/이메일 + 비밀번호 변경(같은 모달)
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

## 6. 검증 (필수)

- 서버 코어를 단독 node로 띄워 WebSocket 자동 테스트 작성: 로그인/거부/kick, 쪽지 송수신/읽음/회수(읽은 뒤 회수·남의 쪽지 차단)/
  나에게 보내기(읽음 처리·중복 전달 없음)/삭제, 예약 쪽지·공지,
  설문 투표/마감/복수선택/투표취소/익명 설문의 투표자 비노출/예전 형식 마이그레이션, 채팅방 설문(비멤버 차단),
  채팅방 생성/초대/나가기/비멤버 차단, 그룹 CRUD/타인 수정 차단, 관리자 권한 검사(부서 순서/이름변경/계정 CRUD),
  회원가입(필수 누락/중복/승인/거절/관리자 알림/일반 사용자의 승인 시도 차단), 다중 부서, CORS 헤더,
  파일 업로드/다운로드/무인증 거부, 활동 로그, DB 저장
- 클라이언트 UI는 `electron.exe . --remote-debugging-port=<포트>`로 띄우고 CDP(`Runtime.evaluate`)로 실제 화면을 조작해 검증
  (로그인 → 설문 만들기/투표/투표자 표시, 드래그앤드롭 첨부, 가입 승인까지). `confirm/alert`은 테스트 중 임시 대체
- 빌드 후 패키징된 exe를 실제 실행해 /health, 로그인, 클라이언트 창 표시 확인
