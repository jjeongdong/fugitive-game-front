# 프론트엔드 통합 가이드 — Fugitive(도망자) 게임

> **이 문서의 목적:** 프론트엔드를 만드는 AI 에이전트가 이 백엔드에 화면·기능을 연결할 수 있도록,
> 실제 구현된 WebSocket/REST 계약·데이터 shape·화면 흐름·관점별 렌더링 규칙을 한 곳에 정리한다.
> **게임 규칙 자체**(카드·은신처·스프린트·추측·맨헌트·승패)는 루트 `RULES.md`를 읽어라. 이 문서는
> "화면을 백엔드에 어떻게 붙이는가"를 다룬다.
>
> 이 문서는 아래 계약을 종합한 것이다(더 깊은 근거가 필요하면 참조):
> `_workspace/contracts/ws-message-contract.md`, `api-contract.md`, `game-state-contract.md`.

---

## 0. 30초 요약

- **2인 비대칭 게임.** 한 명은 **도망자(FUGITIVE)**, 한 명은 **보안관(MARSHAL)**. 두 사람이 보는 정보가 다르다.
- **로비 방식:** 방장이 방을 만들어 `roomId`를 받고, 상대가 그 `roomId`로 입장 → 게스트 READY → 방장 GAME START.
- **실시간은 STOMP over WebSocket**(`/ws`), **조회/재접속은 REST**.
- **서버 권위:** 모든 행위의 신원은 접속 시 준 `playerId`(principal)로 서버가 판단한다. 프론트가 보낸 역할/신원 본문은 무시된다.
- **정보 유출 방지는 서버가 이미 처리한다.** 서버는 각 플레이어에게 그 사람이 볼 수 있는 것만 보낸다. **프론트는 받은 데이터를 그대로 그리면 되고, 안 보이는 정보를 추측해 채우려 하지 마라.**

---

## 1. 접속 기본값 & 라이브러리

| 항목 | 값 |
|------|-----|
| 백엔드 기본 주소 | `http://localhost:8080` (포트 미설정 시 Spring 기본 8080 — 배포 환경에 맞게 교체) |
| STOMP WebSocket 엔드포인트 | `ws://localhost:8080/ws` |
| 전송 프로토콜 | **STOMP over 순수 WebSocket** (SockJS 아님 — `@stomp/stompjs`의 `brokerURL` 사용) |
| CORS/Origin | 개발용 `*` 허용 (`setAllowedOriginPatterns("*")`) |
| 메시지 포맷 | JSON |
| REST | 위 주소 기준 (`/rooms/...`, `/players/...`) |

**권장 클라이언트:** `@stomp/stompjs` (브라우저 네이티브 WebSocket). SockJS는 서버에 설정돼 있지 않으니 쓰지 마라.

### 1-1. 사용자 식별 (인증 아님, MVP)

- 로그인/토큰이 **없다.** 프론트는 사용자에게 `playerId`(임의 문자열, 예: 닉네임+랜덤)를 하나 만들게 하고,
  **STOMP CONNECT 프레임의 `playerId` 헤더**에 실어 보낸다. 서버는 이걸 세션 신원으로 삼는다.
- 같은 `playerId`로 재접속하면 진행 중인 자기 방/게임을 다시 찾을 수 있다(§7 재접속).
- `playerId` 헤더 없이 접속하면 연결은 되지만 모든 `/app/*` 액션이 서버에서 거부된다.

```js
import { Client } from '@stomp/stompjs';

const client = new Client({
  brokerURL: 'ws://localhost:8080/ws',
  connectHeaders: { playerId: myPlayerId },   // ← 신원. 반드시 넣는다.
  reconnectDelay: 3000,
  onConnect: () => { /* 여기서 구독 설정 (§2-1) */ },
});
client.activate();
```

---

## 2. STOMP 목적지 레퍼런스 (전체)

### 2-1. 접속 직후 구독해야 할 것

`onConnect`에서 아래를 구독한다. **방장이 방을 만들기 전에, 그리고 START 이전에 미리 구독**해 두어야 통지를 놓치지 않는다.

