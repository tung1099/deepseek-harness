#!/usr/bin/env python3
"""Compare a DSH turn trace against another agent's trace from LangSmith.

Both traces come from one LangSmith account (one API key) in two projects. Each
run tree is reduced to the same canonical flow -- the LLM and tool runs in start
order, grouped into iterations by LLM call -- so a DSH `dsh-turn/step/llm/tool`
tree and a framework tree (LangGraph nodes, AgentExecutor steps) become
comparable without either side's naming.

Usage:
  LANGSMITH_API_KEY=... python3 compare.py --projects deepseek-harness my-agent
  LANGSMITH_API_KEY=... python3 compare.py --projects a b --traces <id-a> <id-b>
  options: --limit N (roots scanned per project), --root-name NAME[,NAME]
           --json FILE (normalized flows + metrics), --flow (print every step)

Exit status is 0 even when the flows differ; this is a report, not a gate.
"""
import argparse, json, os, sys, time, urllib.error, urllib.parse, urllib.request
from collections import Counter
from datetime import datetime

def load_env():
    """Fill LANGSMITH_* from the repository root `.env` without overriding real environment variables."""
    env = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.env')
    try:
        text = open(env, encoding='utf8').read()
    except OSError as error:  # no .env checked out; the environment is the only source
        del error
        return
    for line in text.splitlines():
        key, _, value = line.partition('=')
        key = key.strip()
        if key.startswith('LANGSMITH_') and key not in os.environ:
            os.environ[key] = value.strip().strip('\'"')


load_env()
API = os.environ.get('LANGSMITH_ENDPOINT', 'https://api.smith.langchain.com').rstrip('/') + '/api/v1'


def call(path, body=None):
    """POST `body` (or GET when None) to the LangSmith API and return parsed JSON."""
    key = os.environ.get('LANGSMITH_API_KEY')
    if not key:
        sys.exit('LANGSMITH_API_KEY is not set')
    req = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'x-api-key': key, 'content-type': 'application/json'})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.load(res)
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < 4:
                time.sleep(2 ** attempt)
                continue
            sys.exit(f'LangSmith {error.code} on {path}: {error.read().decode("utf8", "replace")[:500]}')


def project_id(name):
    """Resolve a LangSmith project name to its id, exiting with the known names on a miss."""
    found = call('/sessions?name=' + urllib.parse.quote(name))
    if not found:
        names = [p['name'] for p in call('/sessions?limit=100')]
        sys.exit(f'project "{name}" not found; available: {", ".join(sorted(names))}')
    return found[0]['id']


def latest_root(pid, limit, wanted):
    """Return the newest root run in a project, optionally restricted to `wanted` names."""
    runs = call('/runs/query', {'session': [pid], 'is_root': True, 'limit': min(limit, 100),
                                'select': ['id', 'name', 'start_time', 'end_time', 'trace_id', 'error']})['runs']
    if wanted:
        runs = [r for r in runs if r['name'] in wanted]
    if not runs:
        sys.exit(f'no matching root run in project {pid}' + (f' (names {wanted})' if wanted else ''))
    newest = max(runs, key=lambda r: r['start_time'])
    return newest.get('trace_id') or newest['id']


def fetch_trace(trace):
    """Return every run in a trace, following the API cursor (one page holds at most 100 runs)."""
    runs, cursor = [], None
    while True:
        body = {'trace': trace, 'limit': 100}
        if cursor:
            body['cursor'] = cursor
        page = call('/runs/query', body)
        runs += page['runs']
        cursor = (page.get('cursors') or {}).get('next')
        if not cursor or not page['runs']:
            return runs


