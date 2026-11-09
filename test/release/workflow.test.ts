import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TEXT = readFileSync(join(import.meta.dir, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
const LOCK = readFileSync(join(import.meta.dir, '..', '..', 'bun.lock'), 'utf8')
type Step = {
  name?: string; id?: string; if?: string; uses?: string; run?: string
  with?: Record<string, unknown>; env?: Record<string, string>
}
type Job = {
  needs?: string | string[]; if?: string; permissions?: Record<string, string>; env?: Record<string, string>
  outputs?: Record<string, string>; steps: Step[]
}
type Input = { required: boolean; default: boolean; type: string }
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
  test('is started by hand only, with a boolean publish input that defaults to false and no version input', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs)).toEqual(['publish'])
    expect(inputs['publish']).toEqual({
      description: expect.any(String),
      required: false,
      default: false,
      type: 'boolean',
    })
    expect(TEXT).not.toMatch(/^\s*push:/m)
    expect(TEXT).not.toMatch(/tags: \['v\*'\]/)
  })

  test('default permissions are read-only; contents write only on tag; id-token write only on upload', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const writers = Object.entries(jobs).filter(([, job]) => Object.values(job.permissions ?? {}).includes('write'))
    expect(writers.map(([id, job]) => [id, job.permissions])).toEqual([
      ['tag', { contents: 'write' }],
      ['upload', { contents: 'read', 'id-token': 'write' }],
    ])
  })

  test('concurrent releases queue and are never cancelled midway', () => {
    expect(workflow.concurrency).toEqual({ group: 'acde-release', 'cancel-in-progress': false })
  })

  test('the jobs run plan, pkgs, guard, tag, upload in that order', () => {
    expect(Object.keys(jobs)).toEqual(['plan', 'pkgs', 'guard', 'tag', 'upload'])
    expect(needs('plan')).toEqual([])
    expect(needs('pkgs')).toEqual(['plan'])
    expect(needs('guard')).toEqual(['plan', 'pkgs'])
    expect(needs('tag')).toEqual(['plan', 'guard'])
    expect(needs('upload')).toEqual(['plan', 'guard', 'tag'])
  })

  test('tag and upload need publish=true and every job they wait for to succeed', () => {
    for (const job of ['tag', 'upload']) {
      expect(jobs[job]!.if).toContain('inputs.publish')
      expect(jobs[job]!.if).toContain('success()')
    }
    expect(jobs['pkgs']!.if).toBeUndefined()
    expect(jobs['guard']!.if).toBeUndefined()
  })

  test('a preview (publish=false) says so and stops after the guard', () => {
    expect(step('guard', 'a preview stops here')?.if).toBe('${{ !inputs.publish }}')
    expect(TEXT).not.toMatch(/gh workflow run[^\n]*publish=true[^\n]*tags?/)
  })

  test('the version comes from package.json, and a publish runs only on main', () => {
    const plan = runs('plan')
    expect(plan).toContain('require("./package.json").version')
    expect(plan).toContain('case $v in')
    expect(plan).toContain('[0-9]*.[0-9]*.[0-9]*')
    expect(plan).toContain('"$PUBLISH" = true ] && [ "$GITHUB_REF" != refs/heads/main ]')
    expect(plan).toContain('echo "tag=v$v" >> "$GITHUB_OUTPUT"')
    expect(jobs['plan']!.outputs).toEqual({
      version: '${{ steps.version.outputs.version }}',
      tag: '${{ steps.version.outputs.tag }}',
    })
    expect(TEXT).not.toMatch(/github\.ref_name|format\('v\{0\}'/)
  })

  test('the tag must be free or already point at this commit, using the GitHub API', () => {
    const check = step('plan', 'the tag is free, or already points at this commit')
    expect(check?.if).toBe('${{ inputs.publish }}')
    expect(check?.run).toContain('gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG"')
    expect(check?.run).toContain('[ "$sha" != "$GITHUB_SHA" ]')
    expect(check?.run).toContain('HTTP 404')
    expect(check?.run).toContain('bump the version in package.json')
  })

  test('the tag job creates an annotated tag on this commit, never moves or forces one', () => {
    const tag = jobs['tag']!
    expect(tag.env?.['TAG']).toBe('${{ needs.plan.outputs.tag }}')
    const checkout = tag.steps.find((item) => item.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['persist-credentials']).toBe(true)
    expect(checkout?.with?.['ref']).toBe('${{ github.sha }}')
    const run = runs('tag')
    expect(run).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"')
    expect(run).toContain('git ls-remote --exit-code --tags origin "refs/tags/$TAG"')
    expect(run).toContain('tag -a "$TAG" -m "acde $TAG" "$GITHUB_SHA"')
    expect(run).toContain('git push origin "refs/tags/$TAG"')
    expect(run).not.toMatch(/git tag (?!-a)/)
    expect(run).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+refs)/)
    expect(run).toContain('a rerun continues')
  })

  test('the upload job uses the tag from plan and never checks out a token-bearing repository', () => {
    expect(jobs['upload']!.env?.['TAG']).toBe('${{ needs.plan.outputs.tag }}')
    for (const job of Object.keys(jobs).filter((id) => id !== 'tag')) {
      for (const item of jobs[job]!.steps) {
        if (item.uses?.startsWith('actions/checkout@')) expect(item.with?.['persist-credentials']).toBe(false)
      }
    }
  })

  test('the SDK is the version of the release, fetched from pkgs.dopame.ai and checked before it is unpacked', () => {
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
    const placed = steps.indexOf('the SDK tarball from pkgs.dopame.ai, checked against its SHA256SUMS')
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

  test('the guard runs the release guard on the artifact before the tag or any upload', () => {
    expect(runs('guard')).toContain('bun scripts/release-guard.ts --dir "$GITHUB_WORKSPACE/out"')
    expect(uses('guard').some((action) => action.startsWith('actions/download-artifact@'))).toBe(true)
    expect(jobs['guard']!.permissions).toBeUndefined()
  })

  test('the upload job checks the allow-list and the checksums again before it uploads anything', () => {
    const upload = runs('upload')
    expect(indexIn(upload, 'diff "$expected" actual')).toBeLessThan(indexIn(upload, 'sha256sum -c SHA256SUMS'))
    expect(indexIn(upload, 'sha256sum -c SHA256SUMS')).toBeLessThan(indexIn(upload, 'publish_once()'))
    const steps = jobs['upload']!.steps.map((item) => item.name ?? '')
    expect(steps.indexOf('check the allow-list and the checksums once more')).toBeLessThan(
      steps.indexOf('credentials from the GitHub OIDC token'),
    )
  })

  test('upload is an explicit allow-list with no sync, recursion or globs', () => {
    const upload = runs('upload')
    expect(upload).not.toMatch(/\bsync\b|--recursive|\bcp -r\b/)
    expect(upload).not.toMatch(/s3 cp [^\n]*out\/[^\n]*\*/)
    expect(upload).toContain('publish_once "out/$v/acde-$v.tar.gz" "$v/acde-$v.tar.gz"')
    expect(upload).toContain('publish_once "out/$v/SHA256SUMS" "$v/SHA256SUMS"')
    expect(upload).toContain('put out/install.sh install.sh')
    expect(upload).toContain('put out/install.ps1 install.ps1')
    expect(upload).toContain('put out/latest latest')
    expect(upload).toContain('put out/latest.json latest.json')
  })

  test('latest.json is the last object uploaded, after the archive, the checksums and the installers', () => {
    const upload = runs('upload')
    const order = [
      'publish_once "out/$v/acde-',
      'publish_once "out/$v/SHA256SUMS"',
      'put out/install.sh',
      'put out/install.ps1',
      'put out/latest latest',
      'put out/latest.json',
    ]
    const at = order.map((needle) => indexIn(upload, needle))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('a published version is identical or refused, never overwritten, and a rerun can continue', () => {
    const upload = runs('upload')
    expect(upload).toContain('aws s3api head-object')
    expect(upload).toContain('cmp -s published.tmp "$1"')
    expect(upload).toContain('already published, identical')
    expect(upload).toContain('a version is never overwritten')
    expect(upload).not.toMatch(/already published: a version/)
  })

  test('credentials are masked before they are used, never echoed, and set -x is never used', () => {
    expect(TEXT).not.toContain('secrets.')
    expect(TEXT).not.toMatch(/set -x|bash -x|sh -x/)
    expect(TEXT.indexOf('::add-mask::$token')).toBeLessThan(TEXT.indexOf('assume-role-with-web-identity'))
    expect(TEXT.indexOf('::add-mask::$secret')).toBeLessThan(TEXT.indexOf('AWS_SECRET_ACCESS_KEY=$secret'))
    const printed = TEXT.split('\n').filter((line) => !/add-mask|AWS_/.test(line) && /echo/.test(line))
    expect(printed.filter((line) => /\$(token|secret|session|creds)\b/.test(line))).toEqual([])
  })

  test('the OIDC exchange is done with the AWS CLI, not a third-party action', () => {
    expect(TEXT).not.toContain('aws-actions/')
    expect(runs('upload')).toContain('aws sts assume-role-with-web-identity')
  })

  test('every action is pinned to a full commit SHA with its version noted', () => {
    const all = Object.keys(jobs).flatMap((job) => uses(job))
    expect(all.length).toBeGreaterThan(0)
    for (const action of all) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    expect(TEXT.match(/@[0-9a-f]{40} # v\d+/g)?.length).toBe(all.length)
  })

  test('the release role, bucket, prefix, region, distribution and PKGS are each stated once', () => {
    expect(workflow.env['ROLE']).toBe('arn:aws:iam::312030312811:role/dopame-acde-release')
    expect(workflow.env['AWS_REGION']).toBe('ap-southeast-1')
    expect(workflow.env['CLOUDFRONT_DISTRIBUTION']).toBe('E3ET3L14ALFOXX')
    expect(workflow.env['BUCKET']).toBe('dopame-pkgs')
    expect(workflow.env['PREFIX']).toBe('acde')
    expect(workflow.env['PKGS']).toBe('https://pkgs.dopame.ai')
  })
})