| 구독 목적지 | 언제 오나 | payload |
|-------------|-----------|---------|
| `/user/queue/room.created` | 내가 방을 생성했을 때(나에게만) | `{ "roomId": "..." }` |
| `/user/queue/errors` | 내 액션이 실패했을 때(나에게만) | `ErrorResponse` (§3) |
| `/user/queue/game.started` | 게임이 시작됐을 때(나에게만, 내 관점) | `PlayerView` (§4) |
| `/user/queue/game.state` | 게임 중 상태가 갱신됐을 때(나에게만, 내 관점) | `PlayerView` (§4) |
| `/topic/room/{roomId}` | 방 상태(입장·READY·START)가 바뀔 때(방 참여자 전체) | `RoomState` (§4) |

`/topic/room/{roomId}`는 `roomId`를 알게 된 직후 구독한다(방장은 `room.created` 수신 후, 게스트는 입장할 `roomId`를 알 때).

### 2-2. 클라이언트 → 서버 (발행)

모든 액션의 신원은 CONNECT의 principal에서 온다. **본문에 playerId/역할을 넣어도 무시된다.**

| 발행 목적지 | 보내는 시점 | body(JSON) |
|-------------|-------------|------------|
| `/app/room/create` | 방장이 방 만들기 | *(빈 본문)* |
| `/app/room/join` | 게스트가 입장 | `{ "roomId": "..." }` |
| `/app/room/ready` | 게스트가 READY 토글 | `{ "roomId": "...", "ready": true }` |
| `/app/room/start` | 방장이 게임 시작 | `{ "roomId": "..." }` |
| `/app/game/{roomId}/move` | 게임 중 수 두기 | `MoveRequest` (§5) |

```js
client.publish({ destination: '/app/room/create', body: '' });
client.publish({ destination: '/app/room/join', body: JSON.stringify({ roomId }) });
client.publish({ destination: '/app/room/ready', body: JSON.stringify({ roomId, ready: true }) });
client.publish({ destination: '/app/room/start', body: JSON.stringify({ roomId }) });
```

---

## 3. REST 레퍼런스 (조회 / 재접속)

실시간 액션은 전부 STOMP다. REST는 **읽기 전용 조회**(재접속·새로고침·전적)에 쓴다.

| 메서드/경로 | 용도 | 응답 |
|-------------|------|------|
| `GET /rooms/{roomId}` | 방 메타 조회 | `RoomState` (§4) / 404 `ROOM_NOT_FOUND` |
| `GET /rooms/{roomId}/game?playerId={playerId}` | **내 관점** 게임 상태 조회(재접속 복구) | `PlayerView` (§4) / 404 `GAME_NOT_STARTED` / 403 `NOT_A_PARTICIPANT` |
| `GET /players/{playerId}/results` | 내 전적(종료된 게임 목록, 최신순) | `GameResult[]` (§4). 없으면 `[]` |

> `GET /rooms/{roomId}/game`은 **playerId 관점으로 필터링된** 뷰만 준다. 남의 playerId로 요청해도
> 그 사람 관점만 나오고, 비참가자면 403이다. 프론트는 항상 **자기 playerId**로 조회한다.

---

## 4. 데이터 모델 (와이어 shape — 정확히 이대로 온다)

모든 응답은 `@JsonInclude(NON_NULL)` — **값이 없는 필드는 아예 생략된다.** (예: 마스킹된 은신처의 `number`,
미배정 역할, 미종료 게임의 `winner`.) 프론트는 필드 부재를 정상 상태로 다뤄라.

### 4-1. `Card`
```json
{ "number": 7, "sprintValue": 2 }
```
- `number`: 0~42.
- `sprintValue`(발자국): **짝수 번호 = 2, 홀수 번호 = 1.** 스프린트로 은신처 간격을 넓힐 때 쓰는 값.

### 4-2. `HideoutView` — 게임 board의 한 칸 (⚠️ 중요)

`PlayerView.board`는 `Card[]`가 **아니라** `HideoutView[]`다. 은신처 사슬의 각 칸을 관점 필터링한 것이다.

```json
// 공개(발각)된 은신처 또는 도망자 본인이 보는 은신처
{ "number": 7, "sprintCards": [ { "number": 4, "sprintValue": 2 } ], "sprintCount": 1, "revealed": true }

// 보안관이 보는 '비공개' 은신처 (number 생략 = 아직 모름)
{ "sprintCards": [], "sprintCount": 1, "revealed": false }
```

| 필드 | 타입 | 의미 |
|------|------|------|
| `number` | int **or 생략** | 은신처 번호. **보안관에게 감춰진 비공개 은신처는 생략(=아직 모름).** 도망자는 항상 있음. |
| `sprintCards` | `Card[]` | 이 은신처 밑에 깔린 스프린트 카드. 감춰졌으면 `[]`. |
| `sprintCount` | int | 이 은신처 밑 스프린트 카드 **장수**(더미 높이 — 번호가 아님). 보안관도 개수는 안다. |
| `revealed` | boolean | 전역적으로 공개(발각)되었는지. |

