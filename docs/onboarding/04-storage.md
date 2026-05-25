# 저장소 구조

## 데이터 위치

모든 영속 데이터는 **`~/.agentmemory/`** 아래에 저장됩니다.

```
~/.agentmemory/
├── .env                    ← 환경 변수 설정
└── data/
    └── state_store.db      ← 실제 KV 저장소 (이름은 .db지만 SQLite가 아님)
```

> **주의:** `state_store.db`는 이름과 달리 **LevelDB 계열의 KV(Key-Value) 파일**입니다. SQLite처럼 SQL로 직접 쿼리할 수 없습니다.

---

## KV 네임스페이스

데이터는 네임스페이스(prefix)로 논리적으로 구분됩니다:

| 네임스페이스 | 내용 |
|-------------|------|
| `mem:sessions` | 세션 레코드 |
| `mem:obs:{sessionId}` | 특정 세션의 CompressedObservation 목록 |
| `mem:memories` | Memory(장기 기억) 레코드 |
| `mem:summaries` | 세션 요약 |
| `mem:audit` | 감사 로그 (거버넌스 삭제 이력) |
| `mem:index:bm25` | BM25 키워드 검색 인덱스 |
| `mem:emb:{obsId}` | 특정 관찰의 벡터 임베딩 |
| `mem:graph:nodes` / `mem:graph:edges` | 메모리 관계 그래프 |
| `mem:relations` | 명시적 메모리 관계 |
| `mem:profiles` | 사용자/프로젝트 프로필 |
| `mem:actions` | 멀티 에이전트 작업 큐 |
| `mem:sketches` | TTL 있는 임시 메모 |
| `mem:commits` | git 커밋 ↔ 세션 연결 정보 |

---

## 저장 기술 스택

```
MCP 도구 호출
    │
    ▼
iii-sdk (Worker/Function/Trigger 엔진)
    │
    ▼
KV 추상화 (src/state/kv.ts)
    │
    ├── 일반 데이터 → state_store.db (LevelDB 계열)
    ├── BM25 인덱스 → state_store.db (mem:index:bm25)
    └── 벡터 임베딩 → state_store.db (mem:emb:{id})
```

벡터 임베딩은 선택적 기능입니다. 환경 변수로 제공자를 지정합니다:
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` 등 → 클라우드 임베딩
- `AGENTMEMORY_LOCAL_EMBEDDINGS=true` → `@xenova/transformers` 로컬 임베딩

---

## 데이터 백업 & 이전

**전체 백업:**

```bash
cp -r ~/.agentmemory/ ~/backup/agentmemory-$(date +%Y%m%d)/
```

**다른 머신으로 이전:**

```bash
# 소스 머신
tar czf agentmemory-backup.tar.gz ~/.agentmemory/

# 대상 머신
tar xzf agentmemory-backup.tar.gz -C ~/
```

이전 후 `agentmemory doctor`로 상태를 점검합니다.

---

## 마이그레이션

```bash
npm run migrate
```

내부 스키마 변경(예: 새 필드 추가)이 있을 때 실행합니다. 일반 사용에서는 거의 필요 없으며, 버전 업그레이드 시 CHANGELOG.md를 확인하세요.

---

## 데이터 전체 내보내기

```json
{
  "tool": "memory_export",
  "arguments": {}
}
```

전체 메모리 데이터를 JSON으로 반환합니다. 대량 데이터일 경우 시간이 걸릴 수 있습니다.
