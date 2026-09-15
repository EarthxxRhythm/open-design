"""Disposable real-content transfer measurement; immutable dogfood objects only."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import urllib.request

import notarization_factors as n

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.r2 import R2Client, R2Credentials


def public_request(url, method='GET'):
    return urllib.request.Request(url, method=method,
                                  headers={'User-Agent': 'OpenDesign-ArchitectureProbe/1'})


def acquire_existing():
    """Read-only continuation of the uploaded run; never recreate its object."""
    n.guard()
    url = 'https://releases.open-design.ai/dogfood/0.22.0-beta.34925784500/architecture-blob-1/resources.tgz'
    expected = '2dcfefbc98e5b355a3ce7b11f84b3d9247d64a215ecf196d543a9fb29c234ae3'
    n.ROOT.mkdir(parents=True, exist_ok=True)
    report = {'sourceRun': '34925784500', 'publicUrl': url, 'scope': 'read-only continuation, not initial CDN propagation', 'seconds': {}}
    start = time.monotonic()
    with urllib.request.urlopen(public_request(url, 'HEAD'), timeout=60) as response:
        assert int(response.headers['Content-Length']) == 296760177
    report['seconds']['cdnHead'] = round(time.monotonic() - start, 3)
    n.write('acquire.json', report)
    downloaded = n.ROOT / 'consumer.tgz'
    start = time.monotonic()
    with urllib.request.urlopen(public_request(url), timeout=180) as source, downloaded.open('wb') as target:
        shutil.copyfileobj(source, target)
    with downloaded.open('rb') as source:
        assert hashlib.file_digest(source, 'sha256').hexdigest() == expected
    report['seconds']['firstAcquireAndVerify'] = round(time.monotonic() - start, 3)
    n.write('acquire.json', report)
    consumer = n.ROOT / 'consumer'
    consumer.mkdir()
    start = time.monotonic()
    n.run('tar', '-xzf', downloaded, '-C', consumer)
    report['seconds']['extract'] = round(time.monotonic() - start, 3)
    files = [p for p in (consumer / 'Resources').rglob('*') if p.is_file() and not p.is_symlink()]
    assert len(files) == 14712
    assert sum(p.stat().st_size for p in files) == 716343917
    report['package'] = json.loads((consumer / 'Resources/app/package.json').read_text())['name']
    report['consumerValidated'] = True
    n.write('acquire.json', report)
    print(json.dumps(report, indent=2))


def main():
    n.guard()
    report = {'seconds': {}, 'scope': 'content transfer only; not a product release'}
    def timed(name, fn):
        start = time.monotonic()
        try:
            return fn()
        finally:
            report['seconds'][name] = round(time.monotonic() - start, 3)
            n.write('transfer.json', report)
            print(name, report['seconds'][name], flush=True)

    timed('prepareReference', lambda: n.prepare('full'))
    resources = n.APP / 'Contents/Resources'
    archive = n.ROOT / 'resources.tgz'
    timed('archive', lambda: n.run('tar', '-czf', archive, '-C', resources.parent, 'Resources'))
    with archive.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    report['archiveBytes'] = archive.stat().st_size
    report['sha256'] = digest
    original = [p for p in resources.rglob('*') if p.is_file() and not p.is_symlink()]
    report['resourceFiles'] = len(original)
    report['resourceBytes'] = sum(p.stat().st_size for p in original)
    key = f"dogfood/0.22.0-beta.{os.environ['GITHUB_RUN_ID']}/architecture-blob-{os.environ['GITHUB_RUN_ATTEMPT']}/resources.tgz"
    if not re.fullmatch(r'dogfood/0\.22\.0-beta\.[0-9]+/architecture-blob-[0-9]+/resources\.tgz', key):
        raise RuntimeError('refusing non-experimental distribution key')
    report['objectKey'] = key
    url = os.environ['RELEASE_PUBLIC_ORIGIN'].rstrip('/') + '/' + key
    report['publicUrl'] = url
    client = R2Client(endpoint=os.environ['RELEASE_STORAGE_ENDPOINT'],
                      bucket=os.environ['RELEASE_STORAGE_BUCKET'], timeout=180,
                      credentials=R2Credentials(os.environ['RELEASE_STORAGE_ACCESS_KEY_ID'],
                                                os.environ['RELEASE_STORAGE_SECRET_ACCESS_KEY']))
    timed('upload', lambda: client.put_file(key=key, file=archive, content_type='application/gzip'))
    def head():
        with urllib.request.urlopen(public_request(url, 'HEAD'), timeout=60) as response:
            assert int(response.headers['Content-Length']) == report['archiveBytes']
    timed('cdnHead', head)
    report['publicationSeconds'] = sum(report['seconds'][k] for k in ('archive', 'upload', 'cdnHead'))
    downloaded = n.ROOT / 'consumer.tgz'
    def acquire():
        with urllib.request.urlopen(public_request(url), timeout=180) as source, downloaded.open('wb') as destination:
            shutil.copyfileobj(source, destination)
        with downloaded.open('rb') as source:
            assert hashlib.file_digest(source, 'sha256').hexdigest() == digest
    timed('firstAcquireAndVerify', acquire)
    consumer = n.ROOT / 'consumer'
    consumer.mkdir()
    timed('extract', lambda: n.run('tar', '-xzf', downloaded, '-C', consumer))
    restored = consumer / 'Resources'
    # Full archive digest and a real structured consumer read, no source fallback.
    assert (restored / 'app/package.json').read_bytes() == (resources / 'app/package.json').read_bytes()
    files = [p for p in restored.rglob('*') if p.is_file() and not p.is_symlink()]
    assert len(files) == report['resourceFiles']
    assert sum(p.stat().st_size for p in files) == report['resourceBytes']
    report['consumerValidated'] = True
    n.write('transfer.json', report)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    if sys.argv[1:] == ['acquire-existing']:
        acquire_existing()
    elif not sys.argv[1:]:
        main()
    else:
        raise SystemExit('expected no arguments or acquire-existing')