board의 첫 칸은 항상 카드 0(시작 은신처, `revealed:true`)이다.

### 4-3. `PlayerView` — `game.started` / `game.state` / `GET .../game` 공통

```json
{
  "viewer": "FUGITIVE",
  "board": [ { "number": 0, "sprintCards": [], "sprintCount": 0, "revealed": true } ],
  "hand": [ { "number": 1, "sprintValue": 2 }, ... ],
  "opponentHandSize": 0,
  "deck1Count": 8, "deck2Count": 12, "deck3Count": 13,
  "currentTurn": "FUGITIVE",
  "phase": "IN_PROGRESS",
  "winner": null
}
```

| 필드 | 타입 | 의미 / 관점 규칙 |
|------|------|------------------|
| `viewer` | `Role` | 이 뷰의 주인(`FUGITIVE`\|`MARSHAL`). **내 역할 판별에 이걸 써라**(START 배정이 무작위라 이게 진실). |
| `board` | `HideoutView[]` | 은신처 사슬. 관점 필터링됨(§4-2). |
| `hand` | `Card[]` | **내 손패만.** 도망자는 자기 카드들, **보안관은 항상 `[]`.** |
| `opponentHandSize` | int | 상대 손패 **장수만**(내용 없음). |
| `deck1Count`/`deck2Count`/`deck3Count` | int | 덱1(4~14)/덱2(15~28)/덱3(29~41) **잔여 장수만**. |
| `currentTurn` | `Role` | 지금 누구 차례인지. `viewer === currentTurn`이면 내가 둘 차례. |
| `phase` | `Phase` | `IN_PROGRESS` \| `MANHUNT` \| `ENDED`. |
| `winner` | `Role` **or 생략** | `ENDED`일 때만 등장. 승자 역할. |

### 4-4. `RoomState` — `/topic/room/{roomId}` / `GET /rooms/{roomId}`

```json
// WAITING
{ "roomId": "...", "hostId": "host-1", "guestId": "guest-1", "guestReady": false, "status": "WAITING" }
// STARTED (역할은 공개 정보라 양쪽 동일하게 담김)
{ "roomId": "...", "hostId": "host-1", "guestId": "guest-1", "guestReady": true,
  "hostRole": "FUGITIVE", "guestRole": "MARSHAL", "status": "STARTED" }
```

| 필드 | 타입 | 의미 |
|------|------|------|
| `roomId` | String | 방 식별자(UUID 문자열) |
| `hostId` | String | 방장 playerId(항상) |
| `guestId` | String **or 생략** | 게스트 playerId(입장 전엔 생략) |
| `guestReady` | boolean | 게스트 READY 여부 |
| `hostRole`/`guestRole` | `Role` **or 생략** | **STARTED에서만** 등장 |
| `status` | `RoomStatus` | `WAITING` \| `STARTED` |

### 4-5. `GameResult` — `GET /players/{playerId}/results` 원소

```json
{ "roomId": "...", "winnerRole": "FUGITIVE", "winnerPlayerId": "host-1",
  "fugitivePlayerId": "host-1", "marshalPlayerId": "guest-1", "endedAt": "2026-07-05T00:00:00Z" }
```
승자·참가자·종료시각 같은 **공개 메타만**. 손패/은신처 등 비밀은 없다.

### 4-6. `ErrorResponse` — `/user/queue/errors` 및 REST 에러 바디

```json
{ "code": "NOT_HOST", "reason": "UNAUTHORIZED", "message": "사람이 읽는 설명" }
```
`code`로 분기하고(§6 표), `message`는 디버그/토스트용. **에러는 그 액션을 한 사람에게만** 간다.

### 4-7. Enum 값
- `Role`: `FUGITIVE`, `MARSHAL`
- `RoomStatus`: `WAITING`, `STARTED`
- `Phase`: `IN_PROGRESS`, `MANHUNT`, `ENDED`
- `Deck`(수 요청에서): `DECK_1`(4~14), `DECK_2`(15~28), `DECK_3`(29~41)

---

## 5. 게임 수(Move) 요청 — `MoveRequest`

