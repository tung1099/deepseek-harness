#!/usr/bin/env python3
"""Print the execution timeline of each turn in a DSH session log.

Offsets are milliseconds from that turn's `turn/start`, so one turn reads as:
model wait, stream, tool calls, next step. Tool duration is the gap between a
`tool/call` and the `tool/result` carrying the same callId; `chunk đầu` is the
first timestamp inside the assistant event's embedded stream, which is the time
to first token.

Usage:
  python3 timeline.py                 # newest session under $DSH_HOME/sessions
  python3 timeline.py <path|prefix>   # one log file, or a session-id prefix
  options: --turn N (one turn only), --all (include bookkeeping events)
"""
import argparse, glob, json, os, subprocess, sys

ROOT = os.path.join(os.environ.get('DSH_HOME', os.path.expanduser('~/.dsh')), 'sessions')
QUIET = {'agent/inbox/spliced', 'session/title-llm-request', 'session/end-seed'}


def newest(prefix=None):
    """Return the most recently written session log, optionally matching a session-id prefix."""
    files = glob.glob(os.path.join(ROOT, '*', 'session-*', 'session.v*.jsonl.zstd'))
    files += glob.glob(os.path.join(ROOT, '*', 'session-*', 'session.v*.jsonl'))
    if prefix:
        files = [f for f in files if prefix in os.path.basename(os.path.dirname(f))]
    if not files:
        sys.exit(f'no session log found under {ROOT}' + (f' matching "{prefix}"' if prefix else ''))
    return max(files, key=os.path.getmtime)


def read(path):
    """Decode one log into its header and events, stopping at a torn tail."""
    if path.endswith('.zstd'):
        out = subprocess.run(['zstdcat', '-q', path], capture_output=True).stdout.decode('utf8', 'replace')
    else:
        out = open(path, encoding='utf8').read()
    header, events = {}, []
    for line in out.splitlines():
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            break
        if row.get('type') == 'session':
            header = row
        elif 'seq' in row:
            events.append(row)
    return header, events


def first_chunk(data):
    """Timestamp of the first chunk in an embedded assistant stream, or None."""
    for chunk in data.get('stream') or []:
        at = chunk.get('time') or chunk.get('time0')
        if at:
            return at
    return None


def short(value, n=42):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= n else text[:n] + '…'


def main():
    p = argparse.ArgumentParser(description='Print per-turn execution timeline of a DSH session log')
    p.add_argument('target', nargs='?', help='log path, or part of a session id; omit for the newest')
    p.add_argument('--turn', type=int)
    p.add_argument('--all', action='store_true')
    a = p.parse_args()

    path = a.target if a.target and os.path.exists(a.target) else newest(a.target)
    header, events = read(path)
    results = {}
    for event in events:
        if event['type'] == 'tool/result':
            call = ((event.get('data') or {}).get('message') or {}).get('toolCallId')
            if call:
                results[call] = event['time']

    print(f"{os.path.basename(os.path.dirname(path))}  format v{header.get('version')}  preset={header.get('agentPreset')}  {len(events)} event")

    base, turn = None, None
    for event in events:
        kind, data, seq = event['type'], event.get('data') or {}, event['seq']
        if kind == 'turn/start':
            turn, base = data.get('turn'), event['time']
            if a.turn is not None and turn != a.turn:
                continue
            print(f"\n══ turn {turn}  (seq {seq})")
            continue
        if a.turn is not None and turn != a.turn:
            continue
        if base is None or (not a.all and kind in QUIET):
            continue
        at = event['time'] - base

        if kind == 'step/start':
            print(f"  +{at:>7}ms  ── step {data.get('step')}")
        elif kind == 'request/header':
            tools = len((data.get('header') or {}).get('tools') or [])
            print(f"  +{at:>7}ms     request/header  {tools} tool schema  ({len(json.dumps(data)):,} byte)")
        elif kind == 'user/message':
            src = (data.get('source') or {}).get('kind')
            text = ' '.join(b.get('text', '') for b in data.get('content') or [] if b.get('type') == 'text')
            print(f"  +{at:>7}ms     user [{src}]  {short(text)}")
        elif kind == 'assistant/message':
            usage, first = data.get('usage') or {}, first_chunk(data)
            cache = usage.get('cacheReadTokens', 0)
            ttft = f"chunk đầu +{first - base}ms" if first else 'không có stream'
            print(f"  +{at:>7}ms     model xong   in={usage.get('inputTokens')} cache={cache} out={usage.get('outputTokens')}  {ttft}")
        elif kind == 'assistant/attempt':
            print(f"  +{at:>7}ms     model THẤT BẠI (attempt — giữ usage, không thành message)")
        elif kind == 'tool/call':
            done = results.get(data.get('callId'))
            took = f"{done - event['time']}ms" if done else 'KHÔNG CÓ KẾT QUẢ'
            args = json.loads(data['arguments']) if isinstance(data.get('arguments'), str) else data.get('arguments')
            print(f"  +{at:>7}ms     tool {data.get('name')}  {short(args)}  → {took}")
        elif kind == 'tool/result':
            error = ((data.get('message') or {}).get('isError'))
            print(f"  +{at:>7}ms     ← kết quả{' LỖI' if error else ''} ({len(json.dumps(data, ensure_ascii=False)):,} byte)")
        elif kind == 'turn/end':
            print(f"  +{at:>7}ms  ══ turn {data.get('turn')} xong: {(data.get('reason') or {}).get('kind')}")
        elif kind.startswith('plugin:'):
            print(f"  +{at:>7}ms     plugin record {kind}  {short(data, 60)}")
        elif kind.startswith('compaction/'):
            print(f"  +{at:>7}ms     {kind}")
        elif a.all:
            print(f"  +{at:>7}ms     {kind}")


if __name__ == '__main__':
    main()
