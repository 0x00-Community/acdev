# Bringing agentrt back to Dopame: the executor interface

For the maintainers of agentrt. It explains how Dopame runs agents today, why agentrt was taken out for now, how it can come back as an executor, and how the two sides split the work. As of 2026-11-23. The Chinese version of this page is authoritative.

**The executor interface is still internal to Dopame and will change.** When you connect by this page, go by the interface version of that time, and check the latest interface with the Dopame team first.

## 0. Terms

- **Agent harness**: everything in Dopame that runs agents: starting an agent, running a turn, providing tools, approvals, recording activity, checking results. "AM" refers to this. It runs in the Dopame back-end service.
- **Executor**: the part of the harness that talks to the model and decides which tool to call next. Today the executor is pi (`@earendil-works/pi-coding-agent`). agentrt would join as another executor.
- **Adapter**: code inside the Dopame back end that translates one executor into Dopame's internal executor interface; one per executor.
- **Tool service**: the place in the Dopame back end that provides every tool. Anything that reads or writes files, runs commands or operates the desktop is executed there; the executor only decides to call it.
- **System supervisor**: the component in the system layer (acdes) that reviews risky operations. Dopame reports operations that need approval to it.

## 1. Where things stand

### 1.1 Structure

The path of one turn:

```
caller (employee, Chief, temporary agent, app builder, web reader)
   │  Executor / Run interface (in-process TypeScript)
   ▼
adapter (only the pi adapter today)
   │  the executor's own protocol (pi: line-delimited JSON on stdin/stdout)
   ▼
executor process (pi), inside a restricted run (sandbox)
   │  Model Context Protocol (MCP) over an inherited file descriptor
   ▼
tool service (Dopame back end) ── approval, secrets, redaction, untrusted marks, plugin hooks ── tool implementations
```

Key points:

