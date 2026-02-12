# Plan: Migration from Claude to Gemini (using Google ADK)

This document outlines the plan for migrating NanoClaw from Anthropic's Claude to Google's Gemini service, utilizing the **Google Agent Development Kit (@google/adk)**. The application's identity will be updated to **Maxwell**.

## 1. Feasibility Assessment
The migration is feasible and simplified by using `@google/adk`. This library provides the high-level agent orchestration (tool loop, memory management, MCP support) that effectively replaces `@anthropic-ai/claude-agent-sdk`.

## 2. Phase 1: Environment & Dependencies

### 1.1 Update Host Runner (`src/container-runner.ts`)
- **API Keys:** Update environment variable filtering to pass `GOOGLE_API_KEY` or `GEMINI_API_KEY` to the container.
- **Memory Files:** Update logic to mount and prioritize `MAXWELL.md` files for context.
- **Configuration:** Remove Claude-specific settings generation (e.g., `.claude/settings.json`).

### 1.2 Update Agent Dependencies (`container/agent-runner/package.json`)
- **Remove:** `@anthropic-ai/claude-agent-sdk`.
- **Add:** `@google/adk` (and its peer dependencies like `@google/genai` or `@google/generative-ai`).
- **Ensure:** `@modelcontextprotocol/sdk` compatibility.

### 1.3 Docker Environment (`container/Dockerfile`)
- Remove `@anthropic-ai/claude-code`.
- Ensure Node.js version is compatible with `@google/adk` (requires modern Node.js, e.g., v20+).

## 3. Phase 2: Agent Runner Rewrite (`container/agent-runner/src/index.ts`)

### 2.1 Initialization
- Import `LlmAgent`, `FunctionTool`, and model configuration from `@google/adk`.
- Initialize the agent with the Gemini model (e.g., `gemini-1.5-pro`).
- Load system instructions from `MAXWELL.md`.
- Set the agent's identity and persona to **Maxwell**.

### 2.2 Tool Implementation
- **Filesystem & Bash:** Wrap local Node.js operations (`fs`, `child_process`) as `FunctionTool` instances with Zod schemas.
- **MCP Integration:**
    - Spawn the existing `ipc-mcp-stdio.ts` server.
    - Use `@google/adk`'s MCP support (or wrap the MCP Client as tools) to expose `send_message` and `schedule_task` to the agent.

### 2.3 The Agent Loop
- Replace the manual `query()` loop with the ADK's runner (e.g., `agent.run()` or similar orchestration method).
- Maintain the existing input/output protocol (`---NANOCLAW_OUTPUT_START---`) to communicate with the host process.
- Map ADK events/results to the container output format.

### 2.4 History & Persistence
- Manage conversation history using ADK's memory features or manually persist history to the mounted group directory if required by container lifecycles.

## 4. Phase 3: Cleanup & Branding

### 3.1 Documentation & Context
- Rename all `CLAUDE.md` files to `MAXWELL.md` throughout the project.
- Update `README.md`, `SPEC.md`, and `SECURITY.md`.
- Update all occurrences of the trigger word and identity from "@Andy" and "Andy" to "@Maxwell" and "Maxwell".
- Update internal logging and identity labels to **Maxwell**.

## 5. Verification
- Verify basic chat and context retention.
- Verify tool execution (Filesystem, Bash).
- Verify MCP tool routing (WhatsApp messaging).