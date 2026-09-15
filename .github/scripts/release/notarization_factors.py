"""Disposable macOS timing experiment: stdlib only, no product publishing.

Retains existing signed nested code, re-signs outer bundles. This is NOT a
from-source build measurement, nor a cold Apple service cache measurement.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import subprocess
import sys
import time

ROOT = Path('.tmp/notarization-factors').resolve()
REPORTS = ROOT / 'reports'
APP = ROOT / 'sample' / 'Open Design.app'
TAG = 'open-design-v0.22.0'
ASSET = 'open-design-0.22.0-mac-arm64.dmg'
SOURCE_SHA256 = 'a3b585762f67680089adea5942be44e35338cc37c87d1c21e82285e718882479'
FACTORS = {
    'few-small': (1, 8 * 1024**2),
    'many-small': (14710, 8 * 1024**2),
    'few-large': (1, 688 * 1024**2),
    'many-large': (14710, 688 * 1024**2),
}


def guard():
    if (os.environ.get('GITHUB_REPOSITORY') != 'nexu-io/open-design'
            or os.environ.get('GITHUB_REF') != 'refs/heads/experiment/architecture-benefit-boundaries'
            or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'):
        raise RuntimeError('Only the authorized manual experiment branch may execute')


def add_payload(variant):
    count, size = FACTORS[variant]
    destination = APP / 'Contents/Resources/experiment-data'
    destination.mkdir()
    # Same non-executable byte stream and entropy in every cell of this run.
    # Highly compressible by design: uncompressed size is not merely upload size.
    token = hashlib.sha256(os.environ['GITHUB_RUN_ID'].encode()).hexdigest().encode()
    block = (b'Notary factor data; never executable. ' + token + b'\n') * 64
    offset = 0
    for index in range(count):
        remaining = size // count + (index < size % count)
        target = destination / f'{index:05d}.dat'
        with target.open('wb') as output:
            while remaining:
                chunk = min(remaining, len(block) - offset)
                output.write(block[offset:offset + chunk])
                remaining -= chunk
                offset = (offset + chunk) % len(block)
    assert sum(p.stat().st_size for p in destination.iterdir()) == size
    return {'payloadFiles': count, 'payloadBytes': size,
            'pattern': 'same run-seeded repetitive text stream; non-executable'}


def code_inventory(files):
    magic = {bytes.fromhex(value) for value in (
        'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca',
        'cafebabf', 'bfbafeca')}
    native = []
    for path in files:
        with path.open('rb') as source:
            header = source.read(4)
        if header in magic:
            with path.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            native.append({'path': str(path.relative_to(APP)), 'bytes': path.stat().st_size,
                           'sha256': digest})
    return native


def containerize(resources):
    start = time.monotonic()
    files = [p for p in resources.rglob('*') if p.is_file() and not p.is_symlink()]
    native = code_inventory(files)
    source = ROOT / 'container-source'
    resources.rename(source)
    resources.mkdir()
    # Keep every native binary outside ASAR, preserving its original signature.
    pattern = '{' + ','.join('**/' + row['path'].removeprefix('Contents/Resources/')
                            for row in native) + '}'
    run('npm', 'exec', '--yes', '--package=@electron/asar@3.4.1', '--', 'asar',
        'pack', source, resources / 'content.asar', '--unpack', pattern)
    for row in native:
        moved = resources / 'content.asar.unpacked' / row['path'].removeprefix('Contents/Resources/')
        with moved.open('rb') as stream:
            assert hashlib.file_digest(stream, 'sha256').hexdigest() == row['sha256']
    return {'kind': 'real content container; no externalization',
            'containerSeconds': round(time.monotonic() - start, 3),
            'nativeFilesKeptLoose': len(native), 'originalNative': native}



def run(*args, timeout=600, check=True):
    # Do not log argv, which may contain credentials.
    try:
        result = subprocess.run([str(arg) for arg in args], capture_output=True,
                                text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        # TimeoutExpired includes argv; never expose that credential-bearing repr.
        raise RuntimeError(f'{args[0]} exceeded {timeout}s; do not retry a submission blindly') from None
    if check and result.returncode:
        detail = result.stdout + result.stderr
        for key, value in os.environ.items():
            if key.startswith('APPLE_') and value:
                detail = detail.replace(value, '[REDACTED]')
        raise RuntimeError(f'{args[0]} exited {result.returncode}: {detail}')
    return result


def write(name, value):
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / name).write_text(json.dumps(value, indent=2) + '\n')


def prepare(variant):
    ROOT.mkdir(parents=True, exist_ok=False)
    run('gh', 'release', 'download', TAG, '--repo', 'nexu-io/open-design',
        '--pattern', ASSET, '--pattern', ASSET + '.sha256', '--dir', ROOT)
    with (ROOT / ASSET).open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    assert digest == SOURCE_SHA256 == (ROOT / (ASSET + '.sha256')).read_text().split()[0]
    mount = ROOT / 'mount'
    run('hdiutil', 'attach', ROOT / ASSET, '-readonly', '-nobrowse', '-mountpoint', mount)
    try:
        apps = list(mount.glob('*.app'))
        assert len(apps) == 1
        APP.parent.mkdir()
        run('ditto', apps[0], APP)
    finally:
        run('hdiutil', 'detach', mount)
    run('codesign', '--verify', '--deep', '--strict', APP)
    plist_path = APP / 'Contents/Info.plist'
    info = plistlib.loads(plist_path.read_bytes())
    source_version = info.get('CFBundleShortVersionString')
    info['ODNotarizationExperiment'] = os.environ['GITHUB_RUN_ID'] + '-' + variant
    container = None
    if variant != 'full':
        resources = APP / 'Contents/Resources'
        # Exact disposable copy only; original release/worktrees untouched.
        if variant == 'container':
            container = containerize(resources)
        else:
            shutil.rmtree(resources)
        entry = resources / 'app'
        entry.mkdir(parents=True)
        (entry / 'package.json').write_text(json.dumps({
            'name': 'notarization-timing-minimal', 'version': '1.0.0', 'main': 'main.js'}))
        # Generated runtime fixture: no dependencies, network, updater or focus.
        (entry / 'main.js').write_text('''const { app, BrowserWindow } = require('electron');
app.setActivationPolicy('prohibited');
app.setPath('userData', require('path').join(process.env.OD_NOTARY_EXPERIMENT_ROOT, 'runtime', 'user-data'));
app.whenReady().then(async () => {
  const fs = require('fs'), path = require('path');
  const container = path.join(process.resourcesPath, 'content.asar');
  if (fs.existsSync(container)) {
    const metadata = JSON.parse(fs.readFileSync(path.join(container, 'app', 'package.json'), 'utf8'));
    if (!metadata.name) throw new Error('real content not readable through ASAR');
    console.log('CONTAINER_CONTENT_READ_OK ' + metadata.name);
  }
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL('data:text/html,<title>Capsule bootstrap</title><h1>Ready</h1>');
  const text = await win.webContents.executeJavaScript('document.body.innerText');
  if (text.trim() !== 'Ready') throw new Error('renderer did not start');
  console.log('NOTARY_SMOKE_OK ' + JSON.stringify(process.versions));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
''')
        info.pop('ElectronAsarIntegrity', None)
        info.pop('CFBundleIconFile', None)
    factors = add_payload(variant) if variant in FACTORS else container
    plist_path.write_bytes(plistlib.dumps(info))
    framework = APP / 'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist'
    electron = plistlib.loads(framework.read_bytes()).get('CFBundleVersion')
    write('source.json', {'release': TAG, 'asset': ASSET, 'sha256': digest,
                         'version': source_version, 'electron': electron,
                         'variant': variant, 'factors': factors, 'runner': run('sw_vers').stdout,
                         'arch': run('uname', '-m').stdout.strip()})


def measure(variant):
    required = ['APPLE_SIGNING_CERTIFICATE_BASE64', 'APPLE_SIGNING_CERTIFICATE_PASSWORD',
                'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise RuntimeError('Missing CI secrets: ' + ', '.join(missing))
    keychain = ROOT / 'experiment.keychain-db'
    cert = ROOT / 'certificate.p12'
    cert.write_bytes(base64.b64decode(os.environ[required[0]]))
    cert.chmod(0o600)
    password = secrets.token_hex(24)
    result = {'variant': variant, 'seconds': {}, 'submissionId': None,
              'factors': FACTORS.get(variant), 'runId': os.environ['GITHUB_RUN_ID']}

    def timed(label, *args, **kwargs):
        start = time.monotonic()
        try:
            return run(*args, **kwargs)
        finally:
            result['seconds'][label] = round(time.monotonic() - start, 3)
            write('timing.json', result)
            print(label, result['seconds'][label], 'seconds', flush=True)

    try:
        run('security', 'create-keychain', '-p', password, keychain)
        run('security', 'set-keychain-settings', '-lut', '21600', keychain)
        run('security', 'unlock-keychain', '-p', password, keychain)
        # codesign's identity/private-key lookup also consults the user search list.
        run('security', 'list-keychains', '-d', 'user', '-s', keychain,
            Path.home() / 'Library/Keychains/login.keychain-db')
        run('security', 'import', cert, '-k', keychain, '-P', os.environ[required[1]],
            '-T', '/usr/bin/codesign', '-T', '/usr/bin/security')
        run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:',
            '-s', '-k', password, keychain)
        identities = run('security', 'find-identity', '-v', '-p', 'codesigning', keychain).stdout
        matches = re.findall(r'([A-F0-9]{40}) "Developer ID Application:[^"]+"', identities)
        assert len(matches) == 1, 'Expected one Developer ID Application identity'
        entitlements = ROOT / 'entitlements.plist'
        entitlements.write_bytes(plistlib.dumps({
            'com.apple.security.cs.allow-jit': True,
            'com.apple.security.cs.allow-unsigned-executable-memory': True,
            'com.apple.security.cs.disable-library-validation': True}))
        timed('outerSign', 'codesign', '--force', '--sign', matches[0], '--keychain',
              keychain, '--options', 'runtime', '--timestamp', '--entitlements', entitlements, APP)
        timed('signatureVerify', 'codesign', '--verify', '--deep', '--strict', APP)
        if variant != 'full':
            info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
            (ROOT / 'runtime/user-data').mkdir(parents=True)
            os.environ['OD_NOTARY_EXPERIMENT_ROOT'] = str(ROOT)
            smoke = timed('headlessSmoke', APP / 'Contents/MacOS' / info['CFBundleExecutable'],
                          timeout=45)
            assert 'NOTARY_SMOKE_OK' in smoke.stdout, smoke.stdout + smoke.stderr
            (REPORTS / 'smoke.txt').write_text(smoke.stdout + smoke.stderr)
        files = [p for p in APP.rglob('*') if p.is_file() and not p.is_symlink()]
        result['nativeCode'] = code_inventory(files)
        result['files'] = len(files)
        result['appBytes'] = sum(p.stat().st_size for p in files)
        archive = ROOT / 'submission.zip'
        timed('zip', 'ditto', '-c', '-k', '--keepParent', APP, archive)
        result['uploadBytes'] = archive.stat().st_size
        auth = ['--apple-id', os.environ['APPLE_ID'], '--password',
                os.environ['APPLE_APP_SPECIFIC_PASSWORD'], '--team-id', os.environ['APPLE_TEAM_ID']]
        # Submit exactly once; waiting excludes client upload/submit time.
        submitted = timed('uploadSubmit', 'xcrun', 'notarytool', 'submit', archive,
                          *auth, '--output-format', 'json', timeout=900)
        submission = json.loads(submitted.stdout)
        write('submit.json', submission)
        result['submissionId'] = submission['id']
        write('timing.json', result)
        waited = timed('appleWait', 'xcrun', 'notarytool', 'wait', submission['id'],
                       *auth, '--output-format', 'json', '--timeout', '35m',
                       timeout=2160, check=False)
        (REPORTS / 'wait.json').write_text(waited.stdout)
        info = json.loads(run('xcrun', 'notarytool', 'info', submission['id'],
                              *auth, '--output-format', 'json').stdout)
        write('notary-info.json', info)
        result['status'] = info['status']
        if info['status'] in ('Accepted', 'Invalid', 'Rejected'):
            log = run('xcrun', 'notarytool', 'log', submission['id'], *auth)
            (REPORTS / 'notary-log.json').write_text(log.stdout)
        assert info['status'] == 'Accepted', 'Not accepted; inspect saved ID, do not resubmit'
        timed('staple', 'xcrun', 'stapler', 'staple', APP)
        timed('stapleValidate', 'xcrun', 'stapler', 'validate', APP)
        timed('gatekeeper', 'spctl', '--assess', '--type', 'execute', '--verbose=2', APP)
        if variant in ('full', 'few-small', 'container'):
            timed('dmg', 'hdiutil', 'create', '-srcfolder', APP, '-volname',
                  'Notary-' + variant, '-format', 'UDZO', ROOT / 'sample.dmg')
            result['dmgBytes'] = (ROOT / 'sample.dmg').stat().st_size
        else:
            result['dmgSkipped'] = 'factorial Apple probe, not a distribution measurement'
    finally:
        write('timing.json', result)
        cert.unlink(missing_ok=True)
        if keychain.exists():
            run('security', 'delete-keychain', keychain, check=False)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    guard()
    operation, variant = sys.argv[1:]
    assert variant in {'full', 'container', *FACTORS}
    assert operation in ('prepare', 'measure')
    {'prepare': prepare, 'measure': measure}[operation](variant)
