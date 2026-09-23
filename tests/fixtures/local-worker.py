import json
import sys
import time
config = json.loads(sys.stdin.readline())
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
