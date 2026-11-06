#!/usr/bin/env python3
"""Follow a DSH session log live while you chat (Web, TUI or headless).

Usage:
  python3 watch.py                  # follow the newest session; switch when a newer one starts
  python3 watch.py <session-id>     # follow one session (prefix is enough)
  options: --all (also print bookkeeping events), --raw (print each event as JSON), --from-start
"""
import argparse, glob, json, os, subprocess, sys, time
from datetime import datetime

ROOT = os.path.join(os.environ.get('DSH_HOME', os.path.expanduser('~/.dsh')), 'sessions')
QUIET = {'session', 'agent/assistant-stream', 'session/end-seed', 'permission/preset', 'sandbox/mode', 'approval/policy',
         'agent/inbox/spliced', 'session/title-llm-request', 'plugin:persona-switcher/catalog'}
COLOR = {'turn': '1;36', 'step': '36', 'model': '35', 'tool': '32', 'error': '31', 'dim': '2'}


def paint(kind, text):
    return f'\033[{COLOR[kind]}m{text}\033[0m' if sys.stdout.isatty() else text


def newest(prefix=None):
    files = glob.glob(os.path.join(ROOT, '*', 'session-*', 'session.v4.jsonl.zstd'))
    if prefix:
        files = [f for f in files if os.path.basename(os.path.dirname(f)).removeprefix('session-').startswith(prefix)]
    return max(files, key=os.path.getmtime) if files else None


def read_events(path):
    # The writer appends zstd frames; a frame still being written is skipped until it completes.
    out = subprocess.run(['zstdcat', '-q', path], capture_output=True).stdout.decode('utf8', 'replace')
    events = []
    for line in out.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            break
    return events


def text_of(content):
    return ' '.join(b.get('text', '') if b.get('type') == 'text' else f"[{b.get('type')}]" for b in content or [] if b.get('type') != 'reasoning').strip()


def short(value, n=160):
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    s = s.replace('\n', ' ')
    return s if len(s) <= n else s[:n] + '…'


def describe(e):
    t, d = e.get('type'), e.get('data') or {}
    if t == 'turn/start':
        return 'turn', f"══ turn {d.get('turn')} ══"
    if t == 'turn/end':
        r = d.get('reason') or {}
        return ('error' if r.get('kind') == 'error' else 'turn'), f"══ turn {d.get('turn')} end: {r.get('kind')} {short((r.get('error') or {}).get('message', ''))}"
    if t in ('step/start', 'step/end'):
        return 'step', f"── {t} {d.get('step')}"
    if t == 'request/header':
        h = d.get('header') or {}
        return 'step', f"request/header {d.get('reason')} model={(h.get('config') or {}).get('model')} tools={len(h.get('tools') or [])}"
    if t == 'request/context':
        return 'step', f"request/context window={d.get('contextWindow')} systemPromptUpdate={d.get('systemPromptUpdate')}"
    if t == 'system/message':
        return 'dim', f"system/message {len(text_of((d.get('message') or {}).get('content')))} chars"
    if t == 'developer/message':
        blocks = (d.get('message') or {}).get('content') or []
        return 'step', 'developer/message ' + ' '.join(f"{'+' if b.get('type') == 'tool-addition' else '-'}{b.get('toolName')}" for b in blocks if 'toolName' in b)
    if t == 'user/message':
        src = (d.get('source') or {}).get('kind')
        return ('turn' if src == 'user' else 'dim'), f"user/message [{src}] {short(text_of(d.get('content')))}"
    if t == 'assistant/message':
        m, u = d.get('message') or {}, d.get('usage') or {}
        calls = [f"{b.get('name')}({short(b.get('arguments'), 80)})" for b in m.get('content') or [] if b.get('type') == 'tool-call']
        usage = f"in {u.get('inputTokens')} cache {u.get('cacheReadTokens', 0)} out {u.get('outputTokens')}" if u else ''
        body = ' → ' + ', '.join(calls) if calls else ' ' + short(text_of(m.get('content')))
        return 'model', f"assistant/message [{usage}]{body}"
    if t == 'assistant/attempt':
        return 'error', 'assistant/attempt (model call failed, may retry)'
    if t == 'tool/call':
        return 'tool', f"tool/call {d.get('name')} {short(d.get('arguments'), 120)}"
    if t == 'tool/result':
        m = d.get('message') or {}
        return ('error' if m.get('isError') else 'tool'), f"tool/result {'ERROR ' if m.get('isError') else ''}{short(text_of(m.get('content')))}"
    if t.startswith('approval/'):
        return 'tool', f"{t} {d.get('toolName', '')} {d.get('outcome', '')}"
    if t.startswith('command/'):
        return 'step', f"{t} /{d.get('name', '')}{d.get('args', '')} {d.get('kind', '')}"
    if t.startswith('compaction/'):
        return 'step', t + (f" error={d['error']}" if d.get('error') else '')
    return 'dim', f"{t} {short(d, 120)}"


def main():
    p = argparse.ArgumentParser(description='Follow a DSH session log live')
    p.add_argument('session', nargs='?')
    p.add_argument('--all', action='store_true')
    p.add_argument('--raw', action='store_true')
    p.add_argument('--from-start', action='store_true')
    p.add_argument('--interval', type=float, default=0.7)
    a = p.parse_args()

    path, seen, mtime = None, 0, 0
    while True:
        target = newest(a.session)
        if target and target != path:
            path, mtime = target, 0
            seen = 0 if a.from_start or path is None else len(read_events(path))
            print(paint('dim', f"watching {os.path.basename(os.path.dirname(path))}  (Ctrl+C to stop)"), flush=True)
            if a.from_start:
                seen = 0
        if path and os.path.getmtime(path) != mtime:
            mtime = os.path.getmtime(path)
            events = read_events(path)
            for e in events[seen:]:
                if 'type' not in e or (not a.all and e['type'] in QUIET):
                    continue
                if a.raw:
                    print(json.dumps(e, ensure_ascii=False), flush=True)
                    continue
                kind, text = describe(e)
                at = datetime.fromtimestamp(e['time'] / 1000).strftime('%H:%M:%S.%f')[:-3] if isinstance(e.get('time'), (int, float)) else '            '
                print(f"{paint('dim', at)} {paint('dim', str(e.get('seq', '')).rjust(4))} {paint(kind, text)}", flush=True)
            seen = len(events)
        time.sleep(a.interval)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
