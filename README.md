# pi-later

Deferred messages for [pi](https://pi.dev). Queue a prompt now, have it delivered as a normal user message once the agent is fully done.

```
/later <text>          queue a message
/later                 open the queue (view / edit / delete / send now)
/later list            show the queue
/later edit <n> [text] rewrite queued message n
/later rm <n>          drop queued message n
/later clear           drop the whole queue
/later send            deliver the head of the queue now (if idle)
/later help            show help
```

## Behaviour

- Delivery happens at `agent_settled`, the last boundary where pi will not continue automatically: retries, overflow recovery, compaction and queued continuations are all finished by then.
- One message is delivered per settled run, so each deferred message gets its own completed turn.
- The message is sent with `pi.sendUserMessage()`, so it looks exactly like the user typed it.
- Queue state is persisted as a custom session entry (invisible in the transcript) and restored on resume.
- A status line (`⏳ N deferred`) and a widget show the pending queue.

## Install

```bash
pi install git:github.com/<owner>/pi-later
# or, for one invocation
pi -e ./extensions/later.ts
```

The extension can also be copied directly into `~/.pi/agent/extensions/`.

## License

MIT