`/app/game/{roomId}/move`로 보내는 body. **하나의 목적지가 모든 수 종류를 받는다**(`type`으로 구분).
**`type` 외에 안 쓰는 필드는 넣지 않아도 된다. actor/역할은 절대 넣지 마라(서버가 결정).**

| `type` | 함께 보내는 필드 | 의미 |
|--------|------------------|------|
| `DRAW_CARD` | `deck`: `"DECK_1"`\|`"DECK_2"`\|`"DECK_3"` | 지정 덱에서 1장 뽑기 |
| `PLACE_HIDEOUT` | `hideout`: int, `sprintCards`: int[]*(선택)* | 은신처를 뒷면으로 놓기. `hideout: 42`면 탈출 시도 |
| `PASS` | — | 도망자가 은신처 안 놓고 턴 넘김 |
| `GUESS` | `targets`: `[{ "position": int, "number": int }, ...]` | 보안관 추측(다중 = 전부 맞아야 공개) |
| `MANHUNT_GUESS` | `target`: `{ "position": int, "number": int }` | 맨헌트 중 단일 지목 |

- `position` = `board` 배열의 **0-based 인덱스**. `number` = 그 칸이 이 번호일 것이라는 주장.
- 카드/스프린트는 **번호로만** 보낸다(서버가 권위 있는 값으로 취급).

```js
// 도망자: 덱1에서 뽑기 → 은신처 7을 스프린트 카드 4 깔고 놓기 (두 번의 발행)
client.publish({ destination: `/app/game/${roomId}/move`,
  body: JSON.stringify({ type: 'DRAW_CARD', deck: 'DECK_1' }) });
client.publish({ destination: `/app/game/${roomId}/move`,
  body: JSON.stringify({ type: 'PLACE_HIDEOUT', hideout: 7, sprintCards: [4] }) });

// 보안관: 추측
client.publish({ destination: `/app/game/${roomId}/move`,
  body: JSON.stringify({ type: 'GUESS', targets: [{ position: 1, number: 7 }] }) });
```

수가 **성공**하면 두 플레이어 각자에게 `/user/queue/game.state`로 갱신 뷰가 온다.
**실패(규칙 위반)**하면 둔 사람에게만 `/user/queue/errors`가 온다(상대에겐 아무것도 안 감).

---

## 6. 에러 코드 → 사용자 메시지 매핑

에러는 `/user/queue/errors`(STOMP) 또는 REST 에러 바디로 오며, 그 액션을 한 사람에게만 간다. `code`로 분기하라.

**로비 에러:**

| code | 언제 | 프론트 처리 제안 |
|------|------|------------------|
| `ROOM_NOT_FOUND` | 없는 roomId로 입장/전이 | "방을 찾을 수 없어요" — roomId 재확인 |
| `ROOM_FULL` | 이미 2명인 방 입장 | "방이 꽉 찼어요" |
| `ROOM_ALREADY_STARTED` | 시작된 방 입장/READY/재시작 | "이미 시작된 게임이에요" |
| `NOT_HOST` | 방장 아닌 사람이 START | START 버튼을 게스트에게 숨겨라(예방) |
| `GUEST_NOT_PRESENT` | 게스트 없이 START, 또는 게스트 아닌데 READY | 상대 입장 대기 안내 |
| `NOT_READY` | 게스트 미READY 상태 START | START 버튼을 게스트 READY 전엔 비활성화(예방) |

**게임 수 에러(규칙 위반, `reason: RULE_VIOLATION`):**
`GAME_ALREADY_ENDED`, `NOT_YOUR_TURN`, `ILLEGAL_MOVE_FOR_PHASE`, `MUST_DRAW_FIRST`, `NO_DRAW_EXPECTED`,
`DECK_EMPTY`, `CARD_NOT_IN_HAND`, `NOT_ASCENDING`, `GAP_EXCEEDED`, `TOO_MANY_HIDEOUTS`,
`DUPLICATE_SPRINT_CARD`, `ILLEGAL_GUESS`.
→ 대부분 UI에서 **예방 가능**하다(내 차례·내 손패·오름차순·간격만 낼 수 있게 컨트롤을 제약). 그래도 서버가 최종 판정이므로 에러는 항상 처리하라.

**접근/본문 에러:** `GAME_NOT_STARTED`(미시작 방에 수), `NOT_A_PARTICIPANT`(비참가자), `MALFORMED_MOVE`(잘못된 본문).

---

## 7. 재접속 전략 (필수 구현 권장)

