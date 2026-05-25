# feat/project-isolation 브랜치 변경 내역

`feat/project-isolation` 브랜치에서 직접 구현한 변경 사항 정리.

---

## 1. 개요: 어떤 문제를 해결했나

**문제:** 같은 agentmemory 서버에 여러 프로젝트(레포)가 메모리를 저장할 때, `memory_save`로 저장한 항목이 프로젝트 경계 없이 섞여서 검색됐다.

기존에는 Session-based 격리만 존재했다. 관찰(Observation)은 세션에 묶여 있어서 project 필터가 적용됐지만, `memory_save`로 저장되는 **Memory 레코드 자체에는 project 필드가 없었다**. 그래서 `mem::remember`로 기록된 장기 기억은 어떤 프로젝트에서 검색하든 모두 노출됐다.

**해결:** Memory 타입에 `project` 필드를 추가하고, MCP 핸들러가 호출 시 자동으로 project를 주입하도록 연결했다. 더불어 프로젝트 경계를 넘어 검색할 수 있는 `memory_recall_global` 도구를 새로 추가했다.

**커밋 범위:** 10개 커밋 (`99e539b` ~ `9352e0e`), 1,077줄 추가

---

## 2. 변경 전 vs 변경 후

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| Memory 타입 | `project` 필드 없음 | `project?: string` 추가 |
| memory_save | project 정보 없이 저장 | sessionId → resolveProject → Memory에 project 자동 태깅 |
| memory_recall / smart_search | 전체 Memory 검색 | sessionId로 project 결정 후 필터링 |
| 전역 검색 | 방법 없음 | `memory_recall_global` 도구로 가능 |
| 레거시 Memory | — | `project = undefined`이면 모든 project 필터 통과 (하위 호환) |

---

## 3. 구현 상세

### 3.1 Memory 타입 확장 (`src/types.ts:91`)

```typescript
export interface Memory {
  // ...
  sessionIds: string[];
  project?: string;   // ← 추가. optional = 레거시 메모리 하위 호환
  strength: number;
  // ...
}
```

`project`를 optional(`?`)로 선언한 이유: 기존에 저장된 Memory에는 이 필드가 없다. 필터링 로직에서 `project === undefined`인 메모리는 "레거시 공용 메모리"로 취급해 **어떤 project 검색에서도 통과**하도록 설계했다. 마이그레이션 없이 기존 데이터를 유지할 수 있다.

### 3.2 resolveProject 헬퍼 신설 (`src/mcp/resolve-project.ts`)

sessionId를 받아 해당 세션의 project를 반환하는 단일 책임 헬퍼.

```typescript
export async function resolveProject(
  sessionId: string | undefined,
  kv: StateKV,
): Promise<string> {
  if (!sessionId) return "default";
  const session = await kv.get<Session>(KV.sessions, sessionId);
  if (!session) return "default";
  return session.project || "default";
}
```

**폴백 체계:**
1. `sessionId`가 없거나 빈 문자열 → `"default"`
2. 세션 조회 실패 → `"default"`
3. `session.project`가 빈 문자열 → `"default"`

server.ts 호출부에서는 `asNonEmptyString(args.sessionId)`로 빈 문자열을 `undefined`로 변환한 뒤 전달한다.

### 3.3 MCP 핸들러 3개에 project 자동 주입 (`src/mcp/server.ts`)

`memory_save`, `memory_recall`, `memory_smart_search` 세 핸들러에 동일한 패턴 적용:

```typescript
// memory_save 핸들러 예시 (server.ts:179 일대)
const sessionId = asNonEmptyString(args.sessionId);
const project = await resolveProject(sessionId, kv);
// ...
await sdk.trigger("mem::remember", { content, type, ..., project });
```

세 도구 모두 tools-registry.ts에 `sessionId` 입력 파라미터가 추가됐다. 에이전트가 `sessionId`를 전달하면 project가 자동 결정되고, 전달하지 않으면 `"default"` project로 저장된다.

### 3.4 검색 필터링 추가 (`src/functions/search.ts:343-363`, `smart-search.ts:97-122`)

기존 검색은 세션-기반 필터만 있었다. 여기에 **Memory.project 직접 필터링** 분기를 추가했다:

```
후보 observation 루프:
    세션이 있는 경우 → 기존대로 session.project/cwd 매칭
    세션이 없는 경우 (mem::remember 직접 저장) →
        KV.memories에서 Memory 직접 로드
        → mem.project === target_project? 통과
        → mem.project === undefined? 레거시로 통과
        → 그 외 → 스킵
```

`smart-search.ts`에서는 `HybridSearchResult` 단위로 동일 로직을 `Promise.all` 병렬 적용한다.

### 3.5 memory_recall_global 신규 도구 (`src/mcp/tools-registry.ts:221`, `src/mcp/server.ts:1254`)

프로젝트 격리를 **명시적으로 우회**하는 전역 검색 도구.

**입력 파라미터:**
- `query` (필수)
- `limit` (기본 10)
- `projects` — 콤마로 구분된 프로젝트 경로 목록 (생략 시 전체)

