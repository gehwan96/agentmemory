# 개발 워크플로우

## 명령어 목록

| 명령 | 동작 |
|------|------|
| `npm run dev` | tsx로 빌드 없이 바로 실행 (`src/index.ts`) |
| `npm run build` | tsdown으로 `dist/`에 번들 출력 |
| `npm start` | 빌드된 결과 실행 (`dist/cli.mjs`) |
| `npm test` | vitest 단위 테스트 실행 (integration 제외) |
| `npm run test:watch` | 파일 변경 시 테스트 자동 재실행 |
| `npm run test:integration` | integration 테스트만 실행 |
| `npm run test:all` | 전체 테스트 (unit + integration) |
| `npm run migrate` | DB 스키마 마이그레이션 |
| `npm run bench:load` | 100k 메모리 부하 테스트 |

---

## 개발 중 서버 실행

```bash
npm run dev
```

TypeScript를 빌드 없이 `tsx`로 직접 실행합니다. 코드 변경 후 서버를 재시작하면 됩니다.

---

## 테스트 구조

```
test/
├── *.test.ts          ← 단위/통합 테스트 (flat 구조)
├── integration.test.ts         ← npm test에서 제외됨
├── integration-plaintext-http.test.ts
└── fixtures/
    └── jsonl/         ← 테스트용 픽스처 데이터
```

- **단위 테스트**: `npm test` (integration 파일 제외)
- **통합 테스트**: `npm run test:integration`
- **모든 테스트**: `npm run test:all`

테스트는 `node:os.tmpdir()` + `mkdtempSync`로 임시 디렉토리를 생성하여 각 테스트를 격리합니다. 실제 `~/.agentmemory/`를 건드리지 않습니다.

---

## 빌드 산출물

```
dist/
├── cli.mjs            ← agentmemory CLI 바이너리
├── index.mjs          ← 메인 서버 진입점
├── mcp/standalone.mjs ← MCP standalone 서버
└── hooks/             ← 에이전트별 훅 스크립트
```

---

## 린트 & 포맷터

이 레포에는 **ESLint, Prettier, Biome 등의 린터/포맷터가 없습니다.**
품질 게이트는 TypeScript strict 모드 + vitest로만 동작합니다.

```bash
# 타입 오류 확인
npx tsc --noEmit
```

---

## CI

GitHub Actions (`.github/workflows/ci.yml`):

| 환경 | Node |
|------|------|
| ubuntu-latest | 20, 22 |
| macos-latest | 20, 22 |

파이프라인 순서:
1. `npm ci`
2. `npm run build`
3. `npm test` (unit 테스트)

---

## 기능 하나 추가하는 흐름

1. `src/functions/`에 새 함수 파일 작성
2. `src/mcp/tools-registry.ts`에 도구 정의 추가 (이름, description, inputSchema)
3. `src/mcp/server.ts`에 핸들러 등록
4. `test/` 아래 `*.test.ts` 파일 작성
5. `npm test` 실행 → 통과 확인
6. PR 제출 전 `AGENTS.md`의 일관성 규칙 점검

> **AGENTS.md 확인 필수**: 삭제 로직을 추가할 때 반드시 `recordAudit()`을 호출해야 합니다. Silent delete는 허용되지 않습니다.
