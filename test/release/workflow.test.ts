import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pkgs } from '../../src/pkgs.ts'

const TEXT = readFileSync(join(import.meta.dir, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
const COS = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'cos.py'), 'utf8')
const LOCK = readFileSync(join(import.meta.dir, '..', '..', 'bun.lock'), 'utf8')
type Step = {
  name?: string; id?: string; if?: string; uses?: string; run?: string
  with?: Record<string, unknown>; env?: Record<string, string>
}
type Job = {
  needs?: string | string[]; if?: string; permissions?: Record<string, string>; env?: Record<string, string>
  outputs?: Record<string, string>; steps: Step[]
}
type Input = { description: string; required: boolean; default: boolean | string; type: string }
const workflow = Bun.YAML.parse(TEXT) as {
  on: { workflow_dispatch: { inputs: Record<string, Input> } }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  env: Record<string, string>
  jobs: Record<string, Job>
}
const jobs = workflow.jobs
const runs = (job: string) => jobs[job]!.steps.map((step) => step.run ?? '').join('\n')
const uses = (job: string) => jobs[job]!.steps.map((step) => step.uses).filter((value): value is string => !!value)
const needs = (job: string) => [jobs[job]!.needs ?? []].flat()
const step = (job: string, name: string) => jobs[job]!.steps.find((item) => item.name === name)
const indexIn = (text: string, needle: string) => {
  const at = text.indexOf(needle)
  expect(at).toBeGreaterThanOrEqual(0)
  return at
}

