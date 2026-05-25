# MCP 도구 사용법

## 기본 8개 vs 전체 54개

기본 설정에서는 8개의 핵심 도구만 에이전트에 노출됩니다. 전체를 사용하려면:

```dotenv
# ~/.agentmemory/.env
AGENTMEMORY_TOOLS=all
```

서버를 재시작하면 모든 도구가 활성화됩니다.

---

## 카테고리별 도구 목록

### 읽기 (검색 / 조회)

| 도구 | 설명 |
|------|------|
| `memory_recall` | 키워드 기반 검색. 이전 세션의 관찰과 메모리를 검색 |
| `memory_smart_search` | 시맨틱 + 키워드 하이브리드 검색. compact 모드로 토큰 절약 |
| `memory_recall_global` | **프로젝트 경계 없이** 전체 검색. cross-project 맥락 필요 시 사용 |
| `memory_sessions` | 최근 세션 목록 조회 |
| `memory_timeline` | 특정 시점 앞뒤 관찰 타임라인 조회 |
| `memory_file_history` | 특정 파일에 대한 과거 관찰 이력 조회 |
| `memory_patterns` | 반복 패턴 감지 |
| `memory_profile` | 프로젝트/사용자 프로필 (자주 사용하는 파일, 개념 등) |
| `memory_relations` | 메모리 관계 그래프 조회 |
| `memory_export` | 전체 메모리 데이터 JSON으로 내보내기 |
| `memory_commits` | 에이전트 세션과 연결된 git 커밋 목록 |
| `memory_commit_lookup` | 특정 git SHA와 연결된 세션 조회 |

### 쓰기 (저장)

| 도구 | 설명 |
|------|------|
| `memory_save` | 통찰, 결정, 패턴을 장기 메모리로 명시적 저장 |
| `memory_compress_file` | 마크다운 파일 압축 (.original.md 백업 생성) |

### 거버넌스 & 감사

| 도구 | 설명 |
|------|------|
| `memory_audit` | 삭제/변경 감사 로그 조회 |
| `memory_governance_delete` | reason 필수 명시 삭제. 감사 로그 자동 기록 |
| `memory_snapshot_create` | 현재 메모리 상태 스냅샷 저장 (git 버전 연동) |

### 워크플로우 (고급, `AGENTMEMORY_TOOLS=all` 필요)

멀티 에이전트 협업용 도구들입니다. 입문 단계에서는 상세 사용법이 필요하면 [DESIGN.md](../../DESIGN.md)를 참고하세요.

`memory_action_create`, `memory_frontier`, `memory_next`, `memory_lease`, `memory_routine_run`, `memory_signal_send`, `memory_signal_read`, `memory_checkpoint`, `memory_sentinel_create`, `memory_sentinel_trigger`, `memory_sketch_create`, `memory_crystallize`, `memory_mesh_sync`, `memory_team_share`, `memory_team_feed`

---

## 주요 도구 상세

### memory_save — 메모리 저장

```json
{
  "tool": "memory_save",
  "arguments": {
    "content": "AuthService는 JWT 토큰을 Redis가 아닌 인메모리 Map에 캐싱한다. 분산 환경에서는 사용 불가.",
    "type": "architecture",
    "concepts": "auth,jwt,cache",
    "files": "src/auth/auth.service.ts",
    "sessionId": "현재세션ID"
  }
}
```

- `sessionId`를 전달하면 현재 project로 자동 태깅됩니다.
- 유사한 메모리가 이미 있으면 supersede(버전 업데이트)됩니다.
- `type`은 `pattern`, `preference`, `architecture`, `bug`, `workflow`, `fact` 중 하나.

### memory_recall — 키워드 검색

```json
{
  "tool": "memory_recall",
  "arguments": {
    "query": "auth jwt cache",
    "limit": 5,
    "format": "compact",
    "sessionId": "현재세션ID"
  }
}
```

`format` 옵션:
- `full` — 전체 내용 (기본값)
- `compact` — 제목과 핵심만
- `narrative` — 서술형 요약

### memory_smart_search — 2단계 검색 (토큰 절약)

**1단계:** compact 결과로 후보 목록 확인

```json
{
  "tool": "memory_smart_search",
  "arguments": {
    "query": "인증 토큰 처리",
    "limit": 10,
    "sessionId": "현재세션ID"
  }
}
```

결과에 `obsId` 목록이 옵니다. 필요한 항목만 골라서:

**2단계:** `expandIds`로 전체 내용 조회

```json
{
  "tool": "memory_smart_search",
  "arguments": {
    "query": "인증 토큰 처리",
    "expandIds": "obs_abc123,obs_def456",
    "sessionId": "현재세션ID"
  }
}
```

`memory_recall`과의 차이: smart_search는 시맨틱(벡터) + 키워드(BM25) 하이브리드이며, 처음부터 전체 내용을 반환하지 않아 토큰을 절약합니다.

### memory_recall_global — 프로젝트 경계 없는 검색

```json
{
  "tool": "memory_recall_global",
  "arguments": {
    "query": "database connection pool",
    "limit": 10
  }
}
```

특정 프로젝트들만 검색하려면:

```json
{
  "tool": "memory_recall_global",
  "arguments": {
    "query": "database connection pool",
    "projects": "/Users/me/project-a,/Users/me/project-b"
  }
}
```

---

## 자주 하는 실수

| 실수 | 해결 |
|------|------|
| 도구가 안 보인다 | `AGENTMEMORY_TOOLS=all` 설정 후 재시작 |
| 다른 레포 메모리가 섞인다 | `sessionId`를 매 호출에 전달하는지 확인 |
| 검색 결과가 비어있다 | 서버 실행 후 첫 세션은 관찰이 없음. 세션 완료 후 재시도 |
