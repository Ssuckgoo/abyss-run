# 로컬 테스트용 정적 서버. python serve.py [포트]
# (python -m http.server는 동시 요청이 많으면 윈도우에서 연결이 거부돼서 대기열을 늘린 버전)
import functools
import http.server
import os
import sys


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True


root = os.path.dirname(os.path.abspath(__file__))
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
Handler.log_message = lambda *a: None
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print(f"http://localhost:{port}")
Server(("", port), Handler).serve_forever()
