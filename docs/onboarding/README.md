# agentmemory 입문 가이드

AI 코딩 에이전트(Claude Code, Cursor, Codex 등)에게 **세션 간 영속적 메모리**를 제공하는 시스템입니다.

## 문서 읽는 순서

| 순서 | 문서 | 내용 |
|------|------|------|
| 1 | [01-getting-started.md](./01-getting-started.md) | 설치, 서버 실행, MCP 등록, 첫 동작 확인 |
| 2 | [02-core-concepts.md](./02-core-concepts.md) | Session → Observation → Memory 파이프라인, project isolation, 거버넌스 |
| 3 | [essential-takeaways.html](./essential-takeaways.html) | 처음 읽을 때 꼭 알아야 할 핵심 10가지 요약 |
| 4 | [03-mcp-tools.md](./03-mcp-tools.md) | 도구 카탈로그, 주요 도구 사용법 및 예시 |
| 5 | [04-storage.md](./04-storage.md) | 데이터 저장 구조, KV 네임스페이스, 백업 |
| 6 | [05-development.md](./05-development.md) | 빌드/테스트/CI, 코드 기여 방법 |
| — | [06-project-isolation-changes.md](./06-project-isolation-changes.md) | `feat/project-isolation` 브랜치 구현 내역 (Memory.project 필드, resolveProject, memory_recall_global) |
| — | [pipeline-deep-dive.html](./pipeline-deep-dive.html) | 실제 설정 기준 파이프라인 상세 분석 |
| — | [limitations.html](./limitations.html) | 운영상 한계와 주의점 정리 |

## 한 줄 요약

에이전트가 작업하면서 발생한 이벤트(파일 읽기, 명령 실행, 결정 등)를 자동으로 관찰하고 압축하여 장기 메모리로 저장합니다. 다음 세션에서 관련 기억을 다시 꺼내 씁니다.

## 아직 이 문서에 없는 것

고급 기능(멀티 에이전트 워크큐, Sentinel, Sketch, Mesh 등)은 루트의 [DESIGN.md](../../DESIGN.md)를 참고하세요.