describe('release.yml', () => {
  test('is started by hand only, with publish (boolean, default false) and commit (string) inputs', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs)).toEqual(['publish', 'commit'])
    expect(inputs['publish']).toEqual({
      description: expect.any(String), required: false, default: false, type: 'boolean',
    })
    expect(inputs['commit']).toEqual({ description: expect.any(String), required: false, default: '', type: 'string' })
    expect(TEXT).not.toMatch(/^\s*push:/m)
    expect(TEXT).not.toMatch(/tags: \['v\*'\]/)
    expect(TEXT).not.toMatch(/^\s*version:\s*$/m)
  })

  test('read-only by default; contents write only on tag; no id-token anywhere', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const writers = Object.entries(jobs).filter(([, job]) => Object.values(job.permissions ?? {}).includes('write'))
    expect(writers.map(([id, job]) => [id, job.permissions])).toEqual([['tag', { contents: 'write' }]])
    expect(jobs['upload']!.permissions).toEqual({ contents: 'read' })
    expect(jobs['latest']!.permissions).toEqual({ contents: 'read' })
    expect(TEXT).not.toContain('id-token')
  })

  test('concurrent releases queue and are never cancelled midway', () => {
    expect(workflow.concurrency).toEqual({ group: 'acde-release', 'cancel-in-progress': false })
  })

  test('the jobs run plan, exe, pkgs, guard, upload, tag, latest, with their needs', () => {
    expect(Object.keys(jobs)).toEqual(['plan', 'exe', 'pkgs', 'guard', 'upload', 'tag', 'latest'])
    expect(needs('plan')).toEqual([])
    expect(needs('exe')).toEqual(['plan'])
    expect(needs('pkgs')).toEqual(['plan', 'exe'])
    expect(needs('guard')).toEqual(['plan', 'pkgs'])
    expect(needs('upload')).toEqual(['plan', 'guard'])
    expect(needs('tag')).toEqual(['plan', 'guard', 'upload'])
    expect(needs('latest')).toEqual(['plan', 'guard', 'tag'])
  })

  test('upload, tag and latest need publish=true and every job they wait for to succeed', () => {
    const gates: Record<string, string> = { upload: 'guard', tag: 'upload', latest: 'tag' }
    for (const [job, dependency] of Object.entries(gates)) {
      expect(jobs[job]!.if).toBe(`needs.plan.outputs.publish == 'true' && needs.${dependency}.result == 'success'`)
    }
    expect(TEXT).not.toContain('success()')
    expect(TEXT).not.toMatch(/\$\{\{\s*!?inputs\./)
    expect(runs('plan')).toContain('if [ "${PUBLISH_INPUT:-}" = true ]; then PUBLISH=true; else PUBLISH=false; fi')
    expect(runs('plan')).toContain('echo "publish=$PUBLISH" >> "$GITHUB_OUTPUT"')
    expect(jobs['plan']!.if).toBeUndefined()
    expect(jobs['pkgs']!.if).toBeUndefined()
    expect(jobs['guard']!.if).toBeUndefined()
  })

  test('the versioned files are uploaded before the tag, and latest.json is updated after the tag', () => {
    const upload = runs('upload')
    const archive = indexIn(upload, '$COS once "out/$v/acde-$v.tar.gz" "$PREFIX/$v/acde-$v.tar.gz"')
    expect(archive).toBeLessThan(indexIn(upload, '$COS once "out/$v/SHA256SUMS" "$PREFIX/$v/SHA256SUMS"'))
    expect(COS).toContain('head = remote(client, bucket, name)')
    expect(COS).toContain('does not read back as uploaded')
    expect(upload).not.toContain('$COS pointer')
    expect(runs('tag')).toContain('git push origin "refs/tags/$TAG"')
    expect(needs('tag')).toContain('upload')
    const latest = runs('latest')
    const order = ['install.sh', 'install.ps1', 'install.md', 'latest "', 'latest.json']
      .map((file) => `$COS pointer out/${file}`)
    const at = order.map((needle) => indexIn(latest, needle))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(latest).not.toContain('$COS once')
    expect(latest).toContain("fresh='no-cache'")
    expect(latest.match(/\$COS pointer [^\n]*"\$fresh"$/gm)).toHaveLength(5)
    expect(needs('latest')).toContain('tag')
  })

  test('a preview (publish=false) says so and stops after the guard', () => {
    expect(step('guard', 'a preview stops here')?.if).toBe("needs.plan.outputs.publish != 'true'")
    expect(TEXT).not.toMatch(/tags?\s+v\$/)
  })

  test('a publish needs a commit; the commit must be a commit here and an ancestor of origin/main', () => {
    const plan = runs('plan')
    expect(plan).toContain('a publish needs a commit: run it with -f commit=<sha>')
    expect(plan).toContain('git rev-parse --verify --quiet "$COMMIT^{commit}"')
    expect(plan).toContain('git merge-base --is-ancestor "$sha" origin/main')
    expect(plan).toContain('neither origin/main nor one of its ancestors')
    expect(plan).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"')
    const checkout = indexIn(plan, 'git checkout --quiet --detach "$sha"')
    expect(indexIn(plan, 'git merge-base --is-ancestor')).toBeLessThan(checkout)
    expect(jobs['plan']!.outputs).toEqual({
      publish: '${{ steps.version.outputs.publish }}',
      sha: '${{ steps.version.outputs.sha }}',
      version: '${{ steps.version.outputs.version }}',
      tag: '${{ steps.version.outputs.tag }}',
    })
  })

  test('a publish runs only on main; the version is read from the commit checked out', () => {
    const plan = runs('plan')
    expect(plan).toContain('"$PUBLISH" = true ] && [ "$GITHUB_REF" != refs/heads/main ]')
    expect(plan).toContain('require("./package.json").version')
    expect(plan).toContain('[0-9]*.[0-9]*.[0-9]*')
    const checkout = indexIn(plan, 'git checkout --quiet --detach "$sha"')
    expect(checkout).toBeLessThan(indexIn(plan, 'require("./package.json")'))
    expect(TEXT).not.toMatch(/github\.ref_name|format\('v\{0\}'/)
  })

  test('the plan checkout fetches history; every later job checks out the resolved commit', () => {
    const planCheckout = jobs['plan']!.steps.find((item) => item.uses?.startsWith('actions/checkout@'))
    expect(planCheckout?.with?.['fetch-depth']).toBe(0)
    expect(planCheckout?.with?.['ref']).toBeUndefined()
    for (const job of ['exe', 'pkgs', 'upload', 'tag', 'latest']) {
      const checkout = jobs[job]!.steps.find((item) => item.uses?.startsWith('actions/checkout@'))
      expect(checkout?.with?.['ref']).toBe('${{ needs.plan.outputs.sha }}')
    }
  })

  test('the tag is free, or already points at the same commit; a different commit fails with a bump hint', () => {
    const check = step('plan', 'the tag is free, or already points at this commit')
    expect(check?.if).toBe("steps.version.outputs.publish == 'true'")
    expect(check?.run).toContain('git rev-parse --verify --quiet "refs/tags/$TAG^{commit}"')
    expect(TEXT).not.toContain('gh api')
    expect(check?.run).toContain('[ "$tagged" != "$SHA" ]')
    expect(check?.run).toContain('bump the version in package.json')
  })

  test('the tag job creates an annotated tag on the resolved commit, never moves or forces one', () => {
    const tag = jobs['tag']!
    expect(tag.env?.['SHA']).toBe('${{ needs.plan.outputs.sha }}')
    const checkout = tag.steps.find((item) => item.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['persist-credentials']).toBe(true)
    const run = runs('tag')
    expect(run).toContain('test "$(git rev-parse HEAD)" = "$SHA"')
    expect(run).toContain('git ls-remote --exit-code --tags origin "refs/tags/$TAG"')
    expect(run).toContain('tag -a "$TAG" -m "acde $TAG" "$SHA"')
    expect(run).toContain('git push origin "refs/tags/$TAG"')
    expect(run).toContain('bump the version in package.json')
    expect(run).toContain('a rerun continues')
    expect(run).not.toMatch(/git tag (?!-a)/)
    expect(run).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+refs)/)
  })

  test('the checkout in every job other than tag keeps no token', () => {
    for (const job of Object.keys(jobs).filter((id) => id !== 'tag')) {
      for (const item of jobs[job]!.steps) {
        if (item.uses?.startsWith('actions/checkout@')) expect(item.with?.['persist-credentials']).toBe(false)
      }
    }
  })

  test('the SDK is the version of the release, fetched from PKGS and checked before it is unpacked', () => {
    expect(workflow.env['SDK_VERSION']).toBeUndefined()
    expect(jobs['pkgs']!.env?.['SDK_VERSION']).toBe('${{ needs.plan.outputs.version }}')
    const pkgs = runs('pkgs')
    expect(pkgs).toContain('base="$PKGS/acdert/$SDK_VERSION"')
    expect(pkgs).toContain('name="acde-api-$SDK_VERSION.tar.gz"')
    expect(pkgs).toContain('"$base/SHA256SUMS"')
    expect(pkgs).toContain('"$base/$name"')
    expect(pkgs).not.toMatch(/\bnpm\b/)
    expect(indexIn(pkgs, 'sha256sum "in/sdk/$name"')).toBeLessThan(indexIn(pkgs, 'tar -xzf "in/sdk/$name"'))
    expect(indexIn(pkgs, 'tar -xzf "in/sdk/$name"')).toBeLessThan(indexIn(pkgs, 'mv in/sdk/unpacked/package'))
    expect(pkgs).toContain('if [ "$(ls in/sdk/unpacked)" != package ]; then')
    expect(pkgs).toContain('test -f in/sdk/unpacked/package/src/validate.js')
    expect(TEXT).not.toMatch(/acdert\/latest|acde-dopame\/latest|acde-dopame\/\$|acdert-host|acdert-x86/)
    expect(TEXT).not.toMatch(/\bdopame\.tar\.gz\b/)
  })

  test('the SDK is placed where the file: dependency points, and checked before install', () => {
    const steps = jobs['pkgs']!.steps.map((item) => item.name ?? '')
    const placed = steps.indexOf('the SDK tarball from PKGS, checked against its SHA256SUMS')
    const check = steps.indexOf('the placed SDK is the pinned one, at the path package.json names')
    const install = steps.indexOf('install')
    expect(placed).toBeGreaterThanOrEqual(0)
    expect(placed).toBeLessThan(check)
    expect(check).toBeLessThan(install)
    expect(runs('pkgs')).toContain('file:../acdert/web/packages/acde-api')
  })

  test('the lockfile fetches every package from the default registry, not a mirror', () => {
    expect(LOCK).not.toContain('mirrors.cloud.tencent.com')
  })

  test('the package is one archive with no runtime, host or desktop in it', () => {
    expect(runs('pkgs')).toContain('bun scripts/dist.ts --api')
    expect(runs('pkgs')).not.toMatch(/--acdert|--host|--desktop|--triple/)
    expect(runs('upload')).toContain('"out/$v/acde-$v.tar.gz"')
  })

  test('acde.exe is built on Windows x64 from the locked crate, only built, and goes into the archive', () => {
    expect((jobs['exe'] as Job & { 'runs-on'?: string })['runs-on']).toBe('windows-2025')
    expect(runs('exe')).toContain('cargo build --release --locked --target x86_64-pc-windows-msvc')
    expect(runs('exe')).not.toMatch(/cargo (test|clippy)|bun test/)
    expect(runs('pkgs')).toContain('--exe "$GITHUB_WORKSPACE/in/exe/acde.exe"')
    expect(runs('pkgs')).toContain('bin/acde.exe is missing or not a Windows executable')
  })

  test('the version directory names its acdert in acdert-version, checked, listed and uploaded', () => {
    const pairing = 'the version directory names the acdert it pairs with, in its SHA256SUMS'
    const pkgs = runs('pkgs')
    expect(pkgs).toContain('--sdk "$SDK_VERSION"')
    expect(pkgs).toContain('if [ "$(cat "$dir/acdert-version")" != "$SDK_VERSION" ]; then')
    expect(pkgs).toContain(`grep -q '  acdert-version$' "$dir/SHA256SUMS"`)
    const steps = jobs['pkgs']!.steps.map((item) => item.name ?? '')
    expect(steps.indexOf('dist')).toBeLessThan(steps.indexOf(pairing))
    expect(steps.indexOf(pairing)).toBeLessThan(steps.indexOf('latest.json'))
    const upload = runs('upload')
    expect(upload).toContain('echo "$v/acdert-version"')
    const published = '$COS once "out/$v/acdert-version" "$PREFIX/$v/acdert-version"'
    expect(indexIn(upload, published)).toBeLessThan(indexIn(upload, '$COS once "out/$v/SHA256SUMS"'))
  })

  test('the guard runs the release guard on the artifact before any upload or tag', () => {
    expect(runs('guard')).toContain('bun scripts/release-guard.ts --dir "$GITHUB_WORKSPACE/out"')
    expect(uses('guard').some((action) => action.startsWith('christopherhx/gitea-download-artifact@'))).toBe(true)
    expect(jobs['guard']!.permissions).toBeUndefined()
  })

  test('the upload and latest jobs check the allow-list and the checksums before they touch COS', () => {
    for (const job of ['upload', 'latest']) {
      expect(runs(job)).toContain('sha256sum -c SHA256SUMS')
    }
    const upload = runs('upload')
    expect(upload).toContain('echo "$v/acde-$v.tar.gz"')
    expect(indexIn(upload, 'diff "$expected" actual')).toBeLessThan(indexIn(upload, '$COS once'))
    for (const job of ['upload', 'latest']) {
      const steps = jobs[job]!.steps.map((item) => item.name ?? '')
      expect(steps.indexOf('check the allow-list and the checksums once more')).toBeLessThan(
        steps.indexOf('the COS client, with uv when the runner has it, else in a venv'),
      )
    }
  })

  test('upload is an explicit allow-list with no sync, recursion or globs', () => {
    for (const job of ['upload', 'latest']) {
      const run = runs(job)
      expect(run).not.toMatch(/\bsync\b|--recursive|\bcp -r\b/)
      expect(run).not.toMatch(/\$COS [^\n]*\*/)
    }
  })

  test('a published version is identical or refused, never overwritten, and a rerun can continue', () => {
    expect(runs('upload').match(/^\$COS once /gm)).toHaveLength(3)
    expect(COS).toContain('Metadata={"x-cos-meta-sha256": digest}')
    expect(COS).toContain('have = head.get("x-cos-meta-sha256")')
    expect(COS).toContain('already published, identical')
    expect(COS).toContain('a version is never overwritten')
    expect(indexIn(COS, 'if mode == "once":')).toBeLessThan(indexIn(COS, 'client.put_object('))
  })

  test('the COS client writes only under pkgs/, with uv when there is one and else a venv', () => {
    expect(COS).toContain('if prefix.strip("/") != "pkgs":')
    expect(COS).toContain('return f"{prefix.strip(\'/\')}/{key}"')
    expect(COS).toContain('any(part in ("", ".", "..") for part in parts)')
    for (const job of ['upload', 'latest']) {
      const client = step(job, 'the COS client, with uv when the runner has it, else in a venv')?.run ?? ''
      expect(client).toContain('uv run --no-project --with $COS_SDK python acde/scripts/cos.py')
      expect(client).toContain('python3 -m venv "$RUNNER_TEMP/cos"')
    }
  })

  test('the COS secrets reach only the two upload steps, as env, and are never echoed; no set -x', () => {
    const named = [...TEXT.matchAll(/secrets\.\w+/g)].map((m) => m[0])
    const pair = ['secrets.COS_SECRET_ID', 'secrets.COS_SECRET_KEY']
    expect(named).toEqual([...pair, ...pair])
    const holders = Object.entries(jobs).flatMap(([id, job]) =>
      job.steps.filter((item) => item.env?.['COS_SECRET_KEY']).map((item) => `${id}: ${item.name}`))
    expect(holders).toEqual([
      'upload: upload the versioned files, each read back; a published version is never overwritten',
      'latest: update the pointers, latest and latest.json last',
    ])
    expect(TEXT).not.toMatch(/set -x|bash -x|sh -x/)
    expect(TEXT).not.toMatch(/echo[^\n]*COS_SECRET/)
    expect(COS).not.toMatch(/print\([^\n]*(SECRET|secret)/)
  })

  test('nothing of AWS or CloudFront is left', () => {
    expect(TEXT).not.toMatch(/\baws\b|AWS_|cloudfront|CLOUDFRONT|amazonaws|pkgs\.dopame\.ai/i)
  })

  test('every action is pinned to a full commit SHA with its version noted', () => {
    const all = Object.keys(jobs).flatMap((job) => uses(job))
    expect(all.length).toBeGreaterThan(0)
    for (const action of all) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    expect(TEXT.match(/@[0-9a-f]{40} # v\d+/g)?.length).toBe(all.length)
  })

  test('the bucket, region, prefixes, SDK and PKGS are each stated once; PKGS is the address acde uses', () => {
    expect(workflow.env).toEqual({
      PKGS: Pkgs.BASE,
      COS_BUCKET: 'calbin-1318886512',
      COS_REGION: 'ap-beijing',
      COS_PREFIX: 'pkgs',
      COS_SDK: 'cos-python-sdk-v5==1.9.45',
      PREFIX: 'acde',
    })
    expect(Pkgs.BASE).toBe(`https://${workflow.env['COS_BUCKET']}.cos.${workflow.env['COS_REGION']}.myqcloud.com/pkgs`)
    expect(runs('pkgs')).toContain('--arg base "$PKGS/$PREFIX/$v/"')
    for (const line of ['curl -fsSL $PKGS/$PREFIX/install.sh | sh', 'irm $PKGS/$PREFIX/install.ps1 | iex']) {
      expect(runs('latest')).toContain(line)
    }
  })
})
