# 시작하기 — 설치부터 첫 동작 확인까지

## 사전 요구사항

- Node.js **≥ 20**
- npm

## 1. 서버 실행

### npm으로 전역 설치 후 실행

```bash
npm install -g @agentmemory/agentmemory
agentmemory init       # ~/.agentmemory/.env 생성
agentmemory doctor     # 환경 변수 및 설정 점검
agentmemory start      # 서버 시작
```

### npx로 바로 실행 (설치 없이)

```bash
npx @agentmemory/agentmemory
```

서버가 올라오면 두 포트가 열립니다:

| 포트 | 용도 |
|------|------|
| **:3111** | MCP 서버 + REST API |
| **:3113** | 웹 뷰어 (브라우저로 확인 가능) |

## 2. 환경 변수 설정

설정 파일 위치: `~/.agentmemory/.env`

`agentmemory init`이 템플릿을 만들어줍니다. 핵심 설정만 정리하면:

```dotenv
# AI 제공자 중 하나만 설정하면 됨 (아래 우선순위 순)
OPENAI_API_KEY=...
MINIMAX_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...

# 노출할 MCP 도구 수 (기본: 8개만 노출)
AGENTMEMORY_TOOLS=all   # 전체 54개 노출
```

> **주의**: API 키가 하나도 없어도 서버는 실행됩니다. 다만 AI 기반 관찰 압축과 시맨틱 검색이 비활성화됩니다.

## 3. 에이전트에 MCP 등록

### Claude Code (자동 등록)

```bash
agentmemory connect claude-code
# 훅까지 함께 등록하려면:
agentmemory connect claude-code --with-hooks
```

### 수동 등록 (Cursor / Cline / Windsurf 공통)

`~/.cursor/mcp.json` 또는 해당 에이전트의 MCP 설정 파일에 추가:

```json
{
  "agentmemory": {
    "command": "npx",
    "args": ["-y", "@agentmemory/mcp"],
    "env": {
      "AGENTMEMORY_URL": "http://localhost:3111"
    }
  }
}
```

원격 서버를 쓴다면 `AGENTMEMORY_SECRET`도 함께 설정합니다.

## 4. 동작 확인 체크리스트

서버를 실행한 뒤 아래를 순서대로 확인합니다:

- [ ] `http://localhost:3113` 브라우저 접속 → 웹 뷰어가 열리는가
- [ ] `agentmemory doctor` 실행 → `✓` 표시가 모두 나오는가
- [ ] 에이전트에서 `memory_sessions` 도구 호출 → 빈 목록이라도 오류 없이 반환되는가
- [ ] `AGENTMEMORY_TOOLS=all` 설정 후 재시작 → 도구 목록이 늘어났는가

## 5. 데이터가 저장되는 위치

모든 데이터는 `~/.agentmemory/` 아래에 저장됩니다. 이 디렉토리를 백업하면 메모리 전체가 보존됩니다.

자세한 저장 구조는 [04-storage.md](./04-storage.md)를 참고하세요.