**동작:**

```
projects 없음:
    mem::smart-search를 project 필터 없이 1회 호출 → 결과 그대로 반환

projects = "A,B,C":
    각 project마다 Promise.all로 mem::smart-search 병렬 호출
    결과 합산 후 obsId 기준 dedupe
    → 같은 obsId가 여러 project에서 나오면 score가 높은 것만 유지
    → score 내림차순 정렬 → limit 절단
    → compact 포맷으로 반환
```

---

## 4. 테스트 커버리지

| 테스트 파일 | 검증 내용 |
|-------------|-----------|
| `test/memory-project-field.test.ts` | `Memory` 타입이 `project` 유/무 모두 TypeScript·런타임에서 허용되는지 |
| `test/resolve-project.test.ts` | sessionId 없음 / 세션 없음 / `session.project` 빈 문자열 / 정상 — 모두 `"default"` fallback 포함 검증 |
| `test/remember-project.test.ts` | `mem::remember`가 `project`를 Memory에 영속화하는지, 여러 프로젝트가 격리되는지 |
| `test/search-memory-project-filter.test.ts` | 세션 있는 경우 vs `Memory.project` 직접 lookup, `undefined` legacy 통과, cwd 필터 skip 종합 검증 |
| `test/memory-recall-global.test.ts` | 400 응답(query 없음), `projects` 미지정 시 단일 호출, 병렬 호출 + obsId dedupe + 최고 score 유지 |

---

## 5. README 갱신

배지 alt 텍스트와 설명 문구 3곳에서 `53 MCP tools` → `54 MCP tools`로 수정했다.

- `README.md:46` — 상단 배지 텍스트
- `README.md:415` — Claude Code 설치 안내 블록
- `README.md:819` — MCP Server 섹션 설명

> **후속 작업 필요:** `assets/stat-tools.svg` 파일 자체는 이 브랜치에서 갱신되지 않았다. 렌더링 배지 숫자를 맞추려면 SVG도 교체해야 한다.

---

## 6. 사용 예시

### 두 프로젝트가 같은 서버를 공유하는 경우

프로젝트 A(`/Users/me/project-a`)와 프로젝트 B(`/Users/me/project-b`)가 같은 agentmemory 서버를 사용할 때:

```json
// 프로젝트 A 세션에서 저장
{ "tool": "memory_save", "arguments": {
  "content": "AuthService는 JWT를 인메모리에 캐싱한다",
  "type": "architecture",
  "sessionId": "session_A_xxx"
}}

// 프로젝트 B 세션에서 검색 → 프로젝트 A 메모리는 안 나옴
{ "tool": "memory_recall", "arguments": {
  "query": "JWT cache",
  "sessionId": "session_B_yyy"
}}
```

### 전역 검색이 필요한 경우

```json
// 전체 프로젝트에서 검색
{ "tool": "memory_recall_global", "arguments": {
  "query": "JWT cache"
}}

// 특정 두 프로젝트만 검색
{ "tool": "memory_recall_global", "arguments": {
  "query": "JWT cache",
  "projects": "/Users/me/project-a,/Users/me/project-b"
}}
```

---

## 7. Project Alias 매핑 (자동 감지 + 수동 관리)

### 7.1 배경

실 운영 환경에서 같은 프로젝트의 session.project 값이 두 가지 형식으로 혼재하는 문제가 발견됐다:

| 형식 | 예시 |
|------|------|
| 짧은 이름 (구 세션) | `E-mail`, `doridesk` |
| 절대 경로 (신규 세션) | `/Users/nhn/project/nc-notification-email` |

이 상태에서는 새 세션에서 `memory_recall`을 호출해도 구 세션의 메모리가 검색되지 않는다.

### 7.2 두 계층 구조

| 파일 | 역할 |
|------|------|
| `~/.agentmemory/project-aliases.json` | **Confirmed** — 확정된 alias. 검색·저장 시 OR 매칭에 항상 포함. |
| `~/.agentmemory/project-aliases-pending.json` | **Pending** — 자동 감지된 후보 페어 + 거절 이력(negative cache). |

핵심 구현: `src/mcp/project-aliases.ts`
- `resolveCanonicalProject(name)` — alias → canonical 변환. `resolveProject()` 반환 시 자동 호출.
- `expandProjectAliases(name)` — 검색 시 canonical + 모든 confirmed alias를 Set으로 확장해 OR 매칭.
- `expandWithPending(name)` — pending 후보 partner까지 포함한 확장 Set 반환.
- `isPendingProject(name)` — 이름이 pending 대기열에 있는지 여부.

통합 위치:
- `src/mcp/resolve-project.ts` — 저장 경로: session.project를 canonical로 정규화
- `src/functions/search.ts` — 검색 경로: projectAliasSet으로 확장 매칭
- `src/functions/smart-search.ts` — smart-search도 동일 패턴
- `src/mcp/server.ts` (memory_recall_global) — projects 파라미터 canonical 정규화

### 7.3 자동 감지 흐름

