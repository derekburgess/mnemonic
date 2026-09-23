import json
import sys
import time
import os
config = json.loads(sys.stdin.readline())
if config.get('mode') == 'download':
    cache = os.path.abspath('data/models') if config['cache'] == '/models' else config['cache']
    root = os.path.join(cache, 'models--' + config['model'].replace('/', '--'))
    revision = 'a' * 40
    snapshot = os.path.join(root, 'snapshots', revision)
    os.makedirs(snapshot, exist_ok=True)
    with open(os.path.join(snapshot, 'config.json'), 'w') as f: f.write('{}')
    with open(os.path.join(root, '.mnemonic-ready.json'), 'w') as f:
        json.dump({'model': config['model'], 'revision': revision, 'files': [{'name': 'config.json', 'size': 2}]}, f)
    print(json.dumps({'phase': 'Ready'}), flush=True)
    sys.stdin.read()
    sys.exit(0)
if config['model'] == 'load-error':
    print(json.dumps({'error': 'GPU out of memory. Choose a smaller model.'}), flush=True)
    sys.exit(0)
if config['model'] == 'hang':
    time.sleep(60)
print(json.dumps({'phase': 'Ready'}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if config['model'] == 'inference-error':
        print(json.dumps({'id': request['id'], 'error': 'Insufficient RAM to run this model.'}), flush=True)
        break
    result = {'text': 'ok'}
    if 'messages' in request['body']:
        result = {'id': 'local', 'model': config['model'], 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'local worker output'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 3}}
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