def ts(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def ms(run):
    """Wall time of a run in milliseconds, or None while it is still open."""
    return round((ts(run['end_time']) - ts(run['start_time'])).total_seconds() * 1000) if run.get('end_time') else None


def usage(run):
    """Token counts for an LLM run, from our tracer's usage_metadata, LangChain's token_usage, or the run columns."""
    out = run.get('outputs') or {}
    u = out.get('usage_metadata') or {}
    if u:
        details = u.get('input_token_details') or {}
        return {'input': u.get('input_tokens') or 0, 'output': u.get('output_tokens') or 0,
                'cache_read': details.get('cache_read') or 0}
    tu = ((out.get('llm_output') or {}).get('token_usage')) or (out.get('token_usage') or {})
    if tu:
        return {'input': tu.get('prompt_tokens') or 0, 'output': tu.get('completion_tokens') or 0,
                'cache_read': (tu.get('prompt_tokens_details') or {}).get('cached_tokens') or 0}
    return {'input': run.get('prompt_tokens') or 0, 'output': run.get('completion_tokens') or 0,
            'cache_read': 0}


def tool_name(run):
    """Best available name for a tool run across frameworks."""
    md = (run.get('extra') or {}).get('metadata') or {}
    return md.get('tool_name') or run['name']


def normalize(runs):
    """Reduce one run tree to the canonical flow and its metrics.

    The flow is every `llm` and `tool` run in start order. An LLM run opens an
    iteration; the tool runs after it belong to that iteration, which is how both
    an agent loop step and a LangGraph tool node read.
    """
    root = next((r for r in runs if not r.get('parent_run_id') or r['parent_run_id'] not in {x['id'] for x in runs}), runs[0])
    acts = sorted((r for r in runs if r['run_type'] in ('llm', 'tool')), key=lambda r: r['start_time'])
    t0 = ts(root['start_time'])

    steps, iteration = [], 0
    for r in acts:
        if r['run_type'] == 'llm':
            iteration += 1
        md = (r.get('extra') or {}).get('metadata') or {}
        step = {'iteration': max(iteration, 1), 'kind': r['run_type'],
                'name': md.get('ls_model_name') or r['name'] if r['run_type'] == 'llm' else tool_name(r),
                'at_ms': round((ts(r['start_time']) - t0).total_seconds() * 1000), 'ms': ms(r),
                'error': (r.get('error') or '')[:200] or None}
        if r['run_type'] == 'llm':
            step['usage'] = usage(r)
            step['ttft_ms'] = md.get('ttft_ms')
            step['finish_reason'] = md.get('finish_reason') or md.get('stop_reason')
            msg = ((((r.get('outputs') or {}).get('choices') or [{}])[0]).get('message')) or {}
            step['tool_calls'] = [c.get('function', {}).get('name') for c in msg.get('tool_calls') or []]
        steps.append(step)

    llms = [s for s in steps if s['kind'] == 'llm']
    tools = [s for s in steps if s['kind'] == 'tool']
    per_iter = Counter(s['iteration'] for s in tools)
    llm_ms = sum(s['ms'] or 0 for s in llms)
    tool_ms = sum(s['ms'] or 0 for s in tools)
    wall = ms(root) or 0
    ttfts = [s['ttft_ms'] for s in llms if s.get('ttft_ms')]

    metrics = {
        'root': root['name'], 'trace': root.get('trace_id') or root['id'], 'wall_ms': wall,
        'iterations': len(llms), 'llm_calls': len(llms), 'tool_calls': len(tools),
        'max_parallel_tools': max(per_iter.values()) if per_iter else 0,
        'tools_per_iteration': round(len(tools) / len(llms), 2) if llms else 0,
        'runs_total': len(runs), 'run_types': dict(Counter(r['run_type'] for r in runs)),
        'tokens': {k: sum(s['usage'][k] for s in llms) for k in ('input', 'output', 'cache_read')},
        'llm_ms': llm_ms, 'tool_ms': tool_ms, 'overhead_ms': max(wall - llm_ms - tool_ms, 0),
        'ttft_ms_avg': round(sum(ttfts) / len(ttfts)) if ttfts else None,
        'errors': sum(1 for r in runs if r.get('error')),
        'tool_histogram': dict(Counter(s['name'] for s in tools).most_common()),
        'finish_reasons': dict(Counter(s['finish_reason'] for s in llms if s.get('finish_reason'))),
    }
    metrics['tokens']['total'] = metrics['tokens']['input'] + metrics['tokens']['output']
    metrics['signature'] = ' → '.join('LLM' if s['kind'] == 'llm' else s['name'] for s in steps)
    return {'metrics': metrics, 'steps': steps,
            'depths': dict(Counter(r['name'] for r in runs if r['run_type'] == 'chain').most_common(10))}


def table(rows, headers):
    """Print rows as a fixed-width table."""
    widths = [max(len(str(r[i])) for r in [headers] + rows) for i in range(len(headers))]
    line = '  '.join(h.ljust(w) for h, w in zip(headers, widths))
    print(line)
    print('  '.join('-' * w for w in widths))
    for r in rows:
        print('  '.join(str(c).ljust(w) for c, w in zip(r, widths)))


def main():
    p = argparse.ArgumentParser(description='Compare two agent traces from LangSmith')
    p.add_argument('--projects', nargs=2, required=True, metavar=('A', 'B'))
    p.add_argument('--traces', nargs=2, metavar=('A', 'B'), help='trace ids; default: newest root run per project')
    p.add_argument('--root-name', default='dsh-turn,', help='comma-separated root name filter per project; empty = any')
    p.add_argument('--limit', type=int, default=20)
    p.add_argument('--json', metavar='FILE')
    p.add_argument('--flow', action='store_true', help='print every canonical step')
    a = p.parse_args()

    wanted = [set(filter(None, part.split('|'))) for part in (a.root_name.split(',') + ['', ''])[:2]]
    sides = []
    for i, project in enumerate(a.projects):
        trace = a.traces[i] if a.traces else latest_root(project_id(project), a.limit, wanted[i])
        runs = fetch_trace(trace)
        if not runs:
            sys.exit(f'trace {trace} has no runs (it may still be uploading)')
        side = normalize(runs)
        side['project'] = project
        sides.append(side)

    A, B = (s['metrics'] for s in sides)
    print(f"A = {sides[0]['project']}  trace {A['trace']}  root {A['root']}")
    print(f"B = {sides[1]['project']}  trace {B['trace']}  root {B['root']}\n")

    keys = [('wall_ms', 'wall clock (ms)'), ('iterations', 'iterations (LLM calls)'), ('tool_calls', 'tool calls'),
            ('tools_per_iteration', 'tools per iteration'), ('max_parallel_tools', 'max tools in one iteration'),
            ('llm_ms', 'time in LLM (ms)'), ('tool_ms', 'time in tools (ms)'), ('overhead_ms', 'time elsewhere (ms)'),
            ('ttft_ms_avg', 'avg time to first token'), ('runs_total', 'runs in trace'), ('errors', 'runs with error')]
    rows = [[label, A.get(k), B.get(k)] for k, label in keys]
    rows += [[f'tokens {k}', A['tokens'][k], B['tokens'][k]] for k in ('input', 'cache_read', 'output', 'total')]
    table(rows, ['metric', 'A', 'B'])

    print('\nflow A:', A['signature'] or '(no llm/tool runs)')
    print('flow B:', B['signature'] or '(no llm/tool runs)')
    print('\ntools A:', A['tool_histogram'])
    print('tools B:', B['tool_histogram'])
    print('chain nodes A:', sides[0]['depths'])
    print('chain nodes B:', sides[1]['depths'])

    if a.flow:
        for side, label in zip(sides, 'AB'):
            print(f"\n--- canonical flow {label} ({side['project']}) ---")
            table([[s['iteration'], s['kind'], s['name'], s['at_ms'], s['ms'],
                    (s.get('usage') or {}).get('input', ''), (s.get('usage') or {}).get('output', ''),
                    ','.join(s.get('tool_calls') or []) or (s.get('error') or '')] for s in side['steps']],
                  ['iter', 'kind', 'name', 'at_ms', 'ms', 'in_tok', 'out_tok', 'calls/error'])

    if a.json:
        with open(a.json, 'w', encoding='utf8') as f:
            json.dump({'a': sides[0], 'b': sides[1]}, f, ensure_ascii=False, indent=1)
        print(f'\nwrote {a.json}')


if __name__ == '__main__':
    main()
