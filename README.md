# pi-later

Deferred messages for [pi](https://pi.dev). Queue a prompt now, have it delivered as a normal user message once the agent is fully done.

```
/later <text>                     queue a message
/later in 10m <text>              queue, not before 10m from now
/later at 14:30 <text>            queue, not before that local time
/later at 2025-01-31 14:30 <text> queue, not before a specific date/time
/later                            open the queue (view / edit / delete / send now)
/later list                       show the queue
/later edit <n> [text]            rewrite queued message n
/later rm <n>                     drop queued message n
/later clear                      drop the whole queue
/later send                       deliver the head of the queue now (if idle)
/later help                       show help
```

Durations accept `90s`, `10m`, `2h`, `1d`, `1h30m`, and word forms (`5 min`, `2 hours`). Times use the system clock; a bare `HH:MM` means the next occurrence (today, or tomorrow if already past).

## Behaviour

- A timer only sets the *earliest* delivery time. If pi is busy when it fires, the message waits for `agent_settled`; it is never sent as a steering interruption.
- Timers live in the pi process. A message that comes due while pi is closed is delivered on the next session start.
- Delivery happens at `agent_settled`, the last boundary where pi will not continue automatically: retries, overflow recovery, compaction and queued continuations are all finished by then.
- One message is delivered per settled run, so each deferred message gets its own completed turn.
- The message is sent with `pi.sendUserMessage()`, so it looks exactly like the user typed it.
- Queue state is persisted as a custom session entry (invisible in the transcript) and restored on resume.
- A status line (`⏳ N deferred (M timed)`) and a widget show the pending queue.

## Install

```bash
pi install git:github.com/<owner>/pi-later
# or, for one invocation
pi -e ./extensions/later.ts
```

The extension can also be copied directly into `~/.pi/agent/extensions/`.

## License

MIT
