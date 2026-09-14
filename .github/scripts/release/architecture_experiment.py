#!/usr/bin/env python3
"""Temporary, branch-bound measurement harness. Not a production release API.

Identity comes from the existing convergence evaluator. The deliberate ideal
policy probes small receipts in plan and verifies bytes only at materialization.
Only experimental workload results are writable; no installer or channel keys.
"""
from __future__ import annotations

import argparse
import hashlib
import base64
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import convergence as c
from lib.github import append_outputs
from lib.r2 import R2Client, R2Credentials, R2PreconditionFailed

ROOT = Path(__file__).resolve().parents[3]
BRANCH = "refs/heads/experiment/architecture-benefit-boundaries"
PREFIX = "architecture-experiments/open-design-architecture-optimization/ideal-main-macos-v1"
WORKFLOW = "architecture-experiment"
STATE = ROOT / ".tmp/architecture-experiment"
ORDER = ["shared", "daemon", "web", "desktop", "packaged"]


def guard() -> None:
    if (os.environ.get("GITHUB_REPOSITORY") != "nexu-io/open-design"
            or os.environ.get("GITHUB_REF") != BRANCH
            or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"):
        raise RuntimeError("experiment execution is restricted to its authorized manual branch")


def command(args: list[str], **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def prepare(round_name: str) -> None:
    # Controlled real source variants in the ephemeral checkout, not forced hits.
    if round_name in {"source", "test"}:
        layout = ROOT / "apps/web/app/layout.tsx"
        old = "title: 'OpenDesign',"
        replacement = "title: 'OpenDesign — Architecture Experiment',"
        text = layout.read_text()
        if old in text:
            layout.write_text(text.replace(old, replacement, 1))
        elif replacement not in text:
            raise RuntimeError("source experiment no longer matches the fixed baseline")
        command(["git", "add", "--", "apps/web/app/layout.tsx"])
    if round_name == "test":
        witness = ROOT / "apps/web/tests/architecture-experiment.test.ts"
        witness.write_text("import { expect, it } from 'vitest';\nit('experiment test-only witness', () => expect(2 + 2).toBe(4));\n")
        command(["git", "add", "--", "apps/web/tests/architecture-experiment.test.ts"])


def contract():
    return c.ConvergenceContract(ROOT / ".github/config/architecture-experiment.json")


def key(identity: str, digest: str, name: str) -> str:
    if identity not in {*ORDER, "web-tests"} or not c.DIGEST_RE.fullmatch(digest):
        raise RuntimeError("invalid experimental cache identity")
    if name not in {"result.json", "output.tgz"}:
        raise RuntimeError("only reusable experimental result objects are allowed")
    return f"{PREFIX}/{identity}/{digest}/{name}"


def origin() -> str:
    value = os.environ["OD_WORKLOAD_RESULTS_BASE_URL"].rstrip("/")
    c.public_origin(value)
    return value


def storage():
    guard()
    return R2Client(endpoint=os.environ["CLOUDFLARE_R2_WORKLOAD_RESULTS_URL"],
                    bucket=os.environ["CLOUDFLARE_R2_WORKLOAD_RESULTS_BUCKET"],
                    credentials=R2Credentials(os.environ["CLOUDFLARE_R2_WORKLOAD_RESULTS_AK"], os.environ["CLOUDFLARE_R2_WORKLOAD_RESULTS_SK"]),
                    timeout=180)


def write_json(path: Path, value) -> None:
    c.write_json_atomic(path, value)


def plan(round_name: str) -> None:
    prepare(round_name)
    cfg = contract()
    calculated = c.calculate(cfg, ROOT, WORKFLOW, {"mac": ["macos-14", "arm64", "node-24.18.0", "pnpm-10.33.2", "web-standalone"]})
    records = {}
    start = time.monotonic()
    for identity, expected in calculated.items():
        receipt = None
        try:
            raw = c.fetch_result(f"{origin()}/{key(identity, expected['digest'], 'result.json')}", 15)
            receipt = c.validate_result(raw, repository_id=int(os.environ["GITHUB_REPOSITORY_ID"]),
                                        workflow=cfg.workflow(WORKFLOW), identity=identity, expected=expected)
            for product in receipt["products"].values():
                if product["source"] != f"{origin()}/{key(identity, expected['digest'], 'output.tgz')}":
                    raise RuntimeError("receipt product escaped experimental cache namespace")
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
        # Do not emit secret-configured origins through GitHub job outputs.
        compact_receipt = None if receipt is None else {"products": {name: {"data": value.get("data", {})} for name, value in receipt["products"].items()}}
        records[identity] = {"expected": expected, "receipt": compact_receipt, "hit": receipt is not None}
    result = {"round": round_name, "head": os.environ["GITHUB_SHA"], "nodes": records,
              "planSeconds": time.monotonic() - start,
              "policy": "receipt-only probe; product digest verified by materializer"}
    write_json(STATE / "plan.json", result)
    append_outputs({"plan": c.canonical_json(result), "test_run": str(not records['web-tests']['hit']).lower()})
    print(json.dumps({"round": round_name, "hits": {k: v['hit'] for k, v in records.items()}, "planSeconds": result['planSeconds']}, indent=2))


def outputs(identity: str) -> list[str]:
    if identity == "shared":
        return sorted(str(path.relative_to(ROOT)) for path in (ROOT / "packages").glob("*/dist") if path.is_dir())
    if identity == "web":
        return ["apps/web/dist", "apps/web/.next/standalone", "apps/web/.next/static"]
    return [f"apps/{identity}/dist"]


def restore(identity: str, row: dict) -> dict:
    product = row["receipt"]["products"]["output"]
    archive = STATE / f"{identity}.tgz"
    start = time.monotonic()
    request = c.public_read_request(f"{origin()}/{key(identity, row['expected']['digest'], 'output.tgz')}", accept="application/octet-stream")
    with urllib.request.urlopen(request, timeout=180) as response, archive.open("wb") as target:
        import shutil
        shutil.copyfileobj(response, target)
    if c.sha256_file(archive) != product["data"]["sha256"]:
        raise RuntimeError(f"{identity} cached product digest mismatch")
    with tarfile.open(archive) as bundle:
        for member in bundle:
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise RuntimeError("unsafe cached member path")
    command(["tar", "-xzf", str(archive), "-C", str(ROOT)])
    return {"action": "restore", "bytes": archive.stat().st_size, "seconds": time.monotonic() - start}


def receipt(identity: str, expected: dict, products: dict) -> dict:
    return {"schemaVersion": 1, "protocol": c.PROTOCOL,
            "repositoryId": int(os.environ["GITHUB_REPOSITORY_ID"]), "workflow": WORKFLOW,
            "policy": contract().workflow(WORKFLOW).policy, "workload": identity,
            "digest": expected["digest"], "executionClass": expected["executionClass"], "products": products,
            "validated": {"event": "workflow_dispatch", "runId": int(os.environ["GITHUB_RUN_ID"]),
                          "runAttempt": int(os.environ["GITHUB_RUN_ATTEMPT"]), "headSha": os.environ["GITHUB_SHA"],
                          "baseSha": os.environ["GITHUB_SHA"],
                          "treeSha": command(["git", "write-tree"], capture_output=True, text=True).stdout.strip(),
                          "validatedAt": c.datetime.now(c.timezone.utc).isoformat()}}


def publish(identity: str, expected: dict) -> dict:
    start = time.monotonic()
    client = storage()
    products = {}
    size = 0
    if identity != "web-tests":
        archive = STATE / f"{identity}.tgz"
        paths = outputs(identity)
        if not paths or any(not (ROOT / path).exists() for path in paths):
            raise RuntimeError(f"{identity} missing declared outputs")
        command(["tar", "-czf", str(archive), "-C", str(ROOT), *paths], env={**os.environ, "COPYFILE_DISABLE": "1"})
        size = archive.stat().st_size
        if size > 3 * 1024**3:
            raise RuntimeError("experimental component exceeds 3 GiB; inspect before upload")
        client.put_file(key=key(identity, expected['digest'], 'output.tgz'), file=archive, content_type="application/gzip")
        products = {"output": {"type": "url", "source": f"{origin()}/{key(identity, expected['digest'], 'output.tgz')}",
                               "data": {"sha256": c.sha256_file(archive), "bytes": size}}}
    document = receipt(identity, expected, products)
    client.put_bytes(key=key(identity, expected['digest'], 'result.json'), body=c.canonical_json(document).encode())
    return {"uploadedBytes": size, "publishSeconds": time.monotonic() - start}


def execute(test_only: bool) -> None:
    result = json.loads(os.environ["EXPERIMENT_PLAN"])
    prepare(result["round"])
    STATE.mkdir(parents=True, exist_ok=True)
    reports = {}
    if test_only:
        # Tests consume package declarations, not the release's Next build.
        command(["pnpm", "--filter", "@open-design/web^...", "--workspace-concurrency=4", "--if-present", "run", "build"])
        start = time.monotonic()
        command(["pnpm", "--filter", "@open-design/web", "test"])
        reports["web-tests"] = {"action": "test", "seconds": time.monotonic() - start,
                                **publish("web-tests", result['nodes']['web-tests']['expected'])}
    else:
        for identity in ORDER:
            row = result["nodes"][identity]
            if row["hit"]:
                reports[identity] = restore(identity, row)
                continue
            start = time.monotonic()
            if identity == "shared":
                command(["pnpm", "--filter", "./packages/**", "--workspace-concurrency=4", "--if-present", "run", "build"])
            else:
                command(["pnpm", "--filter", f"@open-design/{identity}", "run", "build"])
                if identity == "web":
                    command(["pnpm", "--filter", "@open-design/web", "run", "build:sidecar"])
            reports[identity] = {"action": "build", "seconds": time.monotonic() - start, **publish(identity, row['expected'])}
        write_json(ROOT / ".tmp/architecture-prebuilt.json", {"head": os.environ["GITHUB_SHA"],
                   "outputs": [path for identity in ORDER for path in outputs(identity)]})
    write_json(STATE / ("tests.json" if test_only else "builds.json"), reports)
    print(json.dumps(reports, indent=2))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as target:
            target.write("\n### Experiment work and transport\n```json\n" + json.dumps(reports, indent=2) + "\n```\n")


def setup() -> None:
    command(["pnpm", "rebuild", "better-sqlite3", "electron", "node-pty"])
    vendor = ROOT / "apps/desktop/vendor/dom-to-pptx/dom-to-pptx.bundle.js.gz"
    if vendor.is_file():
        vendor.with_suffix("").write_bytes(gzip.decompress(vendor.read_bytes()))


def native() -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    command(["pnpm", "--filter", "@open-design/tools-pack", "build"])
    command(["pnpm", "--filter", "@open-design/tools-release", "build"])
    certificate = STATE / "signing.p12"
    certificate.write_bytes(base64.b64decode(os.environ["APPLE_SIGNING_CERTIFICATE_BASE64"], validate=True))
    certificate.chmod(0o600)
    version = f"0.22.1-beta.{os.environ['GITHUB_RUN_ID']}"
    env = {**os.environ, "CSC_LINK": str(certificate), "CSC_KEY_PASSWORD": os.environ["APPLE_SIGNING_CERTIFICATE_PASSWORD"],
           "OD_ARCHITECTURE_EXPERIMENT_PREBUILT": "1"}
    try:
        built = command(["pnpm", "exec", "tools-pack", "mac", "build", "--dir", str(STATE / "native"),
                         "--namespace", "release-beta", "--portable", "--app-version", version,
                         "--mac-compression", "normal", "--to", "dmg", "--signed", "--notarize", "--json"],
                        env=env, stdout=subprocess.PIPE, text=True)
    finally:
        certificate.unlink(missing_ok=True)
    build_path = STATE / "native-build.json"
    build_path.write_text(built.stdout)
    parsed = json.loads(built.stdout)
    print(json.dumps({"version": version, "timings": parsed.get("timings"), "sizeReport": parsed.get("sizeReport")}, indent=2))
    # Version-specific installer is distribution, NEVER experimental workload cache.
    command(["pnpm", "exec", "tools-release", "publish-dogfood"], env={**os.environ,
        "DOGFOOD_VERSION": version, "DOGFOOD_BUILD_ID": f"{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}",
        "DOGFOOD_BUILD_JSON_PATH": str(build_path), "DOGFOOD_BUILD_JSON_KEYS": "dmgPath"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["plan", "build", "test", "setup", "native"])
    parser.add_argument("--round", choices=["cold", "hot", "source", "test"], default="cold")
    args = parser.parse_args()
    guard()
    if args.command == "plan":
        plan(args.round)
    elif args.command == "setup":
        setup()
    elif args.command == "native":
        native()
    else:
        execute(args.command == "test")