새 project 값이 `resolveProject()` 를 거칠 때마다 `suggestAliasIfNew(project, kv)` 가 **비동기 fire-and-forget**으로 실행된다 (응답 지연 없음). 분기 로직은 `src/mcp/project-alias-suggest.ts`.

```
새 project P 등장
├─ alias / pending / rejected 어디든 이미 알려진 값? → skip
│
├─ 기존 등록 project 후보와 Confident 신호 비교 (findConfidentMatch)
│   ├─ 표기 정규화 동일: normalizeForCompare — 소문자 + [\s\-_./]+ 제거 → 동일
│   │   예) "E-mail" ↔ "email" ↔ "EMAIL" ↔ "e_mail" 모두 매칭
│   ├─ basename 동일: 둘 다 절대경로 + path.basename 일치
│   └─ realpath 동일: 둘 다 절대경로 + fs.realpathSync 일치 (심볼릭 링크 해소)
│       → 일치 시 즉시 project-aliases.json에 자동 병합 (false positive 거의 0)
│
└─ Confident 없음 → tokenJaccard 계산 (토큰 분리: [-_/.\s])
    ≥ 0.3 → project-aliases-pending.json에 페어 적재
    < 0.3 → 아무 것도 안 함
```

### 7.4 검색 시점 Pending Union

pending에 등록된 project로 검색이 들어오면, 사용자 결정 전이라도 후보 partner까지 OR 매칭에 포함된다. 작업 흐름이 끊기지 않는다.

```typescript
// src/functions/search.ts, smart-search.ts
const projectAliasSet = new Set(
  isPendingProject(project)
    ? expandWithPending(project)     // pending 후보 partner 포함
    : expandProjectAliases(project), // confirmed alias만
);
```

Approve/Reject 후:
- **Approve** → confirmed로 이동 → 이후 `expandProjectAliases()`가 자연스럽게 포함, pending union 불필요
- **Reject** → rejected(negative cache)로 이동 → 재제안 차단, 검색은 격리 모드 복귀

### 7.5 웹 Admin UI (`:3113` Aliases 탭)

`src/viewer/index.html`에 Aliases 탭 추가. 3개 섹션:

| 섹션 | 내용 |
|------|------|
| **Confirmed Aliases** | canonical / aliases[] / Delete 버튼 |
| **Pending Suggestions** | projectA · projectB · score · signals · 감지일시 + **Approve · Reject 버튼** |
| **Recent Rejections** | 거부 이력 (디버깅용, collapsed) |

### 7.6 REST API 6개 (`src/mcp/server.ts`)

| Method · Path | 동작 |
|---|---|
| `GET /agentmemory/aliases` | confirmed 목록 |
| `POST /agentmemory/aliases` | canonical + aliases[] 추가/병합 |
| `DELETE /agentmemory/aliases/:canonical` | canonical 전체 삭제 |
| `GET /agentmemory/aliases/pending` | pending + rejected 반환 |
| `POST /agentmemory/aliases/pending/:id/approve` | pending → confirmed 이동 |
| `POST /agentmemory/aliases/pending/:id/reject` | pending → rejected 이동 |

### 7.7 수동 관리 MCP 도구 3개

에이전트가 직접 alias를 조작해야 할 때 사용.

| 도구 | 동작 |
|------|------|
| `memory_project_alias_list` | 현재 confirmed alias 목록 반환 |
| `memory_project_alias_add` | canonical + aliases[] 수동 추가/병합 |
| `memory_project_alias_remove` | canonical 전체 또는 특정 alias 제거 |

### 7.8 동작 시나리오

**Case A: 표기 차이만 (자동 confirmed)**
- 기존: `email` 등록
- 새 세션: `session.project = "Email"`
- `normalizeForCompare("Email") === normalizeForCompare("email")` → 즉시 `project-aliases.json`에 병합
- 다음 검색부터 OR 매칭, 사람 개입 불필요

**Case B: 의미 유사 (pending → 사용자 결정)**
- 기존: `Email` 등록
- 새 세션: `session.project = "/Users/nhn/project/nc-notification-email"`
- Confident 없음, Jaccard `{nc, notification, email}` vs `{email}` = 1/3 ≈ 0.33 ≥ 0.3 → pending 적재
- **즉시 효과**: `nc-notification-email` 세션의 `memory_recall`이 `Email` 메모리도 함께 반환
- 운영자가 `:3113` Aliases 탭 접속:
  - **Approve** → confirmed로 이동, 영구 OR 매칭
  - **Reject** → rejected 캐시, 재제안 차단, 격리 모드 복귀

### 7.9 테스트 커버리지

| 테스트 파일 | 검증 내용 |
|-------------|-----------|
| `test/project-aliases.test.ts` | confirmed alias 기본 동작 (기존) |
| `test/project-alias-suggest.test.ts` (신규, 12케이스) | `normalizeForCompare` 5종 표기, `tokenJaccard` 동일/무관/부분, `findConfidentMatch` normalize 신호, `suggestAliasIfNew` 자동 등록·pending 적재·중복 방지·rejected 재제안 차단, `isPendingProject`/`expandWithPending` 페어 partner |
