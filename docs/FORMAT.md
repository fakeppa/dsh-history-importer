# DSH session format (what `wb2dsh` writes)

DSH stores each session as an append-only `session.v4.jsonl.zstd` event log.
The UI derives the conversation view from this log, so the log must follow the
layout below.

## Path layout

```
<dsh-home>/sessions/<projectKey(cwd)>/<encodeSegment(session-id)>/session.v4.jsonl.zstd
```

- `projectKey(cwd)` — directory name: `/`, `\`, `:` collapse to `-`; any other
  unsafe code unit is escaped as `~XXXX` (uppercase hex); wrapped in `--…--`.
- `encodeSegment(id)` — same escape for the session directory name.
- The file must live at exactly this path; DSH derives the expected path from the
  header's `cwd` and `id` and rejects a mismatch.

## Compression framing

Zstandard **multi-frame**:

| Frame | Contents |
|---|---|
| #0 | exactly **one** JSON line — the session header, terminated by `\n` |
| #1 | the remaining event lines (JSONL) |

Each frame is produced with a checksum flag and an embedded content size. DSH
reads the header from frame #0 only, then folds the events from the remaining
frames.

## Header (frame #0)

```json
{"type":"session","version":4,"id":"session-<uuid>","createdAt":<ms>,
 "cwd":"D:\\work\\proj","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

## Event sequence (frame #1)

Preamble (once):

```
permission/preset {preset:"workspace-write"}
sandbox/mode      {mode:"workspace-write"}
session/end-seed  {}
model/selection   {provider,model}
```

Each assistant turn:

```
turn/start        {turn}
user/message      {data:{content:[blocks],source:{kind:"user",rpcId,clientTimeZone},role:"user",id}}
                  surfaceOp:"append"                       ← required on surface events
step/start        {turn,step:1}
assistant/message {data:{turn,step,message:{role:"assistant",content:[blocks],source,{id}},usage,stream}}
                  surfaceOp:"append"                       ← required
assistant/attempt {data:{turn,step,stream:[usage,finish]}}
step/end          {turn,step:1}
turn/end          {turn,reason:{kind:"completed"}}          ← reason is required
```

Trailer:

```
session/title {title,messageSeqs:[<seq of first user/message>],source:{kind:"fallback"}}
```

Every event carries a monotonically increasing `seq` and a `time` (epoch ms).
`turn/start`, `step/*`, `turn/end`, `session/title` do **not** carry `surfaceOp`;
`user/message`, `assistant/message` must.

## Content blocks

```
{type:"text",      text}
{type:"reasoning", text}
```

Tool calls and results are folded into readable `text` blocks:

```
{type:"text", text:"【调用工具 <name>】\n<json arguments>"}
{type:"text", text:"【工具结果】\n<output>"}
```

## workspace.json

`<dsh-home>/storages/workspace.json` holds the registry:

```json
{
  "unit":   {"name":"workspace","version":2},
  "global": {"initialized":true,"workspaceIds":["<wid>"],"archivedSessionIds":[],
             "pinnedSessionIds":[],"defaultWorkspaceId":"<wid>"},
  "tables": {"workspaces": {
    "<wid>": {"path":"D:\\work\\proj","title":"proj",
              "sessionIds":["session-<uuid>"],"createdAt":"…","updatedAt":"…"}
  }}
}
```

- `wid = uuid5("cwd:" + cwd)`.
- `sessionIds` entries use the `session-` prefix.

## Invariants recap

1. `session.v4.jsonl.zstd` at `projectKey(cwd)/encodeSegment(id)/`.
2. frame #0 = one header line; multi-frame zstd.
3. `surfaceOp:"append"` on `user/message` and `assistant/message`.
4. `turn/end` always carries `reason:{kind:"completed"}`.
5. Session registered under its workspace's `sessionIds`.