진행 중 게임 상태는 서버 세션(Redis)에, 방 메타는 DB에 있다. 연결이 끊겼다 돌아오면:

1. 같은 `playerId`로 **다시 CONNECT**(같은 헤더) → §2-1 구독 재설정.
2. `GET /rooms/{roomId}` 로 방 상태 복구(대기방이면 여기까지).
3. 게임 중이면 `GET /rooms/{roomId}/game?playerId={내playerId}` 로 **내 관점 게임 뷰 복구** → 화면 재구성.
4. `/topic/room/{roomId}`·`/user/queue/game.state` 재구독으로 이후 실시간 갱신 수신.

`roomId`는 프론트가 로컬(예: `localStorage`)에 보관해 두면 새로고침 복구가 쉽다.

---

## 8. 화면 흐름 & 상태 머신

```
[홈] playerId 입력·접속
  → [로비] 방 만들기(create) | roomId로 입장(join)
       (create 성공 → room.created로 roomId 수신 → 대기방)
       (join 성공 → 방 상태 브로드캐스트 수신 → 대기방)
  → [대기방]  RoomState.status == WAITING
       · 방장: 게스트 입장·READY를 기다림, guestReady && guestId 있으면 START 활성화
       · 게스트: READY 토글
       (START 성공 → status STARTED 브로드캐스트 + game.started 개별 수신)
  → [게임]  phase == IN_PROGRESS  (내 역할 = PlayerView.viewer)
       · 내 차례(viewer == currentTurn)일 때만 액션 컨트롤 활성화
       · 매 수 후 game.state로 뷰 갱신
       (phase == MANHUNT → 보안관 단일 추측 반복 UI)
  → [결과]  phase == ENDED, winner 표시
       · 전적은 GET /players/{playerId}/results
```

화면 상태 = `RoomState.status`(WAITING/STARTED) + `PlayerView.phase`(IN_PROGRESS/MANHUNT/ENDED)의 조합으로 결정한다.

---

## 9. 게임 화면 UI 가이드 (관점별)

`RULES.md`의 규칙을 UI로 옮길 때의 요점. **역할은 `PlayerView.viewer`로 판단**한다.

### 공통
- **은신처 사슬(board)**: `board[]`를 왼→오로 배치. 각 칸은 `HideoutView`.
  - `number` 있으면 그 번호를 앞면으로, **없으면(보안관의 비공개 은신처)** 뒷면 카드로 렌더(“?”). `revealed:true`면 공개 표시.
  - `sprintCount > 0`이면 그 칸 밑에 스프린트 카드 더미(장수만큼)를 표현. 도망자/공개된 칸은 `sprintCards`로 실제 카드도 보여줄 수 있다.
- **덱 3개**: `deck1Count/deck2Count/deck3Count`를 카드 뒷면 더미 + 숫자로. (내용은 아무도 못 본다.)
- **차례 표시**: `currentTurn`. `viewer === currentTurn`이면 “내 차례”.
- **상대 손패**: `opponentHandSize`장짜리 뒷면 더미로만(내용 없음).

### 도망자(FUGITIVE) 화면
- **내 손패**(`hand`)를 앞면으로. 여기서 놓을 은신처·스프린트 카드를 고른다.
- 내 차례 액션:
  1. (첫 턴이 아니면) **드로우**: 덱1/2/3 중 하나 선택 → `DRAW_CARD`.
  2. **은신처 놓기**: 손패에서 카드 1장 선택(직전 은신처보다 커야; 기본 +1~+3, 스프린트 카드를 더 깔면 그만큼 간격↑) + 선택한 스프린트 카드들 → `PLACE_HIDEOUT`. **간격/오름차순을 UI에서 미리 제약**하면 `NOT_ASCENDING`/`GAP_EXCEEDED`를 예방.
  3. 또는 **패스**(`PASS`).
- **42를 놓으면 탈출 시도** — 특별 강조(승패가 갈림).

### 보안관(MARSHAL) 화면
- 손패는 없다(`hand` 항상 `[]`). 대신 **추리 보조**: 덱 잔여 수·공개된 은신처·상대 손패 장수를 단서로.
- 내 차례 액션:
  1. (첫 턴은 2장, 이후 1장) **드로우**: 덱 선택 → `DRAW_CARD`. (덱에서 사라진 번호 = 도망자가 못 쓰는 번호 → 추리 단서)
  2. **추측**: board의 비공개 칸 위치를 고르고 번호를 지목 → `GUESS`. 여러 칸을 한 번에 지목할 수 있으나 **하나라도 틀리면 전부 무효**(all-or-nothing)임을 UI로 경고.
