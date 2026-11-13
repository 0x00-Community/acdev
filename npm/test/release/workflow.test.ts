import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pkgs } from '../../src/pkgs.ts'

const TEXT = readFileSync(join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
const CREDENTIALS = 'credentials for the role, from the Gitea key or the GitHub OIDC token'
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
  test('is started by hand only, with publish (boolean, default false) and string inputs for the commits and targets', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs)).toEqual(['publish', 'commit', 'acdert_commit', 'skip_targets'])
    for (const name of ['acdert_commit', 'skip_targets']) {
      expect(inputs[name]).toEqual({ description: expect.any(String), required: false, default: '', type: 'string' })
    }
    expect(inputs['publish']).toEqual({
      description: expect.any(String), required: false, default: false, type: 'boolean',
    })
    expect(inputs['commit']).toEqual({ description: expect.any(String), required: false, default: '', type: 'string' })
    expect(TEXT).not.toMatch(/^\s*push:/m)
    expect(TEXT).not.toMatch(/tags: \['v\*'\]/)
    expect(TEXT).not.toMatch(/^\s*version:\s*$/m)
  })

  test('read-only by default; contents write only on tag; id-token write only on upload and latest', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const writers = Object.entries(jobs).filter(([, job]) => Object.values(job.permissions ?? {}).includes('write'))
    expect(writers.map(([id, job]) => [id, job.permissions])).toEqual([
      ['upload', { contents: 'read', 'id-token': 'write' }],
      ['tag', { contents: 'write' }],
      ['latest', { contents: 'read', 'id-token': 'write' }],
    ])
  })

  test('concurrent releases queue and are never cancelled midway', () => {
    expect(workflow.concurrency).toEqual({ group: 'acde-release', 'cancel-in-progress': false })
  })

  test('the jobs run plan, build, host, pkgs, guard, upload, tag, latest, with their needs', () => {
    expect(Object.keys(jobs)).toEqual(['plan', 'build', 'host', 'pkgs', 'guard', 'upload', 'tag', 'latest'])
    expect(needs('plan')).toEqual([])
    expect(needs('build')).toEqual(['plan'])
    expect(needs('host')).toEqual(['plan'])
    expect(needs('pkgs')).toEqual(['plan', 'build', 'host'])
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
    const archive = indexIn(upload, 'publish_once "out/$v/acde-$v.tar.gz"')
    expect(archive).toBeLessThan(indexIn(upload, 'publish_once "out/$v/SHA256SUMS"'))
    expect(upload).toContain('aws s3 cp "s3://$BUCKET/$key" readback.tmp')
    expect(upload).toContain('does not read back as uploaded')
    expect(upload).not.toMatch(/put out\/(latest|install)/)
    expect(runs('tag')).toContain('git push origin "refs/tags/$TAG"')
    expect(needs('tag')).toContain('upload')
    const latest = runs('latest')
    const order = [
      'put out/install.sh', 'put out/install.ps1', 'put out/install.md', 'put out/latest latest', 'put out/latest.json',
    ]
    const at = order.map((needle) => indexIn(latest, needle))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
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
      acdert_sha: '${{ steps.acdert.outputs.sha }}',
      targets: '${{ steps.targets.outputs.targets }}',
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
    for (const job of ['pkgs', 'guard', 'upload', 'tag', 'latest']) {
      if (job === 'upload' || job === 'latest') continue
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

  test('one version: Cargo.toml, npm/package.json and the SDK of the acdert commit built with', () => {
    const plan = runs('plan')
    expect(plan).toContain('Cargo.toml says $crate, npm/package.json says $v: bump both together')
    expect(plan).toContain('"$sha:web/packages/acde-api/package.json"')
    expect(plan).toContain('this release is $VERSION: bump them together')
    expect(plan).toContain('git -C "$lib" merge-base --is-ancestor "$sha" origin/main || { echo "::error::acdert $sha is not on its main"')
    expect(jobs['pkgs']!.env?.['SDK_VERSION']).toBe('${{ needs.plan.outputs.version }}')
    const pkgs = runs('pkgs')
    expect(indexIn(pkgs, 'bun run --cwd acdert/web/packages/acde-api build')).toBeLessThan(indexIn(pkgs, 'bun scripts/dist.ts'))
    expect(pkgs).toContain('--api "$GITHUB_WORKSPACE/acdert/web/packages/acde-api/dist" --sdk "$SDK_VERSION"')
    expect(pkgs).not.toMatch(/\bnpm\b/)
    expect(TEXT).not.toMatch(/acdert-version|acdert-host|acdert-x86|pkgs\.dopame\.ai\/acdert/)
  })

  test('the builds and the host files come from this run, built from the planned commits', () => {
    const build = runs('build')
    expect(build).toContain('checkout --detach "$ACDERT_SHA"')
    expect(build).toContain('git -C acdert submodule update --init --depth 1')
    expect(build).toContain('cargo build --profile dist -p acdebin-dbg --target ${{ matrix.triple }}')
    expect(build).toContain('"out/acdebin-dbg-${{ matrix.triple }}.tar.xz"')
    expect(build).toContain('"out/acdebin-dbg-${{ matrix.triple }}.tar.gz"')
    expect(runs('host')).toContain('tar -C stage -czf "out/acde-host-$VERSION.tar.gz" app LICENSE')
    const pkgs = runs('pkgs')
    expect(pkgs).toContain('--runtime "$GITHUB_WORKSPACE/in/runtime"')
    expect(pkgs).toContain('cp "in/runtime-$t/$f" in/runtime/')
  })

  test('the lockfile fetches every package from the default registry, not a mirror', () => {
    expect(LOCK).not.toContain('mirrors.cloud.tencent.com')
  })

  test('the CLI archive is built by dist.ts, the runtime files beside it, no desktop', () => {
    expect(runs('pkgs')).toContain('bun scripts/dist.ts --api')
    expect(runs('pkgs')).not.toMatch(/--desktop|--triple/)
    expect(runs('upload')).toContain('"out/$v/acde-$v.tar.gz"')
  })

  test('Linux jobs run on debian12, inside node:22-bookworm (the builds run on each target\'s own runner)', () => {
    for (const [id, job] of Object.entries(jobs)) {
      if (id === 'build') continue
      expect((job as Job & { 'runs-on'?: string })['runs-on']).toBe('debian12')
      expect((job as Job & { container?: string }).container).toBe('node:22-bookworm')
    }
  })

  test('the version directory holds the CLI, the SDK, the host files and the builds; listed, uploaded and invalidated', () => {
    const upload = runs('upload')
    for (const file of ['acde-$v.tar.gz', 'acde-api-$v.tar.gz', 'acde-host-$v.tar.gz', 'acdebin-dbg-$t.tar.gz', 'acdebin-dbg-$t.tar.xz']) {
      expect(upload).toContain(`echo "$v/${file}"`)
      expect(indexIn(upload, `publish_once "out/$v/${file}"`)).toBeLessThan(indexIn(upload, 'publish_once "out/$v/SHA256SUMS"'))
    }
    expect(runs('latest')).toContain('"/acde/$v/*"')
    expect(runs('guard')).toContain('--targets "$TARGETS"')
  })

  test('the guard runs the release guard on the artifact before any upload or tag', () => {
    expect(runs('guard')).toContain('bun ../scripts/release-guard.ts --dir "$GITHUB_WORKSPACE/out"')
    expect(uses('guard').some((action) => action.startsWith('christopherhx/gitea-download-artifact@'))).toBe(true)
    expect(jobs['guard']!.permissions).toBeUndefined()
  })

  test('the upload and latest jobs check the allow-list and the checksums before they touch S3', () => {
    for (const job of ['upload', 'latest']) {
      expect(runs(job)).toContain('sha256sum -c SHA256SUMS')
    }
    const upload = runs('upload')
    expect(upload).toContain('echo "$v/acde-$v.tar.gz"')
    expect(indexIn(upload, 'diff "$expected" actual')).toBeLessThan(indexIn(upload, 'publish_once()'))
    const steps = jobs['upload']!.steps.map((item) => item.name ?? '')
    expect(steps.indexOf('check the allow-list and the checksums once more')).toBeLessThan(
      steps.indexOf(CREDENTIALS),
    )
  })

  test('upload is an explicit allow-list with no sync, recursion or globs', () => {
    for (const job of ['upload', 'latest']) {
      const run = runs(job)
      expect(run).not.toMatch(/\bsync\b|--recursive|\bcp -r\b/)
      expect(run).not.toMatch(/s3 cp [^\n]*out\/[^\n]*\*/)
    }
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
    const secrets: string[] = [...(TEXT.match(/\$\{\{ secrets\.\w+ \}\}/g) ?? [])]
    expect(secrets).toEqual(Array(2).fill(['${{ secrets.AWS_ACCESS_KEY_ID }}', '${{ secrets.AWS_SECRET_ACCESS_KEY }}']).flat())
    for (const job of ['upload', 'latest']) {
      const step = jobs[job]!.steps.find((item) => item.name === CREDENTIALS)
      expect(step?.env).toEqual({ KEY_ID: '${{ secrets.AWS_ACCESS_KEY_ID }}', KEY_SECRET: '${{ secrets.AWS_SECRET_ACCESS_KEY }}' })
    }
    expect(TEXT).not.toMatch(/set -x|bash -x|sh -x/)
    expect(TEXT.indexOf('::add-mask::$token')).toBeLessThan(TEXT.indexOf('assume-role-with-web-identity'))
    expect(TEXT.indexOf('::add-mask::$secret')).toBeLessThan(TEXT.indexOf('AWS_SECRET_ACCESS_KEY=$secret'))
    const printed = TEXT.split('\n').filter((line) => !/add-mask|AWS_/.test(line) && /echo/.test(line))
    expect(printed.filter((line) => /\$(token|secret|session|creds)\b/.test(line))).toEqual([])
  })

  test('the role is assumed with the AWS CLI, from the Gitea key or the GitHub OIDC token, not a third-party action', () => {
    expect(TEXT).not.toContain('aws-actions/')
    for (const job of ['upload', 'latest']) {
      expect(runs(job)).toContain('aws sts assume-role --role-arn "$ROLE"')
      expect(runs(job)).toContain('aws sts assume-role-with-web-identity')
    }
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
    expect(Pkgs.BASE).toBe(workflow.env['PKGS']!)
  })
})
