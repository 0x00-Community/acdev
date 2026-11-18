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
  on: { push: { tags: string[] }; workflow_dispatch: { inputs: Record<string, Input> } }
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
const checkoutOf = (job: string) => jobs[job]!.steps.find((item) => /(^|\/)checkout@/.test(item.uses ?? ''))
const indexIn = (text: string, needle: string) => {
  const at = text.indexOf(needle)
  expect(at).toBeGreaterThanOrEqual(0)
  return at
}

describe('release.yml', () => {
  test('is started by hand, with publish (boolean, default false) and string inputs, or by pushing a tag v*', () => {
    expect(Object.keys(workflow.on)).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ tags: ['v*'] })
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs)).toEqual(['publish', 'commit', 'version', 'skip_targets'])
    for (const name of ['commit', 'version', 'skip_targets']) {
      expect(inputs[name]).toEqual({ description: expect.any(String), required: false, default: '', type: 'string' })
    }
    expect(inputs['publish']).toEqual({
      description: expect.any(String), required: false, default: false, type: 'boolean',
    })
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
    expect(workflow.concurrency).toEqual({ group: 'acdev-release', 'cancel-in-progress': false })
  })

  test('the jobs run plan, build, tools, pkgs, guard, upload, npm, tag, latest, with their needs', () => {
    expect(Object.keys(jobs)).toEqual(['plan', 'build', 'tools', 'pkgs', 'guard', 'upload', 'npm', 'tag', 'latest'])
    expect(needs('npm')).toEqual(['plan', 'guard'])
    expect(jobs['npm']!.if).toBe("needs.plan.outputs.publish == 'true'")
    expect(needs('plan')).toEqual([])
    expect(needs('build')).toEqual(['plan'])
    expect(needs('tools')).toEqual(['plan'])
    expect(needs('pkgs')).toEqual(['plan', 'build', 'tools'])
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
    const archive = indexIn(upload, 'publish_once "out/$v/acdev-$v.tar.gz"')
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
      libacde: '${{ steps.libacde.outputs.sha }}',
      version: '${{ steps.version.outputs.version }}',
      tag: '${{ steps.version.outputs.tag }}',
      targets: '${{ steps.targets.outputs.targets }}',
    })
  })

  test('a publish by hand runs only on main; the version is the pushed tag, the input, or one past the highest', () => {
    const plan = runs('plan')
    expect(plan).toContain('[ "$PUBLISH" = true ] && [ -z "$PUSHED_TAG" ] && [ "$GITHUB_REF" != refs/heads/main ]')
    expect(plan).toContain('push:refs/tags/v*) PUBLISH=true; COMMIT=$GITHUB_SHA; PUSHED_TAG=')
    expect(plan).toContain('GITHUB_REF#refs/tags/')
    const checkout = indexIn(plan, 'git checkout --quiet --detach "$sha"')
    expect(checkout).toBeLessThan(indexIn(plan, 'PUSHED_TAG#v'))
    expect(indexIn(plan, 'PUSHED_TAG#v')).toBeLessThan(indexIn(plan, 'VERSION_INPUT#v'))
    expect(plan).toContain('npm view "$pkg" versions --json')
    expect(plan).toContain("git tag --list 'v*'")
    expect(plan).toContain('$3 + 1')
    expect(plan).toContain('[0-9]*.[0-9]*.[0-9]*')
    for (const job of ['build', 'pkgs']) expect(runs(job)).toContain('sh acdev/scripts/set-version.sh')
    expect(TEXT).not.toMatch(/github\.ref_name|format\('v\{0\}'/)
  })

  test('the plan checkout fetches history; every later job checks out the resolved commit', () => {
    const planCheckout = checkoutOf('plan')
    expect(planCheckout?.with?.['fetch-depth']).toBe(0)
    expect(planCheckout?.with?.['ref']).toBeUndefined()
    for (const job of ['build', 'tools', 'pkgs', 'guard', 'tag']) {
      expect(checkoutOf(job)?.with?.['ref']).toBe(jobs['tag']!.env?.['SHA'])
    }
  })

  test('the tag is free, or already points at the same commit; a different commit fails', () => {
    const check = step('plan', 'the tag is free, or already points at this commit')
    expect(check?.if).toBe("steps.version.outputs.publish == 'true'")
    expect(check?.run).toContain('git rev-parse --verify --quiet "refs/tags/$TAG^{commit}"')
    expect(TEXT).not.toContain('gh api')
    expect(check?.run).toContain('[ "$tagged" != "$SHA" ]')
    expect(check?.run).toContain('already exists and points at $tagged, not at $SHA')
  })

  test('the tag job creates an annotated tag on the resolved commit, never moves or forces one', () => {
    const tag = jobs['tag']!
    expect(tag.env?.['SHA']).toBe('${{ needs.plan.outputs.sha }}')
    expect(checkoutOf('tag')?.with?.['persist-credentials']).toBe(true)
    const run = runs('tag')
    expect(run).toContain('test "$(git rev-parse HEAD)" = "$SHA"')
    expect(run).toContain('git ls-remote --exit-code --tags origin "refs/tags/$TAG"')
    expect(run).toContain('tag -a "$TAG" -m "acdev $TAG" "$SHA"')
    expect(run).toContain('git push origin "refs/tags/$TAG"')
    expect(run).toContain('bump the version in package.json')
    expect(run).toContain('a rerun continues')
    expect(run).not.toMatch(/git tag (?!-a)/)
    expect(run).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+refs)/)
  })

  test('the checkout in every job other than tag keeps no token', () => {
    for (const job of Object.keys(jobs).filter((id) => id !== 'tag')) {
      for (const item of jobs[job]!.steps) {
        if (/(^|\/)checkout@/.test(item.uses ?? '')) expect(item.with?.['persist-credentials']).toBe(false)
      }
    }
  })

  test('one version: set into Cargo.toml, npm/package.json and the SDK in libacde/acde-api', () => {
    expect(TEXT).not.toMatch(/AC\/acdert\.git|acdert_commit|acdert_sha|acdert\/web/)
    expect(jobs['pkgs']!.env?.['SDK_VERSION']).toBe('${{ needs.plan.outputs.version }}')
    const pkgs = runs('pkgs')
    const set = indexIn(pkgs, 'sh acdev/scripts/set-version.sh "$SDK_VERSION" acdev')
    expect(set).toBeLessThan(indexIn(pkgs, 'bun scripts/dist.ts'))
    expect(pkgs).toContain('--api "$GITHUB_WORKSPACE/libacde/acde-api" --sdk "$SDK_VERSION"')
    expect(pkgs).not.toMatch(/\bnpm (?:publish|install|view)\b/)
    expect(TEXT).not.toMatch(/acdert-version|acdert-host|acdert-x86|pkgs\.dopame\.ai\/acdert|acde-host/)
  })

  test('the builds, the guest daemons and the host tools come from this run, built from the planned commit', () => {
    const build = runs('build')
    expect(jobs['build']!.steps.some((item) => item.uses === './acdev/.github/actions/libacde')).toBe(true)
    const triple = ['$', '{{ matrix.triple }}'].join('')
    expect(build).toContain(`cargo build --profile dist -p acdev --target ${triple}`)
    expect(build).toContain(`"out/acdev-runtime-${triple}.tar.xz"`)
    expect(build).toContain(`"out/acdev-runtime-${triple}.tar.gz"`)
    const tools = jobs['tools'] as Job & { strategy: { matrix: { include: Record<string, string>[] } } }
    expect(tools.strategy.matrix.include.map((tool) => [tool['name'], tool['triple']])).toEqual([
      ['acdevd-x86_64', 'x86_64-unknown-linux-musl'], ['acdevd-aarch64', 'aarch64-unknown-linux-musl'],
      ['acdev-relay', 'x86_64-pc-windows-msvc'], ['acdev-viewer', 'x86_64-unknown-linux-gnu'],
    ])
    expect(runs('tools')).toContain('cargo build --release --target')
    const pkgs = runs('pkgs')
    expect(pkgs).toContain('--runtime "$GITHUB_WORKSPACE/in/runtime"')
    expect(pkgs).toContain('cp "in/runtime-$t/$f" in/runtime/')
    expect(pkgs).toContain('pack "acdev-guest-$v.tar.gz" in/tool-acdevd-x86_64/acdevd-x86_64 in/tool-acdevd-aarch64/acdevd-aarch64')
    expect(jobs['pkgs']!.steps.filter((item) => item.uses?.includes('/gitea-download-artifact@')).map((item) => item.with?.['pattern']))
      .toEqual(['runtime-*', 'tool-*'])
  })

  test('build has bun 1.4.4 and libacde/js installed before cargo: build.rs bundles libacde/js', () => {
    const items = jobs['build']!.steps
    const bun = items.findIndex((item) => item.uses?.includes('/setup-bun@'))
    const cargo = items.findIndex((item) => (item.run ?? '').includes('cargo build --profile dist'))
    expect(bun).toBeGreaterThanOrEqual(0)
    expect(bun).toBeLessThan(cargo)
    expect(items[bun]!.with?.['bun-version']).toBe('1.4.4')
    expect(runs('build')).toContain('bun install --frozen-lockfile --cwd libacde/js')
    expect(runs('build')).toContain('echo "ACDEV_BUN=$(command -v bun)" >> "$GITHUB_ENV"')
  })

  test('npm publishes the platform packages and @dopame/acdev, not the private SDK', () => {
    const npm = runs('npm')
    expect(npm).toContain('for dir in npm/acdev-*-* npm/acdev; do')
    expect(npm).not.toMatch(/acdev-api|acde-api-\*/)
  })

  test('the lockfile fetches every package from the default registry, not a mirror', () => {
    expect(LOCK).not.toContain('mirrors.cloud.tencent.com')
  })

  test('the CLI archive is built by dist.ts, the runtime files beside it, no desktop', () => {
    expect(runs('pkgs')).toContain('bun scripts/dist.ts --api')
    expect(runs('pkgs')).not.toMatch(/--desktop|--triple/)
    expect(runs('upload')).toContain('"out/$v/acdev-$v.tar.gz"')
  })

  test('every job runs on the x86_64-debian runners themselves, in no container', () => {
    for (const [id, job] of Object.entries(jobs)) {
      expect((job as Job & { 'runs-on'?: string })['runs-on']).toBe('x86_64-debian')
      expect((job as Job & { container?: string }).container).toBeUndefined()
    }
  })

  test('the version directory holds the CLI, the SDK, the builds, the guest daemons and the host tools; listed, uploaded and invalidated', () => {
    const upload = runs('upload')
    const files = ['acdev-$v.tar.gz', 'acde-api-$v.tar.gz', 'acdev-guest-$v.tar.gz', 'acdev-runtime-$t.tar.gz', 'acdev-runtime-$t.tar.xz',
      'acdev-tools-$t.tar.gz', 'acdev-tools-$t.tar.xz']
    for (const file of files) {
      expect(upload).toContain(`echo "$v/${file}"`)
      expect(indexIn(upload, `publish_once "out/$v/${file}"`)).toBeLessThan(indexIn(upload, 'publish_once "out/$v/SHA256SUMS"'))
    }
    expect(runs('latest')).toContain('"/acde/$v/*"')
    expect(runs('guard')).toContain('--targets "$TARGETS"')
  })

  test('the guard runs the release guard on the artifact before any upload or tag', () => {
    expect(runs('guard')).toContain('bun ../scripts/release-guard.ts --dir "$GITHUB_WORKSPACE/out"')
    expect(uses('guard').some((action) => action.includes('/gitea-download-artifact@'))).toBe(true)
    expect(jobs['guard']!.permissions).toBeUndefined()
  })

  test('the upload and latest jobs check the allow-list and the checksums before they touch S3', () => {
    for (const job of ['upload', 'latest']) {
      expect(runs(job)).toContain('sha256sum -c SHA256SUMS')
    }
    const upload = runs('upload')
    expect(upload).toContain('echo "$v/acdev-$v.tar.gz"')
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
    const secrets = [...TEXT.matchAll(/\bsecrets\.(\w+)/g)].map((match) => match[1])
    expect([...new Set(secrets)].sort())
      .toEqual(['ACKERNEL_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN'])
    expect(secrets.filter((name) => name!.startsWith('AWS_'))).toEqual(
      Array(2).fill(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']).flat())
    expect(jobs['npm']!.env?.['NPM_TOKEN']).toContain('secrets.NPM_TOKEN')
    expect(secrets.filter((name) => name === 'NPM_TOKEN')).toHaveLength(1)
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
    const all = Object.keys(jobs).flatMap((job) => uses(job)).filter((action) => action !== './acdev/.github/actions/libacde')
    expect(all.length).toBeGreaterThan(0)
    for (const action of all) expect(action).toMatch(/^http:\/\/gitea\.dopamine\/mirror\/[\w.-]+@[0-9a-f]{40}$/)
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