1. **Callers only know Dopame's own interface**: the executor (`Executor`), a run (`Run`), run parameters (`RunSpec`), the result of a turn (`TurnEnd`), the declared capabilities (`Caps`) and the unified events (`AgentEvent`); see section 2. No caller parses an executor's raw records.
2. **The executor has no built-in tools with side effects.** pi starts with `--no-builtin-tools`; read, write, edit, search, run commands, long-running commands, memory and desktop actions all come from the tool service. The executor calls them over MCP.
3. **Safety does not rely on the executor.** Every tool call in the tool service goes through: argument check → plugin rewrite and blocking → risk verdict → approval (ask the user or report to the system supervisor) → fill secrets → run (inside this agent's sandbox) → redaction → untrusted marking → plugin result hook.
4. **Model calls go through Dopame's model proxy.** The executor gets a proxy address on loopback and a token for this run only, never the real keys.
5. **Plugins**: memory, plugin tools and plugin hooks on agent runs (extra prompt before a turn, session start, context rewrite, before and after tool calls) go through the shared plugin interface (plugin-api) and have nothing to do with the executor.

### 1.2 Why agentrt was taken out

Before, a fixed employee tried agentrt first on every turn and fell back to pi; Chief, temporary agents and the app builder always used pi. Two paths side by side caused three problems:

- The same employee could do different things on the two paths: steering, session resume, activity records, plugin hooks, memory, secrets, long-running commands and desktop actions existed on the pi path only.
- Approvals had two rule sets: agentrt's protected categories, and Dopame's own classification with reports to the system supervisor. Keeping them consistent was hard.
- Callers had to know the details of both executors; every new executor meant changing every caller.

So we took agentrt out, kept only pi, and turned "executor" into an interface: callers only know the interface, adapters absorb the differences. The two agentrt features that matter most to users were rewritten in the Dopame back end along the same lines, independent of the executor:

- **Completion receipts**: following the intent of agentrt's receipt rules R1–R7, check the agent's answer against the tool calls it actually made in the turn.
- **Per-turn budget**: hard caps on tool calls and tokens in a turn.

agentrt's sandbox, approval categories and file history are no longer the executor's job: the sandbox belongs to the system layer's restricted runs, approvals to the tool service and the system supervisor, and file history will come with the versioned file system.

### 1.3 Where the adapter ends

| The adapter (one per executor) | The Dopame back end (same for every executor) |
| --- | --- |
| start and stop the executor process; send a turn, steer, abort, change model, new session, session name | tool implementations and registration, tools per role |
| translate the executor's raw events into unified events | approval, reports to the system supervisor, secrets, redaction, untrusted marks |
| how identity, project instructions and skills reach the executor | activity records, completion receipts, per-turn budget |
| turn off the executor's own instruction-file loading, built-in tools and confirmation prompts | model proxy and keys |
| declare `Caps` (live steering, live model change, resume, compaction, which conversation hooks it carries) | dispatching plugin hooks, memory |
| connect the executor's context-rewrite point, if any | sandbox profiles, cleaning up processes |

In one line: **the executor only talks to the model and decides which tool to call; nothing else is its job.**

## 2. What agentrt needs as an executor

We write the adapter in the Dopame back end; agentrt provides a process interface the adapter can drive. These are the requirements (in brackets: what pi does today).

### 2.1 Process and protocol

- Runs as a child process, exchanging line-delimited JSON on stdin/stdout (pi's `--mode rpc`). No specific format is required, but requests need ids and answers, and events must be distinguishable from answers.
- One process is one session of one agent and may stay up across turns; closing stdin makes it exit cleanly.
- Runs in a sandbox: Dopame decides the working directory, writable directories and network. Do not assume access to the home directory or anywhere else; write temporary files to the directory given in the environment.

### 2.2 Controlling a turn

The operations of a run (`Run`). A `Run` is one session of one agent; it is opened with run parameters: agent and session ids, the identity prompt, approved project instructions and skills, the model, the working directory, and whether to continue or start fresh.

| Operation | Requirement | pi |
| --- | --- | --- |
| send a turn | send user text; the answer only means "accepted", the real end is a separate event | `prompt` |
| end | report "turn ended" only after no more retries or compaction, with a stop reason: normal end, cancelled, error, too long, refusal; on error, say whether the model service or the executor failed | `agent_settled` |
| steer | insert text during a turn; if it cannot be inserted live, declare that and we hold it for the next turn | `steer` |
| abort | stop the current turn | `abort` |
| change model | switch to a given model; if it cannot switch live, declare that and we restart the process | `set_model` |
| new session | drop the context and start over | `new_session` |
| resume | continue the last session after a restart (optional, declare it) | `--continue` |
| session name | name the session (optional) | `set_session_name` |

What the adapter hands back when a turn ends (`TurnEnd`): the stop reason (`end_turn`, `cancelled`, `error`, `timeout`, `max_tokens`, `refusal`), the last non-empty answer of the turn, an error message, and where the error came from (the model service or the executor).

The capabilities the adapter declares for the executor (`Caps`): whether steering is inserted live or held for the next turn; whether a model change takes effect live or needs a restart; whether it can resume; whether it can compact; which conversation hooks it carries (see 2.8).

### 2.3 Events

They must translate into the unified events (`AgentEvent`):

- Assistant messages: each has an id; at least the full text when the message ends, deltas are welcome. Thinking, if any, is marked separately.
- Tool call start and end: call id, tool name, arguments; at the end, success or failure and the result.
- Usage: input and output tokens when each assistant message ends.
- Compaction: started, done or failed; the reason (automatic, manual, context overflow); tokens before and after (optional).
- Retry: attempt, maximum, error.
- Session start: new or resumed.

### 2.4 Tools

- **No tools the executor runs itself that have side effects**, or they must all be switchable off (pi: `--no-builtin-tools`). We suggest turning off read-only tools too and using the tool service's tools of the same names.
- **Tools come only from Dopame's MCP endpoint.** When Dopame starts the executor it passes an inherited file descriptor, numbered in the environment variable `ACDE_FD_TOOLS`, carrying MCP (JSON-RPC, one message per line). The executor:
  - calls `initialize` and `tools/list` once on that descriptor and hands the listed tools to the model as they are (no name prefix);
  - sends `tools/call` to call, `notifications/cancelled` to cancel;
  - hands the returned text blocks, image blocks and `isError` back to the model unchanged.
  pi does this with a thin bridge that only forwards and never decides. If agentrt can only reach MCP by path or network, tell us and we will consider bridging in the adapter.
- No approvals of its own. Approvals and asking the user happen in the tool service; an agent that needs to ask the user calls Dopame's question tool. The adapter answers "cancel" to any confirmation or choice prompt the executor raises itself.

### 2.5 Models

- Dopame gives the model service address and token: a proxy on loopback (one path per service) and a token for this run. The executor just calls it as configured and never reads keys from the user's home directory.
- At least one API style must match Dopame's model settings (OpenAI-compatible, Anthropic, Google; the proxy sets the matching auth header for each service). The exact hand-over is agreed during adaptation.

### 2.6 Prompts and instructions

- The identity prompt must be accepted as text appended to the system prompt (pi: `--append-system-prompt`).
- Dopame hands over the project instructions and skills the user has approved; **the executor's own instruction-file loading (reading `AGENTS.md` and the like from the working directory) must be switchable off**, or it bypasses the user's approval (pi: `--no-context-files`).

### 2.7 Untrusted content

Dopame marks untrusted content in the tool service from tool results; the executor need not care. But any input the executor has outside the tool service (for example its own network access) must be switchable off, or reported as tool call events so we can mark it.

### 2.8 Optional: conversation hooks

Plugins can add a prompt before each turn (`beforeAgentStart`, done in the adapter, no executor support needed) and rewrite the whole message list before each model request (`context`). The latter needs a callback that hands the message list to the host before each request; without it, declare it unsupported and that plugin hook does not apply on agentrt.

### 2.9 A minimal example

One possible wire format, for illustration only; field names can follow agentrt's existing protocol, the adapter translates:

```jsonc
// Dopame → agentrt
{"id": 1, "type": "prompt", "text": "Fill in the install section of the README"}
{"id": 2, "type": "steer", "text": "Leave the tests alone for now"}
{"id": 3, "type": "abort"}
{"id": 4, "type": "set_model", "provider": "work", "model": "large"}

// agentrt → Dopame
{"id": 1, "type": "response", "ok": true}
{"type": "message", "id": "m1", "role": "assistant", "delta": "Let me look first"}
{"type": "tool_start", "call": "c1", "tool": "read", "args": {"path": "README.md"}}
{"type": "tool_end", "call": "c1", "tool": "read", "ok": true, "result": "…"}
{"type": "usage", "input": 1820, "output": 96}
{"type": "message", "id": "m2", "role": "assistant", "text": "The install section is filled in."}
{"type": "settled", "stop": "end_turn"}
```

The tool call itself (`read`) does not run on this channel: agentrt sends `tools/call` to Dopame over MCP on `ACDE_FD_TOOLS`.

## 3. Working together

### 3.1 Asking for a new interface

When agentrt needs something Dopame does not offer yet (a new event, control operation, tool or start parameter), write a request with:

1. **What**: the name, direction (who calls whom), parameters and result.
2. **Why**: which agentrt feature needs it and what happens without it.
3. **Why the current interface is not enough**, against sections 2 and 4.
4. **An example**: a call and the expected result.
5. **Compatibility**: whether it affects the existing executor (pi).

Send it to the Dopame team (they will tell you where). We answer with one of three: add it to the executor interface, handle it in the adapter only, or not do it (with reasons).

### 3.2 How we adapt

- We write an adapter for agentrt in the Dopame back end, next to the pi adapter, implementing the same `Executor` interface and declaring its `Caps`.
- Callers do not change; when the interface needs something new, the interface and the pi adapter change together.
- Testing: unit tests drive the adapter with a scripted fake executor, then one integration turn with the real agentrt.

### 3.3 Acceptance

An executor can join when:

1. All requirements in section 2 hold: no built-in side-effect tools, tools only from the MCP endpoint, instruction-file loading can be switched off, models through the proxy.
2. An employee's turn behaves on the desktop as it does with pi: steps, activity records, completion receipts, per-turn budget, steering and aborting all work.
3. Dopame's guest checks (a fixed set of end-to-end checks) still pass with agentrt.
4. Untrusted marks and approvals: after reading a web page or MCP tool output, risky operations are still tightened and still reported.

## 4. Interfaces and versions

| Interface | Form | Stability |
| --- | --- | --- |
| executor interface: executor, run, run parameters, turn result, capabilities | in-process TypeScript in the Dopame back end, no version number | **will change**; adjusted as needed when a second executor joins, not released separately |
| unified events | same | event kinds mostly stable, fields may be added |
| tool endpoint | MCP (JSON-RPC, one per line); only `initialize`, `tools/list`, `tools/call`, `notifications/cancelled`, `ping` | **stable**, follows the MCP specification |
| tool parameters and descriptions | MCP tool descriptions (name, description, parameter schema, read-only and destructive hints) | more tools will come; existing parameters only grow |
| inherited descriptor convention | `ACDE_FD_<name>` environment variables give the descriptor numbers | stable |
| model proxy | HTTP, one path per service, per-run token | stable |
| plugin interface (plugin-api) | npm package, semantic versioning, API 0.16.0 now, compatible from 0.10.0 | versioned: incompatible changes bump the minor version with migration notes, additive changes bump the patch |

Rules:

- The executor interface is internal to the Dopame back end and not released; go by the version at the time you connect. agentrt only needs the process interface in section 2 and does not depend on these TypeScript types.
- The tool endpoint and the model proxy are the two outside channels the executor really touches; we keep them compatible and give notice before any incompatible change.
- The plugin interface follows its own versioning; each version's changes are in its release notes.
