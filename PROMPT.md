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
notices: { id, authorId, authorName, title, body, time, poll?{options[], deadline, votes{userId:optIdx}} }
rooms:   { id, name, creator, members[], time } / roomMsgs: { id, roomId, from, text, attachments, time, system? }
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
  scheduledNotices(내 예약공지), deptOrder, userOrder, extraDepts
- 중복 로그인 시 기존 세션에 `kicked` 보내고 종료
- 쪽지: `send_message{to[],text,attachments,sendAt?}` (sendAt이 미래면 예약 → `scheduled_added`),
  `read`→`read_receipt`, `recall_message`(안 읽은 것만, 전체 삭제), `delete_message`(내 보관함만; 전원이 삭제하면 완전 제거),
  `cancel_scheduled`
- 상태: `set_status(online/away/class/meeting)` → presence 브로드캐스트(online, status)
- 채팅방: `create_room`, `room_message`, `add_room_members`, `leave_room` (+입장/퇴장 시스템 메시지)
- 공지: `post_notice{title,body,poll?{options,deadline},publishAt?}`(관리자만),
  `vote_poll`(마감 전 변경 가능, `notice_updated` 브로드캐스트), `delete_notice`, `cancel_scheduled_notice`
- 그룹: `save_group{id?,name,members}`, `delete_group` (소유자만)
- 프로필: `update_profile{office,subject,phone,mobile,email}`, `change_pw{oldPw,newPw}`
- 관리자 전용: `admin_add_user/admin_update_user/admin_delete_user`(→`admin_result`),
  `set_dept_order`, `set_user_order{dept,order}`, `rename_dept{from[],to}`(여러 부서 병합 가능, deptOrder/userOrder/extraDepts 동기화),
  `add_dept`/`delete_dept`(빈 부서, extraDepts)
- 회원가입: `signup_request` 필수 항목 = 아이디/비밀번호/이름/부서/직위/사무실전화 (과목·핸드폰·이메일 선택).
  접수 시 **접속 중인 관리자 권한 사용자 전원에게 `signup_alert`** 전송. 승인/거절은 서버 관리 화면에서 (승인 시 요청 때 해시된 비밀번호 그대로 계정 생성)
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
  7. **클라이언트 자동 업데이트**: 새 클라이언트 설치파일(.exe) 등록(파일명에서 버전 추출) → 구버전 클라이언트 로그인 시 자동 안내
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
  - **다중 부서**: 사용자는 여러 부서에 동시에 표시. **트리형 부서**: 이름에 `-`가 있으면 상위-하위로 표시(예: 교과-국어)
  - **교과 자동 조직**: 담당 과목 입력 시 조직도 **맨 아래 "교과" 상위조직 밑에 "교과-{과목}"**으로 자동 소속(파생 조직은 이름변경/이동 불가)
  - 관리자: 부서/사용자 **드래그앤드롭**(부서 순서, 부서 내 사용자 순서, 다른 부서로 이동), 부서 우클릭 → **부서 관리 모달**(새 부서 추가, 여러 부서 선택해 이름 변경=병합, 빈 부서 삭제)
  - 우클릭 메뉴: 쪽지 보내기/대화하기/사용자 그룹에 추가▸(내 그룹 목록+새 그룹)/내 정보 수정(본인), 프로필 정보(🏢📚☎📱✉) 표시, 다중 선택 시 선택 전체에 적용
  - 사용자 그룹 탭: 내가 만든 그룹들(서버 저장), 구성원 개별 체크→선택 쪽지, 전체 쪽지, 채팅방 만들기, 수정/삭제
  - 관리자는 하단 "⚙ 조직/사용자 관리" 버튼 → 계정 추가/수정/삭제 모달(검색 포함)
- **오른쪽 탭** (순서 중요): **📢공지사항(첫 탭, 로그인 시 기본)** / ✉받은쪽지 / 보낸쪽지 / 대화 / 채팅방 + "쪽지 보내기" 버튼
  - 목록 항목에 **[공지](주황)/[쪽지](파랑) 라벨** + 아바타 + 미리보기 + 안읽음 강조/배지
  - 쪽지: 다중 수신자(부서 단위 선택 가능), 첨부 여러 번 누적 추가+개별 삭제+드래그앤드롭, 예약 발송(취소 가능),
    읽음 확인(누가 읽었는지), 답장/전달(첨부 포함)/회수(안 읽은 것만)/삭제(내 보관함만), 검색
  - 대화: 1:1 실시간 채팅(말풍선, 읽음 표시), 파일 드롭 전송
  - 채팅방: 그룹 채팅, 초대/나가기, 안읽음 수, 시스템 메시지
  - 공지: 관리자만 작성(설문조사: 항목+마감시각, 실시간 막대그래프 결과, 마감 후 투표 불가 / 예약 공지: 시각 지정, 목록 상단에 취소 가능 표시)
- 본문 URL 자동 링크화(기본 브라우저로 열기, `/files/` 다운로드는 예외 처리)
- 알림: 데스크톱 알림+작업표시줄 깜빡임+알림음(끄기 가능), 클릭 시 창 복원. 관리자에게 회원가입 알림
- 다운로드: 저장 대화상자 없이 다운로드 폴더에 저장, **같은 이름이면 `이름 (1).ext` 자동 번호**, 우하단 **진행률 패널**(%, 용량, 완료 시 "폴더에서 보기")
- 이미지 첨부는 대화/쪽지에서 미리보기, 전화번호 입력은 blur 시 자동 하이픈(02/지역번호/휴대폰 구분, 문구 섞이면 그대로)
- 설정: Windows 시작 시 자동 실행, 알림음, 다크 모드(전체 화면 대응, localStorage 저장)
- 내 정보 수정: 사무실 번호/담당 과목/사무실 전화/핸드폰/이메일 + 비밀번호 변경(같은 모달)
- 트레이 상주(닫아도 알림 수신), 자동 업데이트(로그인 시 서버 등록 버전과 비교 → 다운로드 → 설치 안내 후 종료)

### Electron 함정 (반드시 처리)
1. `window.prompt()` 미지원 → 자체 모달
2. `alert()/confirm()` 후 입력창 포커스 깨짐 → 호출 후 IPC로 `win.blur(); win.focus()` 재설정 (양쪽 앱 모두)
3. file:// 렌더러의 fetch는 CORS 적용 → 서버에 `Access-Control-Allow-Origin: *` 필수
4. electron-builder의 winCodeSign 압축 해제가 심볼릭 링크 권한으로 실패할 수 있음 → 캐시에 수동 압축 해제로 우회
5. 알림 앱 이름: `app.setAppUserModelId(appId)` + 한글 productName

## 6. 검증 (필수)

- 서버 코어를 단독 node로 띄워 WebSocket 자동 테스트 작성: 로그인/거부/kick, 쪽지 송수신/읽음/회수/삭제, 예약 쪽지·공지,
  설문 투표/마감, 채팅방 생성/초대/나가기/비멤버 차단, 그룹 CRUD/타인 수정 차단, 관리자 권한 검사(부서 순서/이름변경/계정 CRUD),
  회원가입(필수 누락/중복/승인/거절/관리자 알림), 다중 부서, CORS 헤더, 파일 업로드/다운로드/무인증 거부, 활동 로그, DB 저장
- 빌드 후 패키징된 exe를 실제 실행해 /health, 로그인, 클라이언트 창 표시 확인
