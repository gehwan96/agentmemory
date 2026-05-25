# 핵심 개념

## 전체 흐름

에이전트가 작업하면 아래 파이프라인을 통해 메모리가 생성됩니다:

```
에이전트 작업
    │
    ▼
[Session]                ← 에이전트 실행 1회 = 세션 1개
    │
    ▼
[RawObservation]         ← 도구 호출, 프롬프트, 응답 등 원시 이벤트
    │
    │  ① AI: type 분류, importance 1-10 부여, facts/concepts 추출
    ▼
[CompressedObservation]  ← 타입화된 사실 + 서술 + 연관 파일
    │
    │  ② 코드: importance < 5 제거, 같은 concept 3회 미만 그룹 제외
    │  ③ AI: 살아남은 관찰들을 하나의 장기 기억으로 통합
    ▼
[Memory]                 ← 장기 기억. 버전 관리 + 프로젝트 격리
    │
    │  ④ 코드: TTL 만료(forgetAfter) 또는 Jaccard 0.9 중복이면 자동 삭제
    ▼
[최종 저장]
```

**AI가 하는 것:** 중요도 판단, 분류, 내용 요약, 통합 시 strength 결정
**코드가 하는 것:** importance 임계값(5) 필터, 출현 빈도 기준(3회), TTL 만료, 중복 제거(Jaccard 0.9)

---

## 주요 엔티티

### Session (세션)

에이전트가 한 번 실행되는 단위입니다. 세션이 시작될 때 현재 작업 디렉토리(cwd)가 자동으로 `project` 값으로 기록됩니다.

| 필드 | 의미 |
|------|------|
| `id` | 세션 고유 ID |
| `project` | 작업 디렉토리 경로 (자동 결정) |
| `cwd` | 실제 작업 디렉토리 |
| `status` | `active` / `completed` / `abandoned` |
| `observationCount` | 이 세션에서 기록된 관찰 수 |

### CompressedObservation (압축된 관찰)

RawObservation을 AI가 분석하여 핵심만 추출한 구조입니다.

| 필드 | 의미 |
|------|------|
| `type` | 관찰 종류 (아래 목록 참고) |
| `title` | 한 줄 요약 |
| `facts` | 추출된 사실 목록 |
| `narrative` | 서술형 설명 |
| `concepts` | 관련 키워드 목록 |
| `files` | 연관 파일 경로 목록 |
| `importance` | AI가 부여한 중요도 점수 (1-10). **5 미만은 장기 메모리 후보에서 제외됨** |

관찰 타입 종류:
`file_read`, `file_write`, `file_edit`, `command_run`, `search`, `web_fetch`, `conversation`, `error`, `decision`, `discovery`, `subagent`, `notification`, `task`, `image`, `other`

### Memory (메모리)

여러 세션에 걸쳐 반복되는 패턴이나 중요한 결정을 장기 기억으로 저장한 레코드입니다. `memory_save`로 명시적으로 저장하거나, 자동 통합(consolidate) 과정에서 생성됩니다.

| 필드 | 의미 |
|------|------|
| `type` | 메모리 종류 (아래 6종) |
| `title` | 제목 |
| `content` | 내용 |
| `concepts` | 연관 키워드 |
| `files` | 연관 파일 경로 |
| `project` | 속한 프로젝트 (project isolation에 사용) |
| `strength` | 강도/신뢰도 점수 |
| `version` | 버전 번호 (supersede 시 증가) |
| `isLatest` | 현재 유효한 버전인지 여부 |
| `forgetAfter` | TTL — 이 날짜 이후 자동 만료 |

**Memory type 6종:**

| type | 저장 대상 |
|------|-----------|
| `pattern` | 반복적으로 나타나는 코딩 패턴 |
| `preference` | 에이전트/사용자의 선호나 스타일 |
| `architecture` | 시스템 구조나 설계 결정 |
| `bug` | 발견된 버그와 원인 |
| `workflow` | 작업 절차나 프로세스 |
| `fact` | 프로젝트에 관한 일반 사실 |

---

## Project Isolation (프로젝트 격리)

각 메모리와 관찰은 **project** 단위로 분리됩니다. 레포 A의 메모리가 레포 B의 검색 결과에 섞이지 않습니다.

**어떻게 project가 결정되는가:**

1. 세션 시작 시, 에이전트의 현재 작업 디렉토리(cwd)가 `session.project`로 저장됩니다. (`src/hooks/session-start.ts`)
2. `memory_save` / `memory_recall` / `memory_smart_search` 호출 시 `sessionId`를 전달하면, `resolveProject(sessionId)` 함수가 세션에서 project를 읽어옵니다. (`src/mcp/resolve-project.ts`)
3. 검색과 저장 모두 이 project로 자동 필터링됩니다.

**프로젝트 명명 비일관성 주의:**

같은 프로젝트라도 session.project가 절대 경로(`/Users/nhn/project/nc-notification-email`)로 저장된 세션과 짧은 이름(`E-mail`)으로 저장된 세션이 혼재할 수 있습니다. 이 경우 검색 필터가 둘을 다른 프로젝트로 취급하여 메모리가 누락됩니다.

**해결 방법: Project Alias 매핑**

`memory_project_alias_add` 도구로 alias 테이블을 정의하면, 검색 시 canonical 이름과 모든 alias를 동시에 매칭합니다:

```json
// E-mail과 /Users/nhn/project/nc-notification-email을 같은 프로젝트로 연결
{ "tool": "memory_project_alias_add", "arguments": {
  "canonical": "/Users/nhn/project/nc-notification-email",
  "aliases": ["E-mail", "email-service"]
}}
```

설정 후에는 어느 이름으로 검색해도 두 표기로 저장된 메모리가 모두 검색됩니다. Alias 목록은 `~/.agentmemory/project-aliases.json`에 저장됩니다.

**전역 검색이 필요하다면:**

`memory_recall_global` 도구를 사용합니다. 이 도구는 project 필터를 적용하지 않고 모든 프로젝트를 검색합니다. 특정 프로젝트 목록을 `projects` 파라미터로 전달할 수도 있습니다.

---

## Supersede (메모리 덮어쓰기)

새 메모리가 저장될 때 기존 메모리와 **Jaccard 유사도가 0.7 이상**이면, 기존 메모리를 supersede(대체)합니다:

- 기존 메모리: `isLatest = false`, `version` 유지
- 새 메모리: `version = 기존 + 1`, `supersedes = [기존 id]`, `isLatest = true`

과거 버전은 삭제되지 않고 보존됩니다.

---

## Governance & Audit (거버넌스 & 감사)

> **핵심 원칙: 구조적 삭제는 반드시 감사 로그를 남깁니다. Silent delete는 금지입니다.**

### 삭제 방법 두 가지

| 방법 | 용도 | 특징 |
|------|------|------|
| `memory_governance_delete` | 명시적·의도적 삭제 | `reason` 필드 필수. 감사 로그 자동 기록 |
| 내부 `mem::forget` | 사용자/세션 단위 임시 삭제 | 일반 삭제 |

`memory_governance_delete`는 `dryRun: true` 옵션으로 실제 삭제 없이 대상 목록을 미리 확인할 수 있습니다.

### 감사 로그 확인

```json
// memory_audit 도구 호출 예시
{ "tool": "memory_audit" }
```

각 AuditEntry는 `operation`, `timestamp`, `targetIds`, `details` 등을 기록합니다.
