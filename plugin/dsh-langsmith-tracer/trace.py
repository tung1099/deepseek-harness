#!/usr/bin/env python3
"""Print DSH traces from LangSmith as a tree.

Usage:
  LANGSMITH_API_KEY=... python3 trace.py                 # list the 10 latest turns
  LANGSMITH_API_KEY=... python3 trace.py latest          # tree of the latest turn
  LANGSMITH_API_KEY=... python3 trace.py <trace-id>      # tree of one trace
  options: --project NAME (default deepseek-harness), --limit N, --full (no truncation), --json FILE (save raw runs)
"""
import argparse, json, os, sys, urllib.request
from datetime import datetime

API = os.environ.get('LANGSMITH_ENDPOINT', 'https://api.smith.langchain.com').rstrip('/') + '/api/v1'


def call(path, body=None):
    key = os.environ.get('LANGSMITH_API_KEY')
    if not key:
        sys.exit('LANGSMITH_API_KEY is not set')
    req = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'x-api-key': key, 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def project_id(name):
    found = call(f'/sessions?name={urllib.request.quote(name)}')
    if not found:
        sys.exit(f'project "{name}" not found')
    return found[0]['id']


def roots(pid, limit):
    return call('/runs/query', {'session': [pid], 'is_root': True, 'limit': limit,
                                'select': ['id', 'name', 'start_time', 'end_time', 'tags', 'inputs', 'error']})['runs']


def ts(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def ms(run):
    return round((ts(run['end_time']) - ts(run['start_time'])).total_seconds() * 1000) if run.get('end_time') else None


def clip(value, n):
    text = json.dumps(value, ensure_ascii=False)
    return text if n is None or len(text) <= n else text[:n] + '…'


def show_tree(runs, full):
    n = None if full else 300
    ids = {r['id'] for r in runs}
    kids = {}
    for r in runs:
        kids.setdefault(r.get('parent_run_id') if r.get('parent_run_id') in ids else None, []).append(r)
    t0 = min(ts(r['start_time']) for r in runs)

    def walk(r, depth):
        pad = '  ' * depth
        md = (r.get('extra') or {}).get('metadata', {})
        at = round((ts(r['start_time']) - t0).total_seconds() * 1000)
        err = f"  ERROR: {r['error'][:200]}" if r.get('error') else ''
        print(f"{pad}- [{r['run_type']}] {r['name']}  +{at}ms  {ms(r)}ms{err}")
        name, kind = r['name'], r['run_type']
        if depth == 0:
            print(f"{pad}    tags: {r.get('tags')}")
            print(f"{pad}    input: {clip((r.get('inputs') or {}).get('input'), n)}")
            keep = {k: v for k, v in md.items() if not k.startswith(('LANGSMITH', 'revision', 'ls_run')) and k != 'cwd'}
            print(f"{pad}    meta: {clip(keep, None if full else 800)}")
        elif kind == 'llm':
            out = r.get('outputs') or {}
            msg = ((out.get('choices') or [{}])[0]).get('message', {})
            calls = [f"{c['function']['name']}({c['function']['arguments']})" for c in msg.get('tool_calls') or []]
            usage = out.get('usage_metadata') or {}
            stats = {k: md[k] for k in ('ttft_ms', 'finish_reason', 'context_used_pct') if k in md}
            print(f"{pad}    messages: {len((r.get('inputs') or {}).get('messages', []))}  usage: in {usage.get('input_tokens')} "
                  f"(cache {(usage.get('input_token_details') or {}).get('cache_read')}) out {usage.get('output_tokens')}  {stats}")
            if calls:
                print(f"{pad}    tool_calls: {clip(calls, n)}")
            if msg.get('content'):
                print(f"{pad}    text: {clip(msg['content'], n)}")
        elif kind == 'tool':
            print(f"{pad}    args: {clip(r.get('inputs'), n)}")
            print(f"{pad}    result: {clip((r.get('outputs') or {}).get('output'), n)}")
        elif not name.startswith('step'):
            if r.get('inputs'):
                print(f"{pad}    in:  {clip(r['inputs'], n)}")
            if r.get('outputs'):
                print(f"{pad}    out: {clip(r['outputs'], n)}")
        for child in sorted(kids.get(r['id'], []), key=lambda x: x['start_time']):
            walk(child, depth + 1)

    for root in kids.get(None, []):
        walk(root, 0)


def main():
    p = argparse.ArgumentParser(description='Print DSH traces from LangSmith')
    p.add_argument('target', nargs='?', help='"latest" or a trace id; omit to list recent turns')
    p.add_argument('--project', default=os.environ.get('LANGSMITH_PROJECT', 'deepseek-harness'))
    p.add_argument('--limit', type=int, default=10)
    p.add_argument('--full', action='store_true')
    p.add_argument('--json', metavar='FILE')
    a = p.parse_args()

    if a.target is None:
        for r in roots(project_id(a.project), a.limit):
            text = ((r.get('inputs') or {}).get('input') or (r.get('inputs') or {}).get('event') or '').replace('\n', ' ')
            print(f"{r['id']}  {r['start_time'][:19]}  {ms(r) or '?':>6}ms  {r['name']:<9} {text[:60]}  {[t for t in r.get('tags') or [] if t != 'dsh']}")
        return
    trace = a.target
    if trace == 'latest':
        latest = [r for r in roots(project_id(a.project), 10) if r['name'] == 'dsh-turn']
        if not latest:
            sys.exit('no dsh-turn traces yet')
        trace = latest[0]['id']
    runs = call('/runs/query', {'trace': trace, 'limit': 100})['runs']
    if not runs:
        sys.exit(f'trace {trace} has no runs (it may still be uploading)')
    if a.json:
        with open(a.json, 'w', encoding='utf8') as f:
            json.dump({'runs': runs}, f, ensure_ascii=False, indent=1)
    print(f'trace {trace}  ({len(runs)} runs)')
    show_tree(runs, a.full)


if __name__ == '__main__':
    main()