- **맨헌트(phase == MANHUNT)**: 도망자가 42로 탈출을 시도했고 조건이 맞아 최후 추격에 들어간 상태. **한 번에 한 칸씩** 지목(`MANHUNT_GUESS`), 맞히면 계속, 틀리면 즉시 패배. 긴장감 있는 단일-지목 UI로.

### 결과 화면
- `phase == ENDED` + `winner`로 승/패 표시. 전적 목록(`/players/{playerId}/results`) 링크.

---

## 10. 현재 백엔드의 제약 (프론트가 알아야 할 것)

이 백엔드는 반복적으로 구축 중이다. **아직 없는 것**을 UI에서 기대하지 마라:

1. **인증 없음.** `playerId`는 신뢰 기반(MVP). 로그인 화면 대신 닉네임 입력 정도로.
2. **방 목록/검색 없음.** 입장은 **roomId(코드) 공유 방식만**. 방장이 받은 `roomId`를 상대에게 복사/공유하는 UI가 필요(예: 초대 코드 표시·복사 버튼).
3. **방 취소/나가기/상대 이탈 처리 없음**(다음 반복 예정). 게임 도중 이탈·몰수·방 정리 흐름은 아직 서버에 없으니, UI에서 그 버튼을 만들되 동작은 “아직 미지원”으로 두거나 최소화.
4. **로컬 백엔드 실행에 Redis 필요.** 개발 시 `docker run -p 6379:6379 redis:7` 후 `./gradlew bootRun`. (프론트 개발자에게 안내.)
5. **⚠️ 같은 세션의 연속 메시지 순서가 보장되지 않는다.** 예: 게스트가 `join` 직후 곧바로 `ready`를 쏘면 서버가 순서를 뒤집어 처리해 `GUEST_NOT_PRESENT`가 날 수 있다.
   → **의존적인 액션은 앞 단계의 브로드캐스트를 확인한 뒤 보내라.** 구체적으로: `join`을 보냈으면 `/topic/room/{roomId}`로 **내가 게스트로 들어간 RoomState를 받은 뒤** `ready`를 보낸다. 마찬가지로 START는 `guestReady:true` 상태를 확인한 뒤 활성화. (이러면 자연스러운 UX이자 이 이슈의 회피책이 된다.)
6. **`board`는 `Card[]`가 아니라 `HideoutView[]`**다(§4-2). 계약서 일부 예시가 옛 형태로 남아 있을 수 있으니, **이 문서의 shape을 신뢰**하라.

---

## 11. 최소 통합 체크리스트

- [ ] `@stomp/stompjs`로 `ws://<host>/ws` 접속, `connectHeaders.playerId` 세팅
- [ ] `onConnect`에서 `/user/queue/{room.created,errors,game.started,game.state}` 구독
- [ ] 방 만들기(`/app/room/create`) → `room.created`에서 `roomId` 수신 → `/topic/room/{roomId}` 구독
- [ ] roomId로 입장(`/app/room/join`) → RoomState 수신 후 READY(`/app/room/ready`)
- [ ] 방장 START(`/app/room/start`) → `game.started`(내 관점 PlayerView)로 게임 화면 진입
- [ ] `PlayerView.viewer`로 내 역할 판별, `currentTurn`으로 내 차례 판별
- [ ] 수 두기(`/app/game/{roomId}/move`, §5) → `game.state`로 뷰 갱신
- [ ] `/user/queue/errors` 구독해 실패 처리(§6)
- [ ] `phase == ENDED` + `winner`로 결과 화면
- [ ] 재접속: 같은 playerId 접속 + `GET /rooms/{roomId}` + `GET /rooms/{roomId}/game?playerId=`로 복구
- [ ] 정보 유출 주의: 받은 뷰만 렌더, 마스킹된(number 없는) 은신처는 뒷면으로

---

**요약:** 서버가 관점별로 안전하게 필터링해 보내주므로, 프론트의 핵심 일은 (1) 올바른 목적지 구독/발행,
(2) `viewer`/`currentTurn`/`phase`에 따른 화면 전환, (3) 받은 `PlayerView`/`RoomState`를 그대로 그리는 것,
(4) 에러·재접속 처리다. 규칙 판정은 전부 서버가 한다 — 프론트는 UI 제약으로 사용자를 돕되 최종 검증은 서버에 맡겨라.
